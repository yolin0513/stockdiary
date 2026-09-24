// 產生 data/calendar.json（當年開休市日）。
//
// 來源：openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule
//   —— 這支沒有 CORS 標頭，瀏覽器直打不到，所以由開發者在本機跑、把結果 commit 進 repo。
//
// 那張表混了兩種東西，不能一律當成休市：
//   休市：「依規定放假1日」「市場無交易，僅辦理結算交割作業」等
//   交易日：「國曆新年開始交易日」「農曆春節前最後交易日」「農曆春節後開始交易日」
//           —— 這三種是說明性質的標記，那幾天照常交易
// 判斷規則寫在 isTradingMarker()，並由 scripts/datatest.mjs 用固定樣本測。
//
// 用法：node scripts/build-calendar.mjs [--year 2027] [--from <本機 JSON 檔>]
//
// **產出是併入，不是覆蓋。** calendar.json 存的是多個年份：
//   { years: { "2026": {...}, "2027": {...} }, generatedAt, source }
// 跑 --year 2027 只會補上 2027，2026 原封不動 —— 覆蓋的話，一跑就把還在用的
// 今年份日曆洗掉，而且要到跨年那天才會有人發現。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rocCompactToISO } from '../js/roc.js';
import { guard, shrinkProblem, readPrevious, writeAtomic, reportAndExit } from './buildguard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';

/**
 * 這筆公告代表的是「照常交易」而不是休市嗎？
 * 只看名稱裡的動詞：開始交易 / 最後交易 / 補行交易。
 */
export function isTradingMarker(entry) {
  const name = String(entry?.Name ?? '');
  return /開始交易|最後交易|補行交易/.test(name);
}

/**
 * 把 holidaySchedule 轉成 { closed, tradingMarkers }。
 * closed 只含「休市」那些日子（含週末的那幾筆，之後產交易日時本來就會被週末規則排掉）。
 */
export function classifyHolidaySchedule(list) {
  const closed = [];
  const tradingMarkers = [];
  const bad = [];
  for (const e of Array.isArray(list) ? list : []) {
    const date = rocCompactToISO(e?.Date);
    if (!date) { bad.push(e); continue; }
    const rec = { date, name: String(e?.Name ?? '').trim() };
    if (isTradingMarker(e)) tradingMarkers.push(rec);
    else closed.push(rec);
  }
  return { closed, tradingMarkers, bad };
}

/** 由「休市清單 + 週末規則 + 照常交易標記」算出整年的交易日。 */
export function tradingDaysOfYear(year, closed, tradingMarkers = []) {
  const closedSet = new Set(closed.map((c) => c.date));
  const forceTrade = new Set(tradingMarkers.map((c) => c.date));
  const out = [];
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay(); // 0=日 6=六
    const weekend = dow === 0 || dow === 6;
    // 補行交易日（週六開市）在 2026 年沒有，但歷史上出現過，規則先留著。
    if (forceTrade.has(iso) || (!weekend && !closedSet.has(iso))) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const yearArg = args.includes('--year') ? Number(args[args.indexOf('--year') + 1]) : new Date().getFullYear();
  const fromArg = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;

  // ---- 寫檔前關卡（scripts/buildguard.mjs）：有任何一項不過，就一個檔都不寫 ----
  // 每一條問題都以單位開頭（F8：停下的理由要點名是哪個單位、哪一種狀況）；讀取、解析失敗也收進來，不直接拋出去。
  const U = '休市日公告（holidaySchedule）';
  const g = guard('build-calendar');
  let list;
  let text = null;
  if (fromArg) {
    try { text = fs.readFileSync(fromArg, 'utf8'); } catch (e) { g.add(`${U}：取不到（${e.code ?? e.message}：${fromArg}）`); }
  } else {
    console.log(`抓 ${SOURCE}`);
    try {
      const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
      if (res.ok) text = await res.text();
      else g.add(`${U}：取不到（HTTP ${res.status}）`);
    } catch (e) { g.add(`${U}：取不到（${e.message}）`); }
  }
  if (text != null) {
    try { list = JSON.parse(text); } catch (e) { g.add(`${U}：解析不了（${e.message}）`); }
  }
  if (list !== undefined) console.log(`收到 ${Array.isArray(list) ? list.length : '不是陣列的'} 筆公告`);
  // 以前：空陣列、欄位改名、不是陣列都只會報「公告裡沒有這一年」（講不出真正的原因）；
  // 只給 27 筆裡的 1 筆，照樣寫出一份「平日休市 1 天」的日曆、回 0（S8 盤點實測）。
  const dest = path.join(ROOT, 'data', 'calendar.json');
  if (list === undefined) { /* 取不到或解析不了，上面已經記下 */ } else if (!Array.isArray(list)) g.add(`${U}：來源不是陣列（${typeof list}）`);
  else if (list.length === 0) g.add(`${U}：來源 0 筆`);
  else {
    const missing = list.filter((e) => !e || typeof e !== 'object' || !('Date' in e) || !('Name' in e));
    if (missing.length) {
      g.add(`${U}：欄位對不上，${missing.length}／${list.length} 筆缺 Date 或 Name`
        + `（例：${JSON.stringify(Object.keys(missing[0] ?? {}))}）`);
    }
  }
  const { closed, tradingMarkers, bad } = classifyHolidaySchedule(Array.isArray(list) ? list : []);
  if (bad.length) g.add(`${U}：${bad.length} 筆日期解析不出來（例：${JSON.stringify(bad[0]?.Date)}）`);

  // 公告可能跨年（例如年底那張表含隔年一月）。只取指定年份，並確認真的有涵蓋。
  const inYear = (r) => r.date.startsWith(`${yearArg}-`);
  const closedY = closed.filter(inYear);
  const markersY = tradingMarkers.filter(inYear);
  if (closedY.length === 0 && Array.isArray(list) && list.length > 0) {
    const gotYears = [...new Set(closed.map((c) => c.date.slice(0, 4)))].sort().join('、') || '（一年都沒有）';
    // 證交所通常在第四季才公布隔年的休市日 —— 還沒公布的話這裡本來就產不出來。
    // **不要**因此產出一份「整年都開市」的假日曆：它會讓每個國定假日都被當成交易日去抓資料。
    g.add(`${U}：${yearArg} 年沒有這一年的休市日，只有 ${gotYears}（證交所通常第四季才公布隔年的）`);
  }

  // 比上一次成功的少一半以上就停：同一年有舊資料就比同一年，新的一年就比最近一年（平日休市天數）。
  const weekdayClosed = (list2) => list2.filter((c) => {
    const dw = new Date(`${c.date}T00:00:00Z`).getUTCDay();
    return dw !== 0 && dw !== 6;
  }).length;
  let existing = {};
  try { existing = readPrevious(dest) ?? {}; } catch (e) { g.add(`上一次的輸出（calendar.json）：解析不了（${e.message}）——不能當成第一次產而跳過比對`); }
  const prevYears = existing.years ?? (existing.year != null ? { [String(existing.year)]: existing } : {});
  const refYear = prevYears[String(yearArg)] ? String(yearArg) : Object.keys(prevYears).sort().pop();
  if (refYear && closedY.length > 0) {
    const p = shrinkProblem(`${U}：${yearArg} 年的平日休市天數（對照 ${refYear} 年上一次成功的）`,
      weekdayClosed(closedY), weekdayClosed(prevYears[refYear].closed ?? []));
    if (p) g.add(p);
  }
  g.check();

  const tradingDays = tradingDaysOfYear(yearArg, closedY, markersY);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // **併入既有的年份**，不要覆蓋。舊的單年格式（{ year, tradingDays, closed }）
  // 讀進來自動轉成 years 底下的一筆。
  const years = { ...(existing.years ?? {}) };
  if (!existing.years && existing.year != null && Array.isArray(existing.tradingDays)) {
    years[String(existing.year)] = {
      closed: existing.closed ?? [],
      tradingMarkers: existing.tradingMarkers ?? [],
      tradingDays: existing.tradingDays,
    };
    console.log(`把舊的單年格式（${existing.year}）轉進 years`);
  }

  const had = Object.keys(years);
  years[String(yearArg)] = { closed: closedY, tradingMarkers: markersY, tradingDays };

  const out = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    years: Object.fromEntries(Object.keys(years).sort().map((y) => [y, years[y]])),
  };

  writeAtomic(dest, JSON.stringify(out, null, 1));
  console.log(`寫出 ${dest}`);
  console.log(`年份：${Object.keys(out.years).join('、')}${had.includes(String(yearArg)) ? `（${yearArg} 是更新的）` : `（${yearArg} 是新增的）`}`);
  console.log(`${yearArg} 年：交易日 ${tradingDays.length} 天、平日休市 ${closedY.filter((c) => {
    const dw = new Date(`${c.date}T00:00:00Z`).getUTCDay();
    return dw !== 0 && dw !== 6;
  }).length} 天、照常交易標記 ${markersY.length} 筆`);
}

if (process.argv[1] && process.argv[1].endsWith('build-calendar.mjs')) {
  main().catch(reportAndExit);
}
