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

/**
 * 日曆剩下幾天以內要開始提醒使用者更新 App。
 *
 * 45 天：證交所通常在第四季公布隔年的休市日，11 月中開始提醒還來得及讓人更新。
 * 實測（2026-09-17）：openapi 的 holidaySchedule 目前**只有民國 115 年（2026）**，
 * 一筆 116 年的都沒有 —— 所以這個警示是目前唯一的防線。
 */
export const CALENDAR_WARN_DAYS = 45;

/** 'HH:MM' → 當天的第幾分鐘；格式不對回 null。 */
export function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 建一個日曆物件；calendar.json 的內容丟進來就好。
 *
 * **兩種格式都讀得懂：**
 *   新（多年）：{ years: { "2026": { tradingDays, closed }, "2027": {...} } }
 *   舊（單年）：{ year: 2026, tradingDays, closed }
 *
 * 為什麼要多年：舊格式的日曆只涵蓋一年，2027-01-01 一到，`covers()` 對每一天都回 false，
 * 於是整個更新流程停擺 —— 除權息同步與定期定額待確認也一起停 —— 而 12 月裡完全沒有提示。
 * 舊格式留著讀是因為使用者手機上可能還存著舊的 calendar.json（SW 快取），
 * 換版當下不能因為格式變了就整個壞掉。
 */
export function makeCalendar(json) {
  // 新格式
  if (json?.years && typeof json.years === 'object' && !Array.isArray(json.years)) {
    const years = Object.keys(json.years).filter((y) => /^\d{4}$/.test(y)).sort();
    const days = [];
    const closed = [];
    for (const y of years) {
      const one = json.years[y];
      if (Array.isArray(one?.tradingDays)) days.push(...one.tradingDays);
      if (Array.isArray(one?.closed)) closed.push(...one.closed);
    }
    days.sort();
    return {
      years,
      // 只有一年時 year 仍然給值，舊的呼叫端（畫面文案）才不會突然變成 null
      year: years.length === 1 ? Number(years[0]) : null,
      days,
      set: new Set(days),
      closed,
    };
  }

  // 舊格式
  const days = Array.isArray(json?.tradingDays) ? json.tradingDays : [];
  const year = json?.year ?? null;
  return {
    years: year == null ? [] : [String(year)],
    year,
    days,
    set: new Set(days),
    closed: Array.isArray(json?.closed) ? json.closed : [],
  };
}

/**
 * 這個日曆涵蓋這一天嗎？不涵蓋的話所有判斷都要回 null，不能用猜的。
 *
 * 判準是「這一天的年份在 years 裡」，不是「以某個年份開頭」——
 * 後者在多年份日曆上只會認得第一年。
 */
export function covers(cal, iso) {
  if (!cal || cal.days.length === 0) return false;
  const y = String(iso ?? '').slice(0, 4);
  if (!/^\d{4}$/.test(y)) return false;
  return cal.years.includes(y);
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
/**
 * 距離「日曆用完」還有幾天 —— 提前警示用。
 *
 * 2027-01-01 一到，沒有 2027 年的日曆就整個更新流程停擺，
 * 而**在那之前完全沒有任何提示**。這個函式讓畫面能在用完前先講。
 *
 * 回 { lastDay, daysLeft, warn }：
 *   lastDay   日曆涵蓋到的最後一個交易日（沒有日曆回 null）
 *   daysLeft  從 now 到 lastDay 還有幾天（已經過了就是負的）
 *   warn      該不該提醒（daysLeft <= CALENDAR_WARN_DAYS）
 *
 * 純函式，now 由外面傳進來 —— 不然測「11 月時會提醒、9 月時不會」得等到 11 月。
 */
export function calendarRunway(cal, now, warnDays = CALENDAR_WARN_DAYS) {
  if (!cal || cal.days.length === 0) return { lastDay: null, daysLeft: null, warn: false };
  const lastDay = cal.days[cal.days.length - 1];
  const today = localISODate(now);
  const MS_PER_DAY = 86400000;
  const daysLeft = Math.round(
    (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
  return { lastDay, daysLeft, warn: daysLeft <= warnDays };
}

export function missingTradingDays(cal, lastSettled, upTo) {
  if (!upTo || !covers(cal, upTo)) return [];
  if (!lastSettled) return cal.set.has(upTo) ? [upTo] : [];
  const between = tradingDaysBetween(cal, lastSettled, upTo);
  if (!between) return [];
  return between.filter((d) => d > lastSettled);
}
