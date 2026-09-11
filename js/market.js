// 交易日曆與「今天的收盤公布了沒」。
//
// 全部是純函式（日曆與現在時刻都用參數傳進來），才能用固定案例測出
// 「門檻前不准抓今天」「休市日不算缺漏」這種容易寫錯的判斷。
//
// 這裡最重要的一條：拿不到就回 null，不要回今天、不要回 0。
// 「今日收盤尚未公布時顯示 0」是這個 App 最容易犯、也最難發現的錯。

import { localISODate } from './roc.js';

/** settings 的預設「今日資料公布門檻」。M0 實測 TWSE 實際公布時間後定案。 */
export const DEFAULT_TODAY_THRESHOLD = '15:00';

/** 'HH:MM' → 當天的第幾分鐘；格式不對回 null。 */
export function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 建一個日曆物件；calendar.json 的內容丟進來就好。 */
export function makeCalendar(json) {
  const days = Array.isArray(json?.tradingDays) ? json.tradingDays : [];
  return {
    year: json?.year ?? null,
    days,
    set: new Set(days),
    closed: Array.isArray(json?.closed) ? json.closed : [],
  };
}

/** 這個日曆涵蓋這一天嗎？不涵蓋的話所有判斷都要回 null，不能用猜的。 */
export function covers(cal, iso) {
  return !!cal && cal.days.length > 0 && String(iso).startsWith(`${cal.year}-`);
}

/** 是交易日嗎？日曆沒涵蓋這一天回 null（不是 false）。 */
export function isTradingDay(cal, iso) {
  if (!covers(cal, iso)) return null;
  return cal.set.has(iso);
}

/** iso 之前（不含）最後一個交易日；沒有或日曆沒涵蓋回 null。 */
export function prevTradingDay(cal, iso) {
  if (!covers(cal, iso)) return null;
  let found = null;
  for (const d of cal.days) {
    if (d >= iso) break;
    found = d;
  }
  return found;
}

/** [from, to] 之間的交易日（含兩端）；日曆沒涵蓋回 null。 */
export function tradingDaysBetween(cal, from, to) {
  if (!covers(cal, from) || !covers(cal, to)) return null;
  return cal.days.filter((d) => d >= from && d <= to);
}

/**
 * 「現在這個時刻，最新一天『收盤資料應該已經公布』的交易日」是哪一天。
 *
 * 規則：
 *   · 今天是交易日，而且現在已過門檻 → 今天
 *   · 否則 → 今天之前最後一個交易日
 *   · 日曆沒涵蓋今天 → null（例如跨年了還沒更新 calendar.json）
 *
 * 回 null 的時候畫面要講「還沒有今年的開休市日」，不要自己假設週一到週五就是交易日。
 */
export function latestPublishedTradingDay(cal, now, thresholdHHMM = DEFAULT_TODAY_THRESHOLD) {
  const today = localISODate(now);
  const isTd = isTradingDay(cal, today);
  if (isTd === null) return null;
  const threshold = hhmmToMinutes(thresholdHHMM);
  if (threshold === null) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (isTd && mins >= threshold) return today;
  return prevTradingDay(cal, today);
}

/**
 * 今天是交易日、但還沒到門檻的狀態 —— 畫面要顯示「今日收盤尚未公布」。
 * 注意這跟「今天是休市日」不一樣，兩者文案不同。
 */
export function todayPending(cal, now, thresholdHHMM = DEFAULT_TODAY_THRESHOLD) {
  const today = localISODate(now);
  if (isTradingDay(cal, today) !== true) return false;
  const threshold = hhmmToMinutes(thresholdHHMM);
  if (threshold === null) return false;
  return now.getHours() * 60 + now.getMinutes() < threshold;
}

/**
 * 從 lastSettled（最後結算過的交易日，可為 null）到 upTo 之間，還沒結算的交易日。
 * lastSettled 為 null → 只回 upTo 當天（不要一次回補一整年）。
 */
export function missingTradingDays(cal, lastSettled, upTo) {
  if (!upTo || !covers(cal, upTo)) return [];
  if (!lastSettled) return cal.set.has(upTo) ? [upTo] : [];
  const between = tradingDaysBetween(cal, lastSettled, upTo);
  if (!between) return [];
  return between.filter((d) => d > lastSettled);
}
