// 定期定額計畫（PLAN §5）。
//
// 流程：
//   計畫（代號、每次金額、扣款日）
//     → 扣款日當天或之後第一次開 App，產生一筆 changes(kind:'dca', status:'pending')
//     → 使用者對照券商通知一鍵確認，或改成實際股數與成交價
//
// 兩條原則：
//   · 沒開 App 的月份會累積成多筆待確認，**不消失、不自動確認**。
//     自動確認等於幫使用者記一筆他沒對過的帳。
//   · 拿不到扣款日收盤價時，待確認還是要產生（扣款真的發生了），
//     只是股數留空並講明原因 —— 不要因為估不出股數就把這筆吞掉。

import * as db from './db.js';
import * as holdings from './holdings.js';
import * as catalog from './catalog.js';
import { toMicro, toNano, MICRO, NANO } from './money.js';
import { isTradingDay, tradingDaysBetween, covers } from './market.js';

// ---------- 純函式 ----------

/** 計畫的檢查。回錯誤字串，沒問題回 null。 */
/** 手續費率的上限（1%）。台股券商實際是 0.1425% 打折，超過就是把百分比當成比例填了。 */
export const MAX_FEE_RATE = 0.01;

export function validatePlan({ code, amount, days, feeRate }) {
  if (!code) return '請選擇股票代號';
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return '每次扣款金額要大於零';
  if (!Array.isArray(days) || days.length === 0) return '至少要有一個扣款日';
  if (days.some((d) => !Number.isInteger(Number(d)) || Number(d) < 1 || Number(d) > 31)) {
    return '扣款日要是 1 到 31 之間的整數';
  }
  if (new Set(days.map(Number)).size !== days.length) return '扣款日有重複';
  if (feeRate != null && feeRate !== '') {
    const f = Number(feeRate);
    if (!Number.isFinite(f) || f < 0) return '手續費率要是不小於零的數字（0.001425 代表 0.1425%）';
    // **單位陷阱。** 券商講的是「0.1425%」，欄位要的是比例 0.001425。
    // 直接把 0.1425 填進來會變成 14.25%，估出來的股數少一成四，
    // 而畫面上只會寫「手續費率 14.2500%」—— 看起來很正常，數字卻是錯的。
    // 台股券商實際費率是 0.1425% 打折後更低，不可能到 1%，所以超過就是填錯了。
    if (f > MAX_FEE_RATE) {
      return `手續費率 ${f} 代表 ${(f * 100).toFixed(4)}%，看起來是把百分比直接填進來了。`
        + `券商說的「0.1425%」要填 0.001425。`;
    }
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * 把「每月幾號」展開成實際的扣款日期。
 *
 * · 那個月沒有那一天（例如 2 月 31 日）→ 夾到當月最後一天，並標 clamped
 * · 那天不是交易日（週末、休市）→ 順延到**下一個交易日**，並標 movedFrom
 *   （各券商作法略有不同，但使用者本來就要對照通知確認，順延是最常見的）
 *
 * 回 [{ scheduled, date, clamped, movedFrom }]，依日期排序，範圍是 from < date <= to。
 */
export function dueOccurrences({ days, from, to, calendar }) {
  if (!to || !covers(calendar, to)) return [];
  const out = [];
  const start = new Date(`${(from ?? to).slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);

  for (let d = new Date(start); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    for (const raw of days) {
      const want = Number(raw);
      const last = daysInMonth(y, m);
      const clamped = want > last;
      const scheduled = `${y}-${pad2(m)}-${pad2(Math.min(want, last))}`;
      const moved = nextTradingDay(calendar, scheduled);
      if (!moved) continue;
      // 下界比對**排定日**，不是順延後的日期。
      // 比對順延後的日期會讓「8/6 排定、因為日曆缺八月而被順延到 9/1」這種情況
      // 混進九月的清單裡 —— 那是一筆根本不該產生的扣款。
      if (from && scheduled <= from) continue;
      // 上界比對順延後的日期：還沒到那個交易日就還沒扣款。
      if (moved > to) continue;
      out.push({
        scheduled,
        date: moved,
        clamped,
        movedFrom: moved === scheduled ? null : scheduled,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).filter((x, i, arr) =>
    i === 0 || arr[i - 1].date !== x.date);
}

// 台股最長的連續休市是農曆春節，2026 年是 2/12–2/22（前後交易日相隔 12 天）。
// 超過這個範圍還找不到交易日，代表日曆在那一段有缺口，不是放假 ——
// 這時候回 null 比回一個幾週後的日期好：後者會生出一筆日期完全錯的扣款。
const MAX_POSTPONE_DAYS = 20;

/** iso 當天或之後的第一個交易日；日曆沒涵蓋、或要跳超過 20 天，就回 null。 */
export function nextTradingDay(calendar, iso) {
  if (!covers(calendar, iso)) return null;
  if (isTradingDay(calendar, iso) === true) return iso;
  const next = calendar.days.find((d) => d > iso);
  if (!next) return null;
  const gap = (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400000;
  return gap <= MAX_POSTPONE_DAYS ? next : null;
}

/**
 * 估算一次扣款買到幾股。
 *   可用金額 = 金額 × (1 − 手續費率)
 *   股數     = floor(可用金額 ÷ 當日收盤)
 *   餘額     = 可用金額 − 股數 × 收盤
 *
 * 拿不到收盤價就回 shares: null —— 待確認還是會產生，只是股數留空。
 */
export function estimateDca({ amount, feeRate = 0, price }) {
  const amt = toMicro(amount);
  if (amt == null) return { shares: null, usableMicro: null, spentMicro: null, remainderMicro: null };
  // 手續費率有四到六位小數（0.001425 這種），全程整數運算。
  // 先用浮點算 amount × rate 再轉微元的話，5000 × 0.001425 可能得到 7.124999999999999。
  const rateNano = toNano(feeRate ?? 0);
  if (rateNano == null) return { shares: null, usableMicro: null, spentMicro: null, remainderMicro: null };
  const feeMicro = divRound(amt * rateNano, NANO);
  const usableMicro = amt - feeMicro;
  if (price == null) return { shares: null, usableMicro, spentMicro: null, remainderMicro: null };
  const p = toMicro(price);
  if (p == null || p <= 0n) return { shares: null, usableMicro, spentMicro: null, remainderMicro: null };
  const shares = Number(usableMicro / p);
  const spentMicro = BigInt(shares) * p;
  return { shares, usableMicro, spentMicro, remainderMicro: usableMicro - spentMicro };
}

function divRound(a, b) {
  const q = a / b;
  const r = a % b;
  return r * 2n >= b ? q + 1n : q;
}

export const dcaChangeId = (planId, date) => `dca:${planId}:${date}`;
export const reinvestChangeId = (eventId) => `rei:${eventId}`;

// ---------- 讀寫 ----------

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function list() {
  const rows = await db.getAll('plans');
  return rows
    .map((p) => {
      const info = catalog.lookup(p.code);
      return { ...p, name: info.found ? info.name : p.name, supported: info.found ? info.supported : false };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function get(id) { return db.get('plans', id); }

export async function save(plan) {
  const err = validatePlan(plan);
  if (err) throw new Error(err);
  const info = catalog.lookup(plan.code);
  if (!info.found) throw new Error(`找不到代號 ${plan.code}`);
  if (!info.supported) {
    throw new Error(`${info.code} ${info.name} 是${info.market}股票，這個版本拿不到它的收盤價，無法估算扣款股數`);
  }
  const row = {
    id: plan.id || newId(),
    code: info.code,
    name: info.name,
    amount: Number(plan.amount),
    days: [...new Set(plan.days.map(Number))].sort((a, b) => a - b),
    feeRate: plan.feeRate == null || plan.feeRate === '' ? 0 : Number(plan.feeRate),
    reinvestDividend: !!plan.reinvestDividend,
    active: plan.active !== false,
    startDate: plan.startDate ?? null,
    createdAt: plan.createdAt ?? new Date().toISOString(),
  };
  await db.put('plans', row);
  return row;
}

export async function remove(id) { await db.del('plans', id); }

export async function setActive(id, active) {
  const p = await get(id);
  if (!p) return null;
  const next = { ...p, active: !!active };
  await db.put('plans', next);
  return next;
}

/**
 * 「還缺收盤價的扣款日」清單，給更新流程決定要回補哪幾個月。
 *
 * 跳過三個月再開 App 的時候，那三個扣款日多半落在別的月份 ——
 * 光靠「缺漏的結算日」算出來的月份抓不到它們，三筆扣款就會全部估不出股數。
 *
 * 已經產生過的（不管確認了沒）不算：那筆的股數使用者已經看過或改過了，
 * 事後補價也不該回頭改它。
 */
export async function dueDatesNeedingPrices({ calendar, today }) {
  if (!calendar || !today) return [];
  const out = [];
  const seen = new Set();
  for (const plan of await list()) {
    if (!plan.active || !plan.supported) continue;
    const from = plan.startDate ?? String(plan.createdAt ?? '').slice(0, 10) ?? null;
    for (const occ of dueOccurrences({ days: plan.days, from, to: today, calendar })) {
      if (await db.get('changes', dcaChangeId(plan.id, occ.date))) continue;
      if (await db.get('closes', [plan.code, occ.date])) continue;
      const key = `${plan.code}|${occ.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code: plan.code, date: occ.date });
    }
  }
  return out;
}

/**
 * 產生待確認的扣款。
 *
 * 對每個啟用中的計畫，把「上次已經產生過的日期之後、到 today 為止」的扣款日展開，
 * 每一天產生一筆 pending 的 dca 變動。id 是 `dca:<計畫>:<日期>`，所以重跑不會長出重複的。
 * 已經存在的（不管確認了沒）一律不動。
 */
export async function generatePending({ calendar, today, plans: planList = null }) {
  if (!calendar || !today) return { created: [], skipped: [] };
  const all = planList ?? await list();
  const created = [];
  const skipped = [];

  for (const plan of all) {
    if (!plan.active || !plan.supported) continue;
    // 從計畫建立日（或指定的起始日）之前一天開始展開
    const from = plan.startDate ?? String(plan.createdAt ?? '').slice(0, 10) ?? null;
    const occurrences = dueOccurrences({ days: plan.days, from, to: today, calendar });

    for (const occ of occurrences) {
      const id = dcaChangeId(plan.id, occ.date);
      if (await db.get('changes', id)) continue;          // 已經產生過

      // 如果持股還沒建立，先建一筆（0 股）—— 不然變動沒有地方掛
      if (!await db.get('holdings', plan.code)) {
        await db.put('holdings', {
          code: plan.code, name: plan.name, market: '上市', supported: true,
          shares: 0, avgCost: null, costNote: null,
        });
      }

      const close = await db.get('closes', [plan.code, occ.date]);
      const est = estimateDca({ amount: plan.amount, feeRate: plan.feeRate, price: close?.close ?? null });

      const note = [
        `定期定額 ${plan.amount.toLocaleString('zh-Hant-TW')} 元`,
        occ.movedFrom ? `原扣款日 ${occ.movedFrom} 非交易日，順延` : null,
        occ.clamped ? '當月沒有這一天，改用月底' : null,
        est.shares == null ? '尚未取得當日收盤價，股數請填券商通知上的數字' : null,
      ].filter(Boolean).join('；');

      await db.put('changes', {
        id,
        code: plan.code,
        date: occ.date,
        deltaShares: est.shares,        // 可能是 null：扣款確實發生了，只是估不出股數
        // price 是「**成交價**」，留空。扣款日收盤價只是估算用的，放在 estimatePrice。
        // 把估算值直接當成交價的話，使用者按一下確認就等於記了一筆他沒有對過的成本，
        // 而平均成本會看起來很精確 —— 其實是我們猜的。
        price: null,
        estimatePrice: close?.close ?? null,
        kind: 'dca',
        note,
        status: 'pending',
        planId: plan.id,
        amount: plan.amount,
        estimate: {
          usable: est.usableMicro == null ? null : est.usableMicro.toString(),
          spent: est.spentMicro == null ? null : est.spentMicro.toString(),
          remainder: est.remainderMicro == null ? null : est.remainderMicro.toString(),
        },
      });
      created.push(id);
      if (est.shares == null) skipped.push(`${plan.code} ${occ.date}：尚未取得收盤價，股數留空`);
    }
  }
  return { created, skipped };
}

/**
 * 配息再投入：已確認的除權息事件 ＋ 該代號有開「配息再投入」的計畫
 * → 產生一筆 dividendReinvest 的待確認變動。
 * 股數用**除息日之後第一個交易日**的收盤價估（PLAN §4.3）。
 */
export async function generateReinvest({ calendar, today, events: eventList }) {
  if (!calendar || !today) return { created: [] };
  const plans = await list();
  const byCode = new Map(plans.filter((p) => p.active && p.reinvestDividend).map((p) => [p.code, p]));
  if (byCode.size === 0) return { created: [] };

  const created = [];
  for (const e of eventList) {
    if (e.status !== 'confirmed') continue;
    const plan = byCode.get(e.code);
    if (!plan) continue;
    const amountRaw = e.amountActual ?? e.amountEst ?? null;
    if (amountRaw == null) continue;

    const id = reinvestChangeId(e.id);
    if (await db.get('changes', id)) continue;

    // 除息日之後第一個交易日
    const after = (tradingDaysBetween(calendar, e.exDate, today) ?? []).filter((d) => d > e.exDate);
    const buyDate = after[0] ?? null;
    if (!buyDate) continue;                    // 還沒到下一個交易日，下次再說

    const close = await db.get('closes', [e.code, buyDate]);
    const amount = Number(BigInt(amountRaw)) / Number(MICRO);
    const est = estimateDca({ amount, feeRate: plan.feeRate, price: close?.close ?? null });

    await db.put('changes', {
      id,
      code: e.code,
      date: buyDate,
      deltaShares: est.shares,
      price: null,
      estimatePrice: close?.close ?? null,
      kind: 'dividendReinvest',
      note: `配息再投入 ${Math.round(amount).toLocaleString('zh-Hant-TW')} 元（${e.exDate} 除息）` +
        (est.shares == null ? '；尚未取得當日收盤價，股數請填券商通知上的數字' : ''),
      status: 'pending',
      planId: plan.id,
      eventId: e.id,
      amount,
      estimate: {
        usable: est.usableMicro == null ? null : est.usableMicro.toString(),
        spent: est.spentMicro == null ? null : est.spentMicro.toString(),
        remainder: est.remainderMicro == null ? null : est.remainderMicro.toString(),
      },
    });
    created.push(id);
  }
  return { created };
}

/** 所有待確認的持股變動（定期定額、配息再投入、手動），依日期排序。 */
export async function pendingChanges() {
  return holdings.pendingOf(await db.getAll('changes'));
}
