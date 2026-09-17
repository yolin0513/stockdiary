// 收盤價的取得與快取。
//
// 兩個端點，各有各的用途：
//   STOCK_DAY_ALL  一次拿到全市場當日收盤。**沒有日期參數**，永遠回「最新已公布的那一天」
//                  —— 所以拿到之後一定要核對它的日期是不是我們要的那天。
//                  這比只看時間門檻可靠：門檻只是用來避免打一次註定拿到昨天的請求。
//   STOCK_DAY      個股當月逐日，用來回補缺漏的日子。同一檔同一月只抓一次（快取在 IndexedDB）。

import * as db from './db.js';
import { parseStockDayAll, parseStockDay, parseFmtqik } from './twse.js';
import { isoToYyyymmdd, isoToRocCompact } from './roc.js';
import { parseTwt48u, parseTwt49u } from './dividend.js';

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

// ---------- 除權息 ----------

export const URL_TWT48U = `${BASE}/exchangeReport/TWT48U?response=json`;
// strDate／endDate 實測**沒有作用**（要求任何區間都回「最近一次」的結果），
// 但還是照證交所的介面把參數帶上，免得哪天它又生效時我們拿到的是全表。
export const urlTwt49u = (fromIso, toIso) =>
  `${BASE}/exchangeReport/TWT49U?response=json&strDate=${isoToRocCompact(fromIso)}&endDate=${isoToRocCompact(toIso)}`;

export async function fetchTwt48u(client) {
  return parseTwt48u(await client.getJson(URL_TWT48U));
}

export async function fetchTwt49u(client, fromIso, toIso) {
  return parseTwt49u(await client.getJson(urlTwt49u(fromIso, toIso)));
}

// ---------- 大盤指數 ----------
//
// 只有「今日觀察」的提示內容用得到（PLAN §7.2 要求給大盤漲跌％）。
// **不放進開頁的更新流程** —— 那條路徑上每多一個請求，每次開 App 就多一次。
// 這支只在使用者按下「產生今日觀察」時打一次。

export const urlFmtqik = (iso) =>
  `${BASE}/rwd/zh/afterTrading/FMTQIK?response=json&date=${isoToYyyymmdd(iso)}`;

/**
 * 某一天的大盤（發行量加權股價指數）。
 *
 * **查不到就回 null，不要回 0、也不要回別天的。** 上游回的是整個月，
 * 裡面沒有這一天（例如今天的還沒公布）時，回 null 才能讓提示內容照實說「無法取得」。
 */
export async function fetchMarketIndex(client, iso) {
  const r = parseFmtqik(await client.getJson(urlFmtqik(iso)));
  if (!r.ok) return null;
  return r.rows.find((x) => x.date === iso) ?? null;
}
