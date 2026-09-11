// 狀態層 —— 畫面只跟這裡講話，不直接碰 db.js 或網路。

import * as db from './db.js';
import * as prefs from './prefs.js';
import * as catalog from './catalog.js';
import { makeCalendar, latestPublishedTradingDay, todayPending } from './market.js';
import { createClient } from './twseclient.js';
import * as updater from './update.js';

const state = {
  ready: false,
  calendar: null,
  calendarError: null,
  catalogError: null,
  lastUpdate: null,
  updating: null,
  client: null,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }
export function notifyChanged() { emit(); }

export async function init() {
  if (state.ready) return;
  await prefs.load();
  // 代號表與日曆抓不到不能擋住 App 開啟（離線時本來就只剩快取），
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
export function lastUpdate() { return state.lastUpdate; }

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

/**
 * 開頁自動更新一次。同一時間只跑一個（重複呼叫拿到同一個 promise）。
 * 網路壞掉不丟錯 —— 回一個 status=failed 的結果，畫面照樣畫得出來。
 */
export function update(opts) { return runUpdate(opts); }

function runUpdate({ force = false, onProgress } = {}) {
  if (state.updating && !force) return state.updating;
  // 每次開頁（或按重新整理）給一個全新的客戶端 —— 請求上限是「一次開頁 30 個」
  state.client = createClient();
  const p = updater.runUpdate({
    client: state.client,
    calendar: state.calendar,
    now: new Date(),
    threshold: prefs.get('todayDataThreshold'),
    includeDividend: prefs.get('dayPLIncludeDividend'),
    onProgress: onProgress ?? (() => {}),
  }).catch((e) => ({
    status: updater.STATUS.FAILED,
    settled: [],
    message: `更新失敗：${String(e.message || e)}`,
  })).then((r) => {
    state.lastUpdate = r;
    state.updating = null;
    emit();
    return r;
  });
  state.updating = p;
  return p;
}

export async function holdings() { return db.getAll('holdings'); }
export async function lastSettledDate() { return updater.lastSettledDate(); }
export async function loadSettle(date) { return updater.loadSettle(date); }
