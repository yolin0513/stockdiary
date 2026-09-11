// 狀態層 —— 畫面只跟這裡講話，不直接碰 db.js。
//
// M0 只放「開得起來」需要的東西：設定、代號表、交易日曆、持股讀取。
// 持股寫入、每日結算、除權息在 M1／M2 接上來。

import * as db from './db.js';
import * as prefs from './prefs.js';
import * as catalog from './catalog.js';
import { makeCalendar, latestPublishedTradingDay, todayPending } from './market.js';

const state = {
  ready: false,
  calendar: null,
  calendarError: null,
  catalogError: null,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }
export function notifyChanged() { emit(); }

export async function init() {
  if (state.ready) return;
  await prefs.load();
  // 代號表與日曆抓不到不能擋住 App 開啟 —— 離線時本來就只剩快取，
  // 但也不能假裝成功：把錯誤留著，畫面要講「尚未取得」。
  await Promise.all([
    catalog.load().catch((e) => { state.catalogError = String(e.message || e); }),
    loadCalendar().catch((e) => { state.calendarError = String(e.message || e); }),
  ]);
  state.ready = true;
}

async function loadCalendar() {
  const res = await fetch('./data/calendar.json', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`calendar.json HTTP ${res.status}`);
  state.calendar = makeCalendar(await res.json());
}

export function calendar() { return state.calendar; }
export function calendarError() { return state.calendarError; }
export function catalogError() { return state.catalogError; }

/** 現在這個時刻，收盤資料應該已公布的最新交易日；拿不到回 null。 */
export function expectedSettleDate(now = new Date()) {
  if (!state.calendar) return null;
  return latestPublishedTradingDay(state.calendar, now, prefs.get('todayDataThreshold'));
}

/** 今天是交易日但還沒到公布門檻。 */
export function isTodayPending(now = new Date()) {
  if (!state.calendar) return false;
  return todayPending(state.calendar, now, prefs.get('todayDataThreshold'));
}

export async function holdings() {
  return db.getAll('holdings');
}

/** 最後一次成功結算的日期；還沒結算過回 null（不是今天、也不是 0）。 */
export async function lastSettledDate() {
  const rows = await db.getAll('settle');
  if (!rows.length) return null;
  return rows.map((r) => r.date).sort().at(-1);
}
