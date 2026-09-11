// 收盤價的取得與快取。
//
// 兩個端點，各有各的用途：
//   STOCK_DAY_ALL  一次拿到全市場當日收盤。**沒有日期參數**，永遠回「最新已公布的那一天」
//                  —— 所以拿到之後一定要核對它的日期是不是我們要的那天。
//                  這比只看時間門檻可靠：門檻只是用來避免打一次註定拿到昨天的請求。
//   STOCK_DAY      個股當月逐日，用來回補缺漏的日子。同一檔同一月只抓一次（快取在 IndexedDB）。

import * as db from './db.js';
import { parseStockDayAll, parseStockDay } from './twse.js';
import { isoToYyyymmdd } from './roc.js';

const BASE = 'https://www.twse.com.tw';
export const URL_DAY_ALL = `${BASE}/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json`;
export const urlStockDay = (code, iso) =>
  `${BASE}/exchangeReport/STOCK_DAY?response=json&date=${isoToYyyymmdd(iso)}&stockNo=${encodeURIComponent(code)}`;

/** 'YYYY-MM-DD' → 'YYYY-MM'（月快取的鍵）。 */
export const monthOf = (iso) => String(iso).slice(0, 7);

/**
 * 抓全市場當日收盤。
 * 回 { date, quotes: {code: {close, change, traded}}, untraded, isDate(expected) }
 *
 * **不會**因為日期不是我們要的就丟錯 —— 呼叫端要自己判斷並顯示「尚未公布」。
 */
export async function fetchDayAll(client) {
  const csv = await client.getText(URL_DAY_ALL);
  const parsed = parseStockDayAll(csv);
  const quotes = {};
  for (const r of parsed.rows) {
    quotes[r.code] = { close: r.close, change: r.change, traded: r.traded, name: r.name };
  }
  return { date: parsed.date, quotes, untraded: parsed.untraded, count: parsed.rows.length };
}

/**
 * 抓某一檔某一個月的逐日收盤，並存進 closes 與月快取。
 * 已經抓過而且那個月已經結束的話，直接讀快取不打網路。
 */
export async function fetchMonth(client, code, iso, { today } = {}) {
  const month = monthOf(iso);
  const cached = await db.get('monthcache', [code, month]);
  // 當月還沒過完的話，快取可能缺後面幾天 —— 只有「抓的時候那個月已經結束」才是完整的。
  if (cached && cached.complete) {
    return { code, month, rows: cached.rows, fromCache: true };
  }
  const json = await client.getJson(urlStockDay(code, `${month}-01`));
  const parsed = parseStockDay(json);
  if (!parsed.ok) {
    return { code, month, rows: [], fromCache: false, error: parsed.message };
  }
  const monthEnded = today ? monthOf(today) > month : false;
  await db.put('monthcache', {
    code, month, rows: parsed.rows, complete: monthEnded, fetchedAt: new Date().toISOString(),
  });
  await saveCloses(code, parsed.rows);
  return { code, month, rows: parsed.rows, fromCache: false };
}

/** 把逐日收盤寫進 closes store（只存持股代號，PLAN §3）。 */
export async function saveCloses(code, rows) {
  const items = rows
    .filter((r) => r.close != null)
    .map((r) => ({ code, date: r.date, close: r.close, change: r.change, exMark: r.exMark }));
  if (items.length) await db.putAll('closes', items);
}

export async function getClose(code, date) {
  const row = await db.get('closes', [code, date]);
  return row ?? null;
}

/** 一次讀多檔某一天的收盤。 */
export async function getCloses(codes, date) {
  const out = {};
  for (const code of codes) {
    const row = await db.get('closes', [code, date]);
    if (row) out[code] = row;
  }
  return out;
}

/**
 * 組出結算用的 quotes：今日收盤 ＋ 前一交易日收盤 ＋ 除權息標記。
 *
 * prevDate 是日曆算出來的前一交易日；沒有的話（日曆沒涵蓋、或是第一天）
 * 就退回用 STOCK_DAY_ALL 的漲跌價差倒推，這件事由 settle.basisFor 決定，
 * 這裡只負責把手上有的東西如實交出去，**不補 0**。
 */
export async function buildQuotes({ codes, date, prevDate, dayAllQuotes = null }) {
  const out = {};
  for (const code of codes) {
    const q = {};
    const today = dayAllQuotes?.[code] ?? await getClose(code, date);
    if (today && today.close != null) {
      q.close = today.close;
      if (today.change != null) q.change = today.change;
      if (today.exMark) q.exDay = true;
    }
    if (prevDate) {
      const prev = await getClose(code, prevDate);
      if (prev && prev.close != null) q.prevClose = prev.close;
    }
    // 除權息標記也可能來自已存的 closes（STOCK_DAY 的 "X0.00"）
    const stored = await getClose(code, date);
    if (stored?.exMark) q.exDay = true;
    out[code] = q;
  }
  return out;
}
