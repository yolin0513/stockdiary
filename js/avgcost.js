// 平均成本的更新。純函式。
//
// 成本法用**平均成本法**（與台灣券商庫存頁一致，使用者對得起來；
// FEASIBILITY §5：FIFO 對台股個人投資人沒有稅務意義，不做）。
//
// 四條規則：
//   1. 賣出不改均價 —— 平均成本法就是這樣，賣掉一部分不影響每股成本
//   2. 買進**沒有填成交價**就不改均價，並在畫面上說「成本未含 N 次沒填成交價的買進」
//      （猜一個價格比不算還糟：使用者會以為那個報酬率是真的）
//   3. 配股（stockDividend）**總成本不變、股數變多** → 每股成本下降
//   4. 原本就沒有均價（使用者沒填）時，只有在「原本 0 股」才會用新買進的價格當均價；
//      已經有部位卻沒有成本基礎的話，不能拿一筆新的去推算整個部位

import { toMicro, mulSharesPrecise, MICRO } from './money.js';

export const REASON = {
  FIRST: 'first',                   // 第一次有成本
  WEIGHTED: 'weighted',             // 加權平均
  STOCK_DIVIDEND: 'stockDividend',  // 配股稀釋
  UNCHANGED_SELL: 'sell',           // 賣出，不動
  UNCHANGED_NO_PRICE: 'noPrice',    // 沒填成交價，不動
  UNCHANGED_NO_BASE: 'noBase',      // 原本就沒有均價可以加權
  UNCHANGED: 'unchanged',
};

/**
 * 一筆變動之後的平均成本。
 *
 * oldAvg    目前的平均成本（元／股），沒填就是 null
 * oldShares 變動前的股數
 * delta     這筆變動的股數（買進為正、賣出為負）
 * price     這筆變動的成交價（元／股），沒填就是 null
 * kind      變動類型（stockDividend 有自己的算法）
 *
 * 回 { avgCost, reason }。avgCost 為 null 代表「仍然沒有平均成本」。
 */
export function avgCostAfter({ oldAvg = null, oldShares = 0, delta = 0, price = null, kind = 'manual' } = {}) {
  const d = Number(delta) || 0;
  if (d === 0) return { avgCost: oldAvg, reason: REASON.UNCHANGED };

  if (kind === 'stockDividend') {
    // 配股：總成本不變、股數變多 → 每股成本下降
    if (oldAvg == null || oldShares <= 0) return { avgCost: oldAvg, reason: REASON.UNCHANGED_NO_BASE };
    const totalCost = mulSharesPrecise(oldShares, oldAvg);
    const newShares = oldShares + d;
    if (newShares <= 0) return { avgCost: oldAvg, reason: REASON.UNCHANGED };
    return { avgCost: divToNumber(totalCost, newShares), reason: REASON.STOCK_DIVIDEND };
  }

  if (d < 0) return { avgCost: oldAvg, reason: REASON.UNCHANGED_SELL };

  if (price == null || price === '') return { avgCost: oldAvg, reason: REASON.UNCHANGED_NO_PRICE };
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) return { avgCost: oldAvg, reason: REASON.UNCHANGED_NO_PRICE };

  if (oldAvg == null) {
    // 原本沒有均價：只有「原本 0 股」時才能直接用這一筆的價格。
    // 已經有部位卻沒填成本的話，拿新的一筆去推算整個部位會得到一個完全錯的報酬率。
    if (oldShares > 0) return { avgCost: null, reason: REASON.UNCHANGED_NO_BASE };
    return { avgCost: round6(p), reason: REASON.FIRST };
  }

  // 加權平均：(舊均價 × 舊股數 ＋ 價 × 新股數) ÷ 新股數
  const totalCost = mulSharesPrecise(oldShares, oldAvg) + mulSharesPrecise(d, p);
  const newShares = oldShares + d;
  return { avgCost: divToNumber(totalCost, newShares), reason: REASON.WEIGHTED };
}

/** 微元總成本 ÷ 股數 → 每股成本（元），保留到小數第六位。 */
function divToNumber(totalMicro, shares) {
  if (totalMicro == null || !shares) return null;
  const per = (totalMicro * 1000n) / BigInt(Math.round(shares));   // 1e-9 元
  return Number(per) / 1e9;
}

function round6(p) {
  const m = toMicro(p);
  return m == null ? null : Number(m) / Number(MICRO);
}

/**
 * 「這個平均成本少算了什麼」的說明。全部都有填成交價就回 null。
 * 從變動紀錄推導，不另外存狀態。
 */
export function costNote(changes) {
  const n = changes.filter((c) =>
    c.status === 'confirmed' &&
    Number(c.deltaShares) > 0 &&
    (c.price == null || c.price === '') &&
    c.kind !== 'opening' &&
    c.kind !== 'stockDividend').length;
  return n ? `平均成本未含 ${n} 次沒有填成交價的買進` : null;
}

/** 從頭把整條變動紀錄跑一遍，算出目前的平均成本。opening 的均價由使用者直接填。 */
export function avgCostFromChanges(changes, { openingAvg = null } = {}) {
  const sorted = [...changes]
    .filter((c) => c.status === 'confirmed')
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));

  let avg = null;
  let shares = 0;
  for (const c of sorted) {
    const d = Number(c.deltaShares) || 0;
    if (c.kind === 'opening') {
      avg = openingAvg;
      shares += d;
      continue;
    }
    const r = avgCostAfter({ oldAvg: avg, oldShares: shares, delta: d, price: c.price ?? null, kind: c.kind });
    avg = r.avgCost;
    shares += d;
  }
  return { avgCost: avg, shares };
}
