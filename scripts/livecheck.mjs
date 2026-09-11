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
import { ok, eq, section, done, everyOf, noneOf } from './tap.mjs';
import { parseStockDayAll, parseStockDay } from '../js/twse.js';
import { isoToYyyymmdd } from '../js/roc.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
  eq(res.headers.get('access-control-allow-origin'), '*',
    'CORS 標頭還在（少了它，純前端就完全拿不到收盤價）');
  const parsed = parseStockDayAll(text);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date)), `資料日期 ${parsed.date}`);
  ok(parsed.rows.length > 1000, `${parsed.rows.length} 檔`);
  const tsmc = parsed.rows.find((r) => r.code === '2330');
  ok(tsmc && tsmc.name === '台積電', `2330 還在，名稱「${tsmc?.name}」`);
  ok(tsmc && typeof tsmc.close === 'number' && tsmc.close > 0, `2330 收盤 ${tsmc?.close}`);
  ok(parsed.rows.some((r) => r.code === '0050'), 'ETF 0050 也在同一份表裡');
  noneOf(parsed.rows.filter((r) => !r.traded), (r) => r.close === 0,
    '沒成交的證券解出來不是 0');
}

section('STOCK_DAY（個股當月逐日）');
{
  const { res, text } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=20260601&stockNo=2330`);
  ok(res.status === 200, `HTTP ${res.status}`);
  eq(res.headers.get('access-control-allow-origin'), '*', 'CORS 標頭還在');
  const parsed = parseStockDay(JSON.parse(text));
  ok(parsed.ok, '回應可解析');
  ok(parsed.rows.length > 15, `115 年 6 月有 ${parsed.rows.length} 個交易日`);
  const ex = parsed.rows.filter((r) => r.exMark);
  ok(ex.length === 1 && ex[0].date === '2026-06-11',
    `除權息標記還是用 "X"：${ex.map((r) => r.date).join('、') || '找不到'}`);
}

section('上櫃代號在 TWSE 查不到 —— 「不支援」的設計前提');
{
  const { text: otc } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=6488`);
  const { text: nosuch } = await get(`${TWSE}/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=9999`);
  const a = parseStockDay(JSON.parse(otc));
  const b = parseStockDay(JSON.parse(nosuch));
  eq(a.ok, false, '上櫃代號 6488 查不到資料');
  eq(a.rows, [], '而且一筆都沒有');
  eq(a.message, b.message,
    `上櫃與不存在的代號回一樣的訊息：「${a.message}」—— 所以必須靠 data/stocks.json 分辨`);
}

section('除權息預告表 TWT48U（日曆用的那張）');
{
  const { res, text } = await get(`${TWSE}/exchangeReport/TWT48U?response=json`);
  ok(res.status === 200, `HTTP ${res.status}`);
  eq(res.headers.get('access-control-allow-origin'), '*', 'CORS 標頭還在');
  const j = JSON.parse(text);
  ok(j.stat === 'OK', `stat=${j.stat}`);
  ok(Array.isArray(j.data) && j.data.length > 0, `${j.data?.length ?? 0} 筆未來的除權息公告`);
  ok(Array.isArray(j.fields) && j.fields.length > 0, `欄位：${(j.fields || []).join('、')}`);
}

section('data/calendar.json 與 TWSE 實際成交日一致');
{
  const cal = JSON.parse(fs.readFileSync(`${ROOT}data/calendar.json`, 'utf8'));
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
  const past = [...new Set(cal.tradingDays.map((d) => d.slice(0, 7)))]
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
    const mine = cal.tradingDays.filter((d) => d.startsWith(month));
    eq(mine, actual, `${month} 的交易日與 TWSE 實際成交日完全一致（${actual.length} 天）`);
  }
}

section('data/stocks.json 還跟得上市場');
{
  const stocks = JSON.parse(fs.readFileSync(`${ROOT}data/stocks.json`, 'utf8'));
  const { text } = await get(`${TWSE}/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json`);
  const live = parseStockDayAll(text);
  const unknown = live.rows.filter((r) => !stocks.stocks[r.code]);
  ok(unknown.length === 0,
    `今天在集中市場成交的 ${live.rows.length} 檔，代號表裡都有`,
    unknown.length ? `代號表缺少：${unknown.slice(0, 10).map((r) => `${r.code} ${r.name}`).join('、')}${unknown.length > 10 ? ` 等 ${unknown.length} 檔` : ''} → 跑 npm run build-stocks` : '');
  const wrongMarket = live.rows.filter((r) => stocks.stocks[r.code] && stocks.stocks[r.code].market !== '上市');
  eq(wrongMarket.map((r) => r.code), [], '在集中市場成交的證券在代號表裡都標成上市');
}

section('請求節流');
ok(gaps.length > 0, `量到 ${gaps.length} 個請求間隔`);
everyOf(gaps, (g) => g >= 2000, `每一次請求都間隔 >= 2 秒（最短 ${Math.min(...gaps)} ms）`);

done('livecheck');
