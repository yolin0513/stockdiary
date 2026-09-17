// 狀態層 —— 畫面只跟這裡講話，不直接碰 db.js 或網路。

import * as db from './db.js';
import * as prefs from './prefs.js';
import * as catalog from './catalog.js';
import { makeCalendar, latestPublishedTradingDay, todayPending, calendarRunway as runwayOf } from './market.js';
import { createClient } from './twseclient.js';
import * as updater from './update.js';
import * as prices from './prices.js';

const state = {
  ready: false,
  calendar: null,
  calendarError: null,
  // 回補進度。PLAN §2.2 說長假回補時畫面要顯示進度，但 onProgress 一直沒有人接 ——
  // 使用者看到的是一個不動的畫面，不知道它在做事還是當掉了。
  progress: null,
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

/**
 * 目前的回補進度 `{ done, total, label }`，沒有在跑就是 null。
 *
 * 只有 total > 1 才值得畫在畫面上 —— 單一請求（最常見的情況）一閃而過，
 * 畫出來只會讓畫面抖一下。
 */
export function progress() { return state.progress; }

/**
 * 日曆還能撐多久 —— 畫面用來在用完之前先提醒使用者更新 App。
 *
 * 2027-01-01 一到，沒有隔年日曆就整個更新流程停擺（除權息同步、定期定額待確認
 * 也一起停），而在那之前完全沒有任何提示。實測（2026-09-17）證交所的
 * holidaySchedule 目前只有 2026 年，所以這個提醒是目前唯一的防線。
 */
export function calendarRunway(now = new Date()) {
  return runwayOf(state.calendar, now);
}
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
  if (state.updating) {
    // 已經有一次在跑。force 的意思是「再算一次」，不是「同時再跑一次」——
    // 兩次同時跑會對 TWSE 送出雙倍請求（實測過：跨月回補 2 個月份變成 4 個請求），
    // 而 TWSE 連打是會被封 IP 的。排在後面跑，不要並行。
    // 最常撞到的不是「重新整理」按鈕，是**開 App 的頭幾秒就新增持股**：
    // 那裡也會 force 一次，而開機那一次通常還在飛。
    if (!force) return state.updating;
    return state.updating.then(() => runUpdate({ force, onProgress }));
  }
  // 每次開頁（或按重新整理）給一個全新的客戶端 —— 請求上限是「一次開頁 30 個」
  state.client = createClient();
  const p = updater.runUpdate({
    client: state.client,
    calendar: state.calendar,
    now: new Date(),
    threshold: prefs.get('todayDataThreshold'),
    includeDividend: prefs.get('dayPLIncludeDividend'),
    // **自己接上**，不要等呼叫端傳。呼叫端（app.js 開機那一次、設定頁的重新整理）
    // 以前都沒傳，於是那份進度算好了卻沒有人看得到。
    onProgress: (info) => {
      state.progress = info;
      emit();
      if (onProgress) onProgress(info);
    },
  }).catch((e) => ({
    status: updater.STATUS.FAILED,
    settled: [],
    message: `更新失敗：${String(e.message || e)}`,
  })).then((r) => {
    state.lastUpdate = r;
    state.updating = null;
    // 跑完就把進度清掉 —— 留著的話畫面會一直掛著「回補中 12/12」，
    // 看起來像卡住了（實際上早就跑完）。
    state.progress = null;
    emit();
    return r;
  });
  state.updating = p;
  return p;
}

export async function holdings() { return db.getAll('holdings'); }
export async function lastSettledDate() { return updater.lastSettledDate(); }
export async function loadSettle(date) { return updater.loadSettle(date); }
/** 最後一筆結算紀錄（不管算不算得出東西）——畫面用這個才講得出「卡在哪裡」。 */
export async function latestSettle() { return updater.latestSettleRecord(); }

/**
 * 某一天的大盤（發行量加權股價指數）。
 *
 * 只有「今日觀察」的提示內容用得到，所以**按下按鈕時才打**，不進開頁的更新流程
 * —— 那條路徑上每多一個請求，每次開 App 就多一次。
 * 拿不到（沒公布、網路壞掉、上游改格式）一律回 null：提示內容會照實寫「無法取得」，
 * 絕不拿 0 或別天的數字頂替。
 */
export async function marketIndexFor(date) {
  try {
    return await prices.fetchMarketIndex(createClient(), date);
  } catch {
    return null;
  }
}
