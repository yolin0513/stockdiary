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
import * as events from './events.js';
import * as plans from './plans.js';
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
  const planList = await plans.list();
  // 只設了定期定額計畫、還沒有任何持股，也要跑 —— 那正是「我要開始定期定額」的第一天。
  if (held.length === 0 && planList.length === 0) {
    return { status: STATUS.NO_HOLDINGS, settled: [], message: '還沒有持股，也還沒有定期定額計畫' };
  }
  if (!calendar) return { status: STATUS.NO_CALENDAR, settled: [], message: '尚未取得開休市日，無法判斷交易日' };

  const expected = latestPublishedTradingDay(calendar, now, threshold);
  if (!expected) {
    return { status: STATUS.NO_CALENDAR, settled: [], message: `開休市日只涵蓋 ${calendar.year} 年，今天不在範圍內` };
  }

  const lastSettled = await lastSettledDate();
  const missing = missingTradingDays(calendar, lastSettled, expected);
  const pendingToday = todayPending(calendar, now, threshold);

  // 要抓價的代號＝持股 ∪ 啟用中的計畫（計畫的標的可能還不在持股裡）
  const supportedCodes = [...new Set([
    ...held.filter((h) => h.supported).map((h) => h.code),
    ...planList.filter((p) => p.active && p.supported).map((p) => p.code),
  ])];
  const settled = [];
  const problems = [];

  // 除權息日曆**每次開頁都更新**（PLAN §2.2 第 4 點），不是只有要結算的時候。
  // 放在結算之前，除權息日的參考價才來得及進到 quotes 裡。
  // 只有兩個請求，對 30 個的額度沒有壓力。
  await syncDividendEvents({ client, held, today: expected, problems });

  // 還缺收盤價的扣款日。跳過三個月再開 App 的話，那三個扣款日多半在別的月份，
  // 光靠「缺漏的結算日」算出來的月份是抓不到的 —— 要一起併進回補清單。
  const dcaNeeds = await plans.dueDatesNeedingPrices({ calendar, today: expected });

  if (missing.length === 0 && dcaNeeds.length === 0) {
    await generateDcaPending({ calendar, today: expected, problems });
    return {
      status: pendingToday ? STATUS.TODAY_PENDING : STATUS.UP_TO_DATE,
      settled: [],
      lastSettled,
      expected,
      problems: problems.length ? problems : undefined,
      pendingEvents: (await events.pending()).length,
      message: pendingToday
        ? `今日收盤尚未公布（最後結算：${lastSettled ?? '無'}）`
        : `已結算到 ${expected}`,
    };
  }

  // ---- 只缺「最新那一天」、而且沒有別的日子要補價：一個請求拿全市場 ----
  if (missing.length === 1 && missing[0] === expected && dcaNeeds.every((d) => d.date === expected)) {
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
    await generateDcaPending({ calendar, today: expected, problems });
    const r = await settleOneDay({ date: expected, held, calendar, dayAllQuotes: dayAll.quotes, includeDividend });
    settled.push(r.date);
    onProgress({ done: 1, total: 1, label: '完成' });
    return {
      status: STATUS.SETTLED, settled, expected, result: r.result,
      problems: problems.length ? problems : undefined,
      pendingEvents: (await events.pending()).length,
      message: `已結算 ${expected}`,
    };
  }

  // ---- 缺多天：每檔抓需要的月份 ----
  // 月份＝缺漏的結算日 ∪ 還缺收盤價的扣款日。
  // 少了後者的話，「跳過三個月再開 App」那三筆扣款會因為估不出股數而全部留白。
  const months = [...new Set(missing.map(prices.monthOf))];
  const jobs = [];
  for (const code of supportedCodes) for (const month of months) jobs.push({ code, month });
  for (const need of dcaNeeds) {
    const month = prices.monthOf(need.date);
    if (!jobs.some((j) => j.code === need.code && j.month === month)) {
      jobs.push({ code: need.code, month });
    }
  }
  jobs.sort((a, b) => a.month.localeCompare(b.month) || a.code.localeCompare(b.code));

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

  await generateDcaPending({ calendar, today: expected, problems });

  for (const date of missing) {
    const r = await settleOneDay({ date, held, calendar, dayAllQuotes: null, includeDividend });
    if (r.result.counted > 0 || r.result.total === r.result.excludedUnsupported) settled.push(r.date);
    else problems.push(`${date}：沒有取得任何收盤價`);
  }

  onProgress({ done: jobs.length, total: jobs.length, label: '完成' });
  return {
    status: problems.length ? STATUS.PARTIAL : (settled.length ? STATUS.SETTLED : STATUS.UP_TO_DATE),
    settled,
    expected,
    problems,
    pendingEvents: (await events.pending()).length,
    message: problems.length
      ? `補了 ${settled.length} 天，${problems.length} 項沒補到`
      : `補了 ${settled.length} 天，已結算到 ${expected}`,
  };
}

/**
 * 更新除權息事件：TWT48U 建未來事件與日曆，TWT49U 補參考價。
 *
 * 這兩個請求失敗不該讓整次更新失敗 —— 收盤價才是主線。抓不到就把原因記進
 * problems，畫面上說「除權息資料尚未取得」，不會因此少算或亂算當日損益
 * （沒有參考價的除權息日，settle.js 會標 exNoRef 而不是硬拿前收當基準）。
 */
async function syncDividendEvents({ client, held, today, problems }) {
  if (!held.some((h) => h.supported)) return;

  try {
    const forecast = await prices.fetchTwt48u(client);
    if (forecast.ok) await events.syncForecast(forecast.rows, { held, today });
    else problems.push(`除權息預告表：${forecast.message}`);
  } catch (e) {
    problems.push(`除權息預告表：${describeError(e)}`);
    if (e && e.name === 'BudgetExceededError') return;
  }

  try {
    // TWT49U 的日期參數實測無效，它永遠回「最近一次」的結果。
    // 參數照帶，但拿到什麼就用什麼 —— 只有持股裡有、日期也對得上的才會被採用。
    const result = await prices.fetchTwt49u(client, today, today);
    if (result.ok) await events.applyResults(result.rows, { held });
    else problems.push(`除權息結果表：${result.message}`);
  } catch (e) {
    problems.push(`除權息結果表：${describeError(e)}`);
  }
}

/**
 * 產生定期定額與配息再投入的待確認變動。
 * 兩者都是「先產生、等使用者對照券商通知確認」——**不會自動確認**，
 * 因為自動確認等於幫使用者記一筆他沒對過的帳。
 */
async function generateDcaPending({ calendar, today, problems }) {
  try {
    const r = await plans.generatePending({ calendar, today });
    for (const s of r.skipped) problems.push(s);
  } catch (e) {
    problems.push(`定期定額：${describeError(e)}`);
  }
  try {
    await plans.generateReinvest({ calendar, today, events: await events.all() });
  } catch (e) {
    problems.push(`配息再投入：${describeError(e)}`);
  }
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

  // 這一天有除權息的，基準價要改用參考價（settle.basisFor 只認參考價，拿不到就不算）。
  const extras = await events.quoteExtrasFor({ codes, date, prevDate });
  for (const [code, extra] of Object.entries(extras)) {
    quotes[code] = { ...(quotes[code] ?? {}), ...extra };
  }

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

/**
 * 最後一次**真的算出東西**的結算日。全部都是 null 的「結算」不算結算過 ——
 * 回 null 的話下次開頁會再試一次那一天（例如在等除權息參考價出來）。
 */
export async function lastSettledDate() {
  const rows = await db.getAll('settle');
  const useful = rows.filter((r) => r.counted > 0);
  if (!useful.length) return null;
  return useful.map((r) => r.date).sort().at(-1);
}

/**
 * 最後一筆結算紀錄，**不管算不算得出東西**。
 *
 * 畫面要用這個而不是 lastSettledDate()：一檔都算不出來的那天（例如唯一的持股
 * 剛好除權息、參考價還沒出來）也有一筆紀錄，裡面寫著每一檔卡在哪裡。
 * 用 lastSettledDate() 的話畫面會整片空白，使用者不知道發生什麼事。
 */
export async function latestSettleRecord() {
  const rows = await db.getAll('settle');
  if (!rows.length) return null;
  const date = rows.map((r) => r.date).sort().at(-1);
  return loadSettle(date);
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
