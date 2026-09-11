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
// 用法：node scripts/build-calendar.mjs [--year 2026] [--from <本機 JSON 檔>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rocCompactToISO } from '../js/roc.js';

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

  let list;
  if (fromArg) {
    list = JSON.parse(fs.readFileSync(fromArg, 'utf8'));
    console.log(`讀本機檔：${fromArg}（${list.length} 筆）`);
  } else {
    console.log(`抓 ${SOURCE}`);
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`holidaySchedule HTTP ${res.status}`);
    list = await res.json();
    console.log(`收到 ${list.length} 筆公告`);
  }

  const { closed, tradingMarkers, bad } = classifyHolidaySchedule(list);
  if (bad.length) console.warn(`⚠ ${bad.length} 筆日期解析不出來，已略過`);

  // 公告可能跨年（例如年底那張表含隔年一月）。只取指定年份，並確認真的有涵蓋。
  const inYear = (r) => r.date.startsWith(`${yearArg}-`);
  const closedY = closed.filter(inYear);
  const markersY = tradingMarkers.filter(inYear);
  if (closedY.length === 0) {
    throw new Error(`公告裡沒有 ${yearArg} 年的休市日 —— 這張表大概是別的年份的，不要產出一份「整年都開市」的假日曆`);
  }

  const tradingDays = tradingDaysOfYear(yearArg, closedY, markersY);
  const out = {
    year: yearArg,
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    closed: closedY,
    tradingMarkers: markersY,
    tradingDays,
  };

  const dest = path.join(ROOT, 'data', 'calendar.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 1), 'utf8');
  console.log(`寫出 ${dest}`);
  console.log(`${yearArg} 年：交易日 ${tradingDays.length} 天、平日休市 ${closedY.filter((c) => {
    const dw = new Date(`${c.date}T00:00:00Z`).getUTCDay();
    return dw !== 0 && dw !== 6;
  }).length} 天、照常交易標記 ${markersY.length} 筆`);
}

if (process.argv[1] && process.argv[1].endsWith('build-calendar.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
