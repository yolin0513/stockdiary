// 打真網路的巡檢（npm run livecheck）。**不進 npm test。**
//
// npm test 必須離線可跑、結果決定性；這支則是確認「外面的世界還是我們以為的樣子」：
//   · 端點還活著、CORS 標頭還在（瀏覽器要直打）
//   · 回應格式沒變（用正式解析器跑一次，不是看看有沒有 200）
//   · data/calendar.json 的交易日跟 TWSE 實際成交的日子一致
//   · 上櫃代號在 TWSE 依然查不到（「不支援」的設計前提）
//
// 所有請求間隔 >= 2 秒（FEASIBILITY §1.2：社群共識 3 次／5 秒會被封 IP）。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, note } from './tap.mjs';
import { parseStockDayAll, parseStockDay } from '../js/twse.js';
import { isoToYyyymmdd, isoToRocCompact } from '../js/roc.js';
import { parseTwt49u } from '../js/dividend.js';
import {
  controls, corsProblem, stockDayAllProblems, stockDayJuneProblems, otcPremiseProblems, twt48uProblems,
  refPriceMismatches, calendarDays, calendarDiff, stocksProblems, gapProblems,
} from './livejudge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 先跑對照組（SPEC_檢查器修補 S6）：用 scripts/fixtures/ 裡錄好的回應，**不打證交所**。
// 判斷邏輯壞了，下面對著真實回應的「全過」就不可信——以前全部比對的是真實回應，沒有合成對照。
process.stdout.write('對照組（判斷邏輯自己有沒有壞；錄好的回應，不打網路）：\n');
const ctrl = controls();
for (const c of ctrl) process.stdout.write(`  ${c.ok ? '✓' : '✗'} （對照）${c.name}（${c.detail}）\n`);
if (ctrl.some((c) => !c.ok)) {
  process.stdout.write('對照組沒過：livecheck 的判斷邏輯壞了，巡檢結果不可信——停下，不打證交所。\n');
  process.exit(1);
}
// 下面每一段的判斷都在 scripts/livejudge.mjs，跟對照組同一段程式。
const none = (list, msg) => eq(list, [], msg);
const GAP_MS = 2200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
const gaps = [];

async function get(url) {
  const wait = lastRequestAt ? Math.max(0, GAP_MS - (Date.now() - lastRequestAt)) : 0;
  if (wait) await sleep(wait);
  if (lastRequestAt) gaps.push(Date.now() - lastRequestAt);
  lastRequestAt = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: '*/*' } });
  return { res, text: await res.text() };
}

const TWSE = 'https://www.twse.com.tw';

section('STOCK_DAY_ALL（全市場當日收盤，瀏覽器直打）');
{
  const { res, text } = await get(`${TWSE}/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json`);
  ok(res.status === 200, `HTTP ${res.status}`);
  eq(corsProblem(res.headers.get('access-control-allow-origin')), null,
    'CORS 標頭還在（少了它，純前端就完全拿不到收盤價）');
  const parsed = parseStockDayAll(text);
  none(stockDayAllProblems(parsed),
    `格式沒變：資料日期 ${parsed.date}、${parsed.rows.length} 檔、2330 與 0050 都在、沒成交的不是 0`);
}

section('STOCK_DAY（個股當月逐日）');
{
  const { res, text } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=20260601&stockNo=2330`);
  ok(res.status === 200, `HTTP ${res.status}`);
  eq(corsProblem(res.headers.get('access-control-allow-origin')), null, 'CORS 標頭還在');
  const parsed = parseStockDay(JSON.parse(text));
  none(stockDayJuneProblems(parsed),
    `回應可解析、115 年 6 月有 ${parsed.rows.length} 個交易日、除權息標記還是用 "X"`);
}

section('上櫃代號在 TWSE 查不到 —— 「不支援」的設計前提');
{
  const { text: otc } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=6488`);
  const { text: nosuch } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=9999`);
  const a = parseStockDay(JSON.parse(otc));
  const b = parseStockDay(JSON.parse(nosuch));
  none(otcPremiseProblems(a, b),
    `上櫃代號 6488 查不到資料、一筆都沒有，而且跟不存在的代號回一樣的訊息：「${a.message}」—— 所以必須靠 data/stocks.json 分辨`);
}

section('除權息預告表 TWT48U（日曆用的那張）');
let forecastRows = [];
{
  const { res, text } = await get(`${TWSE}/exchangeReport/TWT48U?response=json`);
  ok(res.status === 200, `HTTP ${res.status}`);
  eq(corsProblem(res.headers.get('access-control-allow-origin')), null, 'CORS 標頭還在');
  const t48 = twt48uProblems(JSON.parse(text));
  forecastRows = t48.rows;
  none(t48.problems,
    `解析成功、有資料（${forecastRows.length} 筆未來的除權息公告，其中 ${forecastRows.filter((r) => r.cashPerShare != null).length} 筆的金額已公告）`);
}

section('除權息結果表 TWT49U（參考價用的那張）');
let resultRows = [];
{
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { res, text } = await get(
    `${TWSE}/exchangeReport/TWT49U?response=json&strDate=${isoToRocCompact(iso)}&endDate=${isoToRocCompact(iso)}`);
  ok(res.status === 200, `HTTP ${res.status}`);
  const j = JSON.parse(text);
  if (j.stat === 'OK') {
    const parsed = parseTwt49u(j);
    resultRows = parsed.rows;
    ok(parsed.ok, `解析成功（${resultRows.length} 筆，title「${j.title}」）`);
    // 日期參數無效這件事是 FEASIBILITY §10.8 的結論，這裡持續監看：
    // 哪天證交所修好了，這條就會變成「參數開始生效了」的提醒。
    const dates = [...new Set(resultRows.map((r) => r.date))];
    note(`回應涵蓋的日期：${dates.join('、') || '無'}（要求的是 ${iso}）`);
    ok(resultRows.length > 0, `（前提）今天的結果表有 ${resultRows.length} 筆`);
    eq(refPriceMismatches(resultRows).map((r) => r.code), [],
      '參考價公式（前收 − 權值息值，捨去兩位）仍與證交所公布值一致');
  } else {
    note(`今天沒有除權息結果（stat：${j.stat}）—— 不算失敗`);
  }
}

section('捕捉「預告 → 結果」的配對樣本');
{
  // 為什麼要做這件事：參考價的自算備援還缺一段驗證（見 docs/STATUS.md 的待辦）。
  // 需要同一檔先出現在預告表、之後出現在結果表的配對樣本，而 TWT49U 只給得到
  // 最近一次的結果 —— 只能靠每次 livecheck 把預告記下來，等它變成結果。
  const seenPath = `${ROOT}docs/measurements/twt48u-seen.json`;
  const pairPath = `${ROOT}scripts/fixtures/refprice-pairs.json`;
  fs.mkdirSync(`${ROOT}docs/measurements`, { recursive: true });

  const seen = fs.existsSync(seenPath) ? JSON.parse(fs.readFileSync(seenPath, 'utf8')) : {};
  const before = Object.keys(seen).length;
  for (const r of forecastRows) {
    seen[`${r.code}-${r.exDate}`] = {
      code: r.code, name: r.name, exDate: r.exDate, kind: r.kind,
      cashPerShare: r.cashPerShare, stockRate: r.stockRate,
      rightsRate: r.rightsRate, rightsPrice: r.rightsPrice,
      seenAt: new Date().toISOString().slice(0, 10),
    };
  }
  fs.writeFileSync(seenPath, JSON.stringify(seen, null, 1), 'utf8');
  note(`預告表紀錄：${before} → ${Object.keys(seen).length} 筆（${seenPath.replace(ROOT, '')}）`);

  const pairs = fs.existsSync(pairPath) ? JSON.parse(fs.readFileSync(pairPath, 'utf8')) : [];
  const known = new Set(pairs.map((p) => `${p.code}-${p.exDate}`));
  const fresh = [];
  for (const r of resultRows) {
    const key = `${r.code}-${r.date}`;
    if (known.has(key)) continue;
    const f = seen[key];
    if (!f) continue;            // 這一筆的預告我們沒記到（第一次跑，或那時候還沒公告）
    fresh.push({
      code: r.code, name: r.name, exDate: r.date, kind: r.kind,
      forecast: { cashPerShare: f.cashPerShare, stockRate: f.stockRate, rightsRate: f.rightsRate, rightsPrice: f.rightsPrice },
      result: { prevClose: r.prevClose, refPrice: r.refPrice, exValue: r.exValue },
      capturedAt: new Date().toISOString().slice(0, 10),
    });
  }

  if (fresh.length) {
    fs.writeFileSync(pairPath, JSON.stringify([...pairs, ...fresh], null, 1), 'utf8');
    note(`**抓到 ${fresh.length} 筆新的配對樣本**，已寫進 ${pairPath.replace(ROOT, '')}`);
    for (const p of fresh) {
      // 證交所公式：參考價 = (前收 − 現金股利 + 增資配股率 × 認購價) ÷ (1 + 無償配股率 + 增資配股率)
      const { cashPerShare: c, stockRate: s, rightsRate: rr, rightsPrice: rp } = p.forecast;
      const derivable = c != null && s != null && rr != null && rp != null && p.result.prevClose != null;
      if (!derivable) {
        note(`  ${p.code} ${p.name}（${p.kind}）：預告資料不完整，這筆無法用來驗證推導`);
        continue;
      }
      const raw = (p.result.prevClose - c + rr * rp) / (1 + s + rr);
      const calc = Math.floor(raw * 100) / 100;
      note(`  ${p.code} ${p.name}（${p.kind}）：公式算出 ${calc}，證交所公布 ${p.result.refPrice}` +
        (calc === p.result.refPrice ? ' ✓ 一致' : ` ✗ 差 ${(calc - p.result.refPrice).toFixed(4)}`));
    }
    note('→ 下一步見 docs/STATUS.md 的「除權息參考價的自算備援」待辦');
  } else {
    note('這次沒有新的配對樣本（要在除權息日的隔天跑才抓得到）—— 不算失敗');
  }
}

section('data/calendar.json 與 TWSE 實際成交日一致');
{
  const cal = JSON.parse(fs.readFileSync(`${ROOT}data/calendar.json`, 'utf8'));
  // 多年格式沒有頂層 tradingDays。這裡不 import market.js（livecheck 是獨立腳本），
  // 直接把各年份的交易日攤平 —— 舊格式也照樣讀得到。
  const calDays = calendarDays(cal);
  // 挑「已經完全過去」而且「平日休市最多」的兩個月來核對 —— 連假多的月份最容易算錯。
  // 不寫死月份：寫死的話明年跑這支會去查未來的日期，TWSE 回「查詢日期大於今日」。
  const today = new Date();
  const closedWeekdaysByMonth = new Map();
  for (const c of cal.closed) {
    const dow = new Date(`${c.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const m = c.date.slice(0, 7);
    closedWeekdaysByMonth.set(m, (closedWeekdaysByMonth.get(m) || 0) + 1);
  }
  const past = [...new Set(calDays.map((d) => d.slice(0, 7)))]
    .filter((m) => {
      const [y, mo] = m.split('-').map(Number);
      const monthEnd = new Date(y, mo, 0);           // 該月最後一天
      return monthEnd < today;
    });
  const months = past
    .sort((a, b) => (closedWeekdaysByMonth.get(b) || 0) - (closedWeekdaysByMonth.get(a) || 0))
    .slice(0, 2);
  ok(months.length === 2, `核對 ${months.join('、')}（平日休市最多的兩個已過月份）`);
  for (const month of months) {
    const first = `${month}-01`;
    const { text } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=${isoToYyyymmdd(first)}&stockNo=2330`);
    const parsed = parseStockDay(JSON.parse(text));
    if (!parsed.ok || parsed.rows.length === 0) {
      ok(false, `${month} 拿不到 2330 的資料，無法核對`, parsed.message);
      continue;
    }
    const actual = parsed.rows.map((r) => r.date);
    const mine = calDays.filter((d) => d.startsWith(month));
    eq(calendarDiff(mine, actual), { missing: [], extra: [] },
      `${month} 的交易日與 TWSE 實際成交日完全一致（${actual.length} 天；missing＝日曆少了、extra＝日曆多了）`);
  }
}

section('data/stocks.json 還跟得上市場');
{
  const stocks = JSON.parse(fs.readFileSync(`${ROOT}data/stocks.json`, 'utf8'));
  const { text } = await get(`${TWSE}/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json`);
  const live = parseStockDayAll(text);
  const { unknown, wrongMarket } = stocksProblems(stocks, live.rows);
  ok(unknown.length === 0,
    `今天在集中市場成交的 ${live.rows.length} 檔，代號表裡都有`,
    unknown.length ? `代號表缺少：${unknown.slice(0, 10).map((r) => `${r.code} ${r.name}`).join('、')}${unknown.length > 10 ? ` 等 ${unknown.length} 檔` : ''} → 跑 npm run build-stocks` : '');
  eq(wrongMarket.map((r) => r.code), [], '在集中市場成交的證券在代號表裡都標成上市');
}

section('請求節流');
none(gapProblems(gaps), `量到 ${gaps.length} 個請求間隔，每一次都 >= 2 秒（最短 ${Math.min(...gaps)} ms）`);

done('livecheck');
