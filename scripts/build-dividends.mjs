// 產生 data/dividends.json（npm run build-dividends）。
//
// 資料來源：證交所 OpenAPI「股利分派情形」t187ap45_L。
//
// 為什麼走 build 腳本而不是前端直打（2026-09-11 實測）：
//   · **openapi.twse.com.tw 沒有 CORS**。帶 Origin 也不回 access-control-allow-origin，
//     瀏覽器 fetch 直接 TypeError: Failed to fetch。
//   · 走 Worker 轉發技術上可行，但那讓 Worker 從「新聞轉發」變成資料管道，
//     多一個線上相依，而且解決不了下面那個更根本的限制。
//
// **這份資料的歷史深度只有兩年。** 實測 1226 筆涵蓋 1111 家上市公司，
// 但股利年度只有 114–115，每檔最多 4 筆、**中位數 1 筆**。
// 它是「最近的決議快照」，不是歷史檔案。證交所沒有公開的歷年股利端點
// （TWT49U 的日期參數無效，見 FEASIBILITY §10.8）。
//
// ⚠ **這份資料需要定期重跑這支腳本。** 公司每季／每年公告新的股利決議，
//   不重跑就會一直停在舊的出表日期。App 會顯示出表日期，超過一季會標「可能已過期」，
//   但那只是提醒使用者，不會自己更新。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard, shrinkProblem, readPrevious, writeAtomic, reportAndExit } from './buildguard.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const URL_SRC = 'https://openapi.twse.com.tw/v1/opendata/t187ap45_L';
const OUT = path.join(ROOT, 'data', 'dividends.json');

/** 三種現金股利來源要加總 —— 只取「盈餘分配」會少算資本公積配發的那部分。 */
function cashOf(r) {
  return num(r['股東配發-盈餘分配之現金股利(元/股)'])
    + num(r['股東配發-法定盈餘公積發放之現金(元/股)'])
    + num(r['股東配發-資本公積發放之現金(元/股)']);
}

/** 配股率同理，三種來源加總。 */
function stockOf(r) {
  return num(r['股東配發-盈餘轉增資配股(元/股)'])
    + num(r['股東配發-法定盈餘公積轉增資配股(元/股)'])
    + num(r['股東配發-資本公積轉增資配股(元/股)']);
}

/** 數字欄位。空的、非數字的一律當 0（這裡的 0 是「沒有配」，不是「不知道」）。 */
function num(x) {
  const n = Number(String(x ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * 四捨五入到小數第 8 位。
 * 來源有 7.00000137 這種浮點雜訊（1141231 那筆 2330 是 6.00003573），
 * 原樣留著會讓畫面出現「6.00003573 元」。但**不要四捨五入到 2 位** ——
 * 有些公司真的配到小數第 4 位以上。
 */
function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

async function main() {
  process.stdout.write(`抓 ${URL_SRC} …\n`);
  // ---- 寫檔前關卡（scripts/buildguard.mjs）：有任何一項不過，就一個檔都不寫 ----
  // 以前：只看第一筆的欄位；代號全部不合格式、或現金股利欄全空，照樣寫出「0 檔、0 筆」的 dividends.json；
  // 只給 40 筆裡的 2 筆也照樣寫（S8 盤點實測）。每一條問題都以單位開頭（F8），取不到、解析不了也收進來。
  const U = '股利分派情形（t187ap45_L）';
  const g = guard('build-dividends');
  let rows;
  try {
    const res = await fetch(URL_SRC, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) g.add(`${U}：取不到（HTTP ${res.status}）`);
    else {
      const text = await res.text();
      try { rows = JSON.parse(text); } catch (e) { g.add(`${U}：解析不了（${e.message}）`); }
    }
  } catch (e) { g.add(`${U}：取不到（${e.message}）`); }
  if (rows === undefined) { /* 取不到或解析不了，上面已經記下 */ } else if (!Array.isArray(rows)) g.add(`${U}：來源不是陣列（${typeof rows}）`);
  else if (rows.length === 0) g.add(`${U}：來源 0 筆`);
  const list = Array.isArray(rows) ? rows : [];
  for (const k of ['公司代號', '股利年度', '股東配發-盈餘分配之現金股利(元/股)']) {
    const miss = list.filter((r) => !r || typeof r !== 'object' || !(k in r)).length;
    if (miss) g.add(`${U}：欄位對不上，${miss}／${list.length} 筆找不到「${k}」`);
  }

  const byCode = new Map();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;   // 上面的欄位檢查已經記下這一筆
    const code = String(r['公司代號'] ?? '').trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) continue;
    const rec = {
      year: String(r['股利年度'] ?? '').trim(),
      period: String(r['股利所屬年(季)度'] ?? '').trim(),
      range: String(r['股利所屬期間'] ?? '').trim(),
      cash: round8(cashOf(r)),
      stock: round8(stockOf(r)),
      // 決議進度很重要：「董事會決議」還沒經股東會確認，數字可能還會變。
      status: String(r['決議（擬議）進度'] ?? '').replace(/<br\s*\/?>/g, '').trim(),
    };
    if (rec.cash === 0 && rec.stock === 0) continue; // 沒配就不收
    byCode.set(code, [...(byCode.get(code) ?? []), rec]);
  }

  // 收進來的檔數：0 就停（以前照樣寫出 0 檔的輸出）；比上一次成功的少一半以上也停
  if (list.length > 0 && byCode.size === 0) g.add(`${U}：收進來 0 檔（${list.length} 筆裡，代號都不合格式，或都沒有配發）`);
  let prev = null;
  try { prev = readPrevious(OUT); } catch (e) { g.add(`上一次的輸出（dividends.json）：解析不了（${e.message}）——不能當成第一次產而跳過比對`); }
  const shrink = shrinkProblem(`${U}：收進來的檔數`, byCode.size, prev ? Object.keys(prev.codes ?? {}).length : null);
  if (shrink) g.add(shrink);
  g.check();

  // 每檔照期間新到舊
  for (const recs of byCode.values()) recs.sort((a, b) => String(b.range).localeCompare(String(a.range)));

  const out = {
    source: 't187ap45_L',
    sourceUrl: URL_SRC,
    // 出表日期是**資料的日期**，不是我們抓的日期。畫面要顯示這個。
    reportDate: String(list[0]['出表日期'] ?? '').trim(),
    generatedAt: new Date().toISOString(),
    codes: Object.fromEntries([...byCode].sort((a, b) => a[0].localeCompare(b[0]))),
  };

  writeAtomic(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  const counts = [...byCode.values()].map((l) => l.length);
  process.stdout.write(
    `寫入 ${path.relative(ROOT, OUT)}：${byCode.size} 檔、${counts.reduce((a, b) => a + b, 0)} 筆、${kb} KB\n`
    + `出表日期 ${out.reportDate}；每檔筆數 ${Math.min(...counts)}–${Math.max(...counts)}\n`
    + '⚠ 這份資料需要定期重跑（公司每季會公告新的股利決議）。\n');
}

main().catch(reportAndExit);
