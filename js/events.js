// 除權息事件：從 TWT48U 建立、用 TWT49U 補參考價、使用者確認後計入已領股利。
//
// 事件的 id 是「代號-除權息日」。每次開頁都會重抓 TWT48U，用自然鍵才不會一直長出重複的
// 事件；而且**已經確認過的事件不會被重抓的資料蓋掉**（使用者改過的實收金額要留著）。
//
// 狀態流轉（PLAN §4）：
//   upcoming  → 日曆上的未來事件
//   pending   → 除權息日已經過了，等使用者對照券商通知確認
//   confirmed → 已確認，計入累積已領股利；配股的話同時產生一筆 stockDividend 變動
//   dismissed → 使用者說「這筆我沒有」（例如除權息日前就賣掉了）

import * as db from './db.js';
import * as holdings from './holdings.js';
import { dividendAmount, stockDividendShares, dividendSummary, KIND_LABEL } from './dividend.js';

export const STATUS = { UPCOMING: 'upcoming', PENDING: 'pending', CONFIRMED: 'confirmed', DISMISSED: 'dismissed' };
export { KIND_LABEL };

export const eventId = (code, exDate) => `${code}-${exDate}`;

export async function all() {
  return db.getAll('events');
}

export async function get(id) {
  return db.get('events', id);
}

/** 未來的事件（日曆頁用），依日期排序。 */
export async function upcoming() {
  return (await all()).filter((e) => e.status === STATUS.UPCOMING).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

/** 等待確認的事件（首頁頂部提示用）。 */
export async function pending() {
  return (await all()).filter((e) => e.status === STATUS.PENDING).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

export async function confirmed() {
  return (await all()).filter((e) => e.status === STATUS.CONFIRMED).sort((a, b) => b.exDate.localeCompare(a.exDate));
}

/**
 * 用 TWT48U 的預告表更新事件。
 * 只處理**持股裡有的**代號（不支援報價的上櫃／興櫃沒有除權息資料，直接跳過）。
 *
 * 已確認（confirmed）與已忽略（dismissed）的事件不動。
 */
export async function syncForecast(rows, { held, today }) {
  const heldByCode = new Map(held.filter((h) => h.supported).map((h) => [h.code, h]));
  const existing = new Map((await all()).map((e) => [e.id, e]));
  const written = [];

  for (const r of rows) {
    const hd = heldByCode.get(r.code);
    if (!hd) continue;
    const id = eventId(r.code, r.exDate);
    const prev = existing.get(id);


    // 已確認或已忽略的事件不動。每次開頁都會重抓預告表，沒有這一行的話，
    // 使用者對過對帳單填進去的實收金額會被自動更新洗掉。
    if (prev && (prev.status === STATUS.CONFIRMED || prev.status === STATUS.DISMISSED)) continue;

    const shares = holdings.sharesOn(await holdings.changesOf(r.code), r.exDate);
    const next = {
      ...(prev ?? {}),
      id,
      code: r.code,
      name: hd.name || r.name,
      exDate: r.exDate,
      kind: r.kind,
      cashPerShare: r.cashPerShare,
      stockRate: r.stockRate,
      rightsRate: r.rightsRate,
      rightsPrice: r.rightsPrice,
      sharesHeld: shares,
      // 預估金額每次都重算 —— 股數可能因為新的變動而改變
      amountEst: estimateMicro({ shares, cashPerShare: r.cashPerShare }),
      refPrice: prev?.refPrice ?? null,
      prevClose: prev?.prevClose ?? null,
      exValue: prev?.exValue ?? null,
      amountActual: prev?.amountActual ?? null,
      status: r.exDate <= today ? STATUS.PENDING : STATUS.UPCOMING,
    };
    await db.put('events', next);
    written.push(next);
  }
  return written;
}

function estimateMicro({ shares, cashPerShare }) {
  if (!shares || cashPerShare == null || cashPerShare <= 0) return null;
  const { grossMicro } = dividendAmount({ shares, cashPerShare, autoFees: false });
  return grossMicro == null ? null : grossMicro.toString();
}

/**
 * 用 TWT49U 的計算結果表補上參考價。
 * 參考價是除權息日當日損益的比較基準（settle.basisFor），拿不到就不會硬算。
 *
 * TWT49U 只給得到「最近一次」的結果（strDate／endDate 參數實測無效），
 * 所以這支只在事件當天或隔天開 App 時補得到 —— 補到就存起來，之後都用存下來的。
 */
export async function applyResults(rows, { held }) {
  const heldCodes = new Set(held.filter((h) => h.supported).map((h) => h.code));
  const existing = new Map((await all()).map((e) => [e.id, e]));
  const applied = [];

  for (const r of rows) {
    if (!heldCodes.has(r.code)) continue;
    const id = eventId(r.code, r.date);
    const prev = existing.get(id);
    // 預告表沒抓到、但結果表有（例如使用者剛加進持股）—— 也要建起來
    const base = prev ?? {
      id, code: r.code, name: r.name, exDate: r.date, kind: r.kind,
      cashPerShare: null, stockRate: null, rightsRate: 0, rightsPrice: 0,
      sharesHeld: holdings.sharesOn(await holdings.changesOf(r.code), r.date),
      amountEst: null, amountActual: null, status: STATUS.PENDING,
    };
    if (base.status === STATUS.DISMISSED) continue;
    const next = {
      ...base,
      refPrice: r.refPrice,
      prevClose: r.prevClose,
      exValue: r.exValue,
      kind: base.kind ?? r.kind,
      status: base.status === STATUS.CONFIRMED ? STATUS.CONFIRMED : STATUS.PENDING,
    };
    await db.put('events', next);
    applied.push(next);
  }
  return applied;
}

/** 某一天、某些代號的除權息報價資訊，餵給 settle.settleDay。 */
export async function quoteExtrasFor({ codes, date }) {
  const out = {};
  const list = await all();
  for (const code of codes) {
    const e = list.find((x) => x.code === code && x.exDate === date && x.status !== STATUS.DISMISSED);
    if (!e) continue;
    out[code] = {
      exDay: true,
      refPrice: e.refPrice ?? null,
      // 除息當天的股利是「**應收**」——錢還沒入帳，但權利已經是你的了，
      // 所以不必等使用者確認就計入當日損益（PLAN §4 的當日損益公式）。
      // 金額還沒公告（cashPerShare 為 null）時就是算不出來，不會補一個 0 進去。
      cashPerShare: e.cashPerShare ?? null,
    };
  }
  return out;
}

/**
 * 確認一筆事件。
 *   amountActual  使用者改過的實收金額（元）。沒給就用預估值。
 *   autoFees      要不要套用「匯費 10 元 ＋ 單筆 2 萬以上扣 2.11%」
 * 配股的事件確認後會產生一筆 stockDividend 的持股變動。
 */
export async function confirm(id, { amountActual = null, autoFees = false } = {}) {
  const e = await get(id);
  if (!e) throw new Error('找不到這筆除權息事件');
  if (e.status === STATUS.CONFIRMED) return e;

  let amountMicro = null;
  if (amountActual != null && String(amountActual).trim() !== '') {
    const v = Number(String(amountActual).replace(/,/g, '').trim());
    if (!Number.isFinite(v) || v < 0) throw new Error('實收金額要是不小於零的數字');
    amountMicro = BigInt(Math.round(v * 1e6));
  } else if (e.cashPerShare != null && e.sharesHeld) {
    const { netMicro } = dividendAmount({ shares: e.sharesHeld, cashPerShare: e.cashPerShare, autoFees });
    amountMicro = netMicro;
  }

  let changeId = e.changeId ?? null;
  if ((e.kind === 'stock' || e.kind === 'both') && e.stockRate > 0 && e.sharesHeld && !changeId) {
    const { wholeShares } = stockDividendShares({ shares: e.sharesHeld, stockRate: e.stockRate });
    if (wholeShares > 0) {
      changeId = await holdings.addChange({
        code: e.code,
        date: e.exDate,
        deltaShares: wholeShares,
        kind: 'stockDividend',
        note: `${KIND_LABEL[e.kind]}配股（每仟股 ${(e.stockRate * 1000).toFixed(2)} 股）`,
        status: 'confirmed',
      });
    }
  }

  const next = {
    ...e,
    amountActual: amountMicro == null ? null : amountMicro.toString(),
    autoFeesApplied: amountActual == null ? autoFees : false,
    changeId,
    status: STATUS.CONFIRMED,
    confirmedAt: new Date().toISOString(),
  };
  await db.put('events', next);
  return next;
}

export async function dismiss(id) {
  const e = await get(id);
  if (!e) return null;
  const next = { ...e, status: STATUS.DISMISSED, amountActual: null };
  await db.put('events', next);
  return next;
}

/** 取消確認（使用者發現填錯了）。有配股的話一併把那筆變動刪掉。 */
export async function unconfirm(id) {
  const e = await get(id);
  if (!e) return null;
  if (e.changeId) await holdings.deleteChange(e.changeId);
  const next = { ...e, status: STATUS.PENDING, amountActual: null, changeId: null, confirmedAt: null };
  await db.put('events', next);
  return next;
}

/** 累積已領股利（總計、年度、每檔）。 */
export async function summary({ year = new Date().getFullYear() } = {}) {
  return dividendSummary(await all(), { year });
}
