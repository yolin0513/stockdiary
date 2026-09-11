// 開頁自動更新一次（PLAN §2.2）。
//
// 判斷「今天的收盤公布了沒」有兩道：
//   1. 時間門檻（settings.todayDataThreshold）—— 只是用來**省下一次註定拿到昨天的請求**
//   2. STOCK_DAY_ALL 回應裡的日期 —— 這才是真正的判準。那支端點沒有日期參數，
//      永遠回「最新已公布的那一天」，所以拿到之後一定要核對。
//
// 缺漏日的回補一律走 STOCK_DAY（個股當月逐日），每檔每月一個請求、同月只抓一次。
//
// 這支的每一條分支都回一個明確的 status，畫面照著講實話，不編數字。

import * as db from './db.js';
import * as holdings from './holdings.js';
import * as prices from './prices.js';
import { settleDay } from './settle.js';
import { missingTradingDays, prevTradingDay, latestPublishedTradingDay, todayPending } from './market.js';
import { localISODate } from './roc.js';

export const STATUS = {
  NO_HOLDINGS: 'noHoldings',
  NO_CALENDAR: 'noCalendar',
  UP_TO_DATE: 'upToDate',
  TODAY_PENDING: 'todayPending',
  SETTLED: 'settled',
  PARTIAL: 'partial',
  FAILED: 'failed',
};

/**
 * 跑一次更新。
 *
 * client    twseclient.createClient() 的實例
 * calendar  market.makeCalendar() 的結果
 * now       Date
 * threshold 'HH:MM'
 * onProgress({ done, total, label })
 */
export async function runUpdate({ client, calendar, now = new Date(), threshold, includeDividend = true, onProgress = () => {} } = {}) {
  const held = await holdings.list();
  if (held.length === 0) return { status: STATUS.NO_HOLDINGS, settled: [], message: '還沒有持股' };
  if (!calendar) return { status: STATUS.NO_CALENDAR, settled: [], message: '尚未取得開休市日，無法判斷交易日' };

  const expected = latestPublishedTradingDay(calendar, now, threshold);
  if (!expected) {
    return { status: STATUS.NO_CALENDAR, settled: [], message: `開休市日只涵蓋 ${calendar.year} 年，今天不在範圍內` };
  }

  const lastSettled = await lastSettledDate();
  const missing = missingTradingDays(calendar, lastSettled, expected);
  const pendingToday = todayPending(calendar, now, threshold);

  if (missing.length === 0) {
    return {
      status: pendingToday ? STATUS.TODAY_PENDING : STATUS.UP_TO_DATE,
      settled: [],
      lastSettled,
      expected,
      message: pendingToday
        ? `今日收盤尚未公布（最後結算：${lastSettled ?? '無'}）`
        : `已結算到 ${expected}`,
    };
  }

  const supportedCodes = held.filter((h) => h.supported).map((h) => h.code);
  const settled = [];
  const problems = [];

  // ---- 只缺「最新那一天」：一個請求拿全市場 ----
  if (missing.length === 1 && missing[0] === expected) {
    onProgress({ done: 0, total: 1, label: '取得今日收盤' });
    let dayAll;
    try {
      dayAll = await prices.fetchDayAll(client);
    } catch (e) {
      return { status: STATUS.FAILED, settled: [], expected, message: describeError(e) };
    }
    if (dayAll.date !== expected) {
      // 端點回的是別天 —— 最常見的情況就是今天的還沒出來。
      // 這時候**什麼都不寫**，畫面顯示上一次的結算日期。
      return {
        status: STATUS.TODAY_PENDING,
        settled: [],
        lastSettled,
        expected,
        actualDate: dayAll.date,
        message: `今日收盤尚未公布（證交所目前最新是 ${dayAll.date}）`,
      };
    }
    await saveDayAllCloses(dayAll, supportedCodes);
    const r = await settleOneDay({ date: expected, held, calendar, dayAllQuotes: dayAll.quotes, includeDividend });
    settled.push(r.date);
    onProgress({ done: 1, total: 1, label: '完成' });
    return { status: STATUS.SETTLED, settled, expected, result: r.result, message: `已結算 ${expected}` };
  }

  // ---- 缺多天：每檔持股抓需要的月份 ----
  const months = [...new Set(missing.map(prices.monthOf))];
  const jobs = [];
  for (const code of supportedCodes) for (const month of months) jobs.push({ code, month });

  let done = 0;
  for (const job of jobs) {
    onProgress({ done, total: jobs.length, label: `回補 ${job.code} ${job.month}` });
    try {
      await prices.fetchMonth(client, job.code, `${job.month}-01`, { today: localISODate(now) });
    } catch (e) {
      problems.push(`${job.code} ${job.month}：${describeError(e)}`);
      if (e && e.name === 'BudgetExceededError') break;
    }
    done += 1;
  }

  for (const date of missing) {
    const r = await settleOneDay({ date, held, calendar, dayAllQuotes: null, includeDividend });
    if (r.result.counted > 0 || r.result.total === r.result.excludedUnsupported) settled.push(r.date);
    else problems.push(`${date}：沒有取得任何收盤價`);
  }

  onProgress({ done: jobs.length, total: jobs.length, label: '完成' });
  return {
    status: problems.length ? STATUS.PARTIAL : STATUS.SETTLED,
    settled,
    expected,
    problems,
    message: problems.length
      ? `補了 ${settled.length} 天，${problems.length} 項沒補到`
      : `補了 ${settled.length} 天，已結算到 ${expected}`,
  };
}

async function saveDayAllCloses(dayAll, codes) {
  const items = [];
  for (const code of codes) {
    const q = dayAll.quotes[code];
    if (!q || q.close == null) continue;
    items.push({ code, date: dayAll.date, close: q.close, change: q.change, exMark: false });
  }
  if (items.length) await db.putAll('closes', items);
}

/** 結算某一天並寫進 settle store。持股數用「那一天的」，不是今天的。 */
export async function settleOneDay({ date, held, calendar, dayAllQuotes = null, includeDividend = true }) {
  const prevDate = prevTradingDay(calendar, date);
  const codes = held.map((h) => h.code);
  const quotes = await prices.buildQuotes({ codes, date, prevDate, dayAllQuotes });

  // 那一天手上有幾股 —— 用變動紀錄回推，不能用現在的股數
  const asOf = [];
  for (const h of held) {
    const chs = await holdings.changesOf(h.code);
    const shares = holdings.sharesOn(chs, date);
    if (shares === 0) continue;
    asOf.push({ ...h, shares });
  }

  const result = settleDay({ date, holdings: asOf, quotes, includeDividend });
  await db.put('settle', {
    date,
    dayPL: result.dayPLMicro == null ? null : result.dayPLMicro.toString(),
    marketValue: result.marketValueMicro == null ? null : result.marketValueMicro.toString(),
    dividend: result.dividendMicro == null ? null : result.dividendMicro.toString(),
    counted: result.counted,
    excludedUnsupported: result.excludedUnsupported,
    excludedMissing: result.excludedMissing,
    byCode: result.byCode.map((r) => ({
      code: r.code, shares: r.shares, close: r.close, basis: r.basis,
      basisSource: r.basisSource, status: r.status,
      pl: r.plMicro == null ? null : r.plMicro.toString(),
    })),
    settledAt: new Date().toISOString(),
  });
  return { date, result };
}

export async function lastSettledDate() {
  const rows = await db.getAll('settle');
  // 只認真的算出東西的那幾天。全部都是 null 的「結算」不算結算過。
  const useful = rows.filter((r) => r.counted > 0);
  if (!useful.length) return null;
  return useful.map((r) => r.date).sort().at(-1);
}

export async function loadSettle(date) {
  const row = await db.get('settle', date);
  if (!row) return null;
  return {
    ...row,
    dayPLMicro: row.dayPL == null ? null : BigInt(row.dayPL),
    marketValueMicro: row.marketValue == null ? null : BigInt(row.marketValue),
    dividendMicro: row.dividend == null ? null : BigInt(row.dividend),
  };
}

function describeError(e) {
  if (!e) return '未知錯誤';
  if (e.name === 'BudgetExceededError') return e.message;
  if (e.name === 'TimeoutError' || /timeout/i.test(String(e.message))) return '連線逾時';
  if (/Failed to fetch|NetworkError/i.test(String(e.message))) return '連不上證交所（可能是離線）';
  return String(e.message || e);
}
