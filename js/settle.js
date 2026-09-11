// 每日結算。**純函式**：日期、持股、報價全部由參數傳進來，不碰 DB、不發請求。
// 這樣才能用手算過的固定案例測，而且測得動「除權息日」「休市日」「部分不支援」這些邊界。
//
// 三條規則，每一條都對應 STATUS「接手者最容易做錯的事」：
//
//   1. 除權息日的基準價只認**除權息參考價**，拿不到就回 null，**絕不退回前一日收盤**。
//      退回去的話，除息日會生出一筆等於息值的假虧損。（第 1 條）
//   2. 不支援報價的持股（上櫃／興櫃）不參與任何計算，也不進總和；
//      它們的數量要單獨回報，讓畫面標「不含 N 檔」。（第 2 條）
//   3. 算不出來就回 **null**，不回 0。一檔都算不出來時，當日損益是 null。（第 5 條）

import { toMicro, mulShares, sumMicro } from './money.js';

/**
 * 當日損益的比較基準。
 *
 * 優先序：
 *   除權息日 → 只認 refPrice（除權息參考價）。拿不到就是 null。
 *   一般日   → 前一交易日收盤；沒有的話用「今收 − 漲跌價差」倒推。
 *
 * 回 { basis, source }；source ∈ refPrice / prevClose / derived / none。
 */
export function basisFor({ exDay = false, refPrice = null, prevClose = null, close = null, change = null } = {}) {
  if (exDay) {
    // 這裡刻意沒有 fallback。除權息日用前一日收盤當基準 = 把整筆股利算成虧損。
    return refPrice == null ? { basis: null, source: 'none' } : { basis: refPrice, source: 'refPrice' };
  }
  if (prevClose != null) return { basis: prevClose, source: 'prevClose' };
  if (change != null && close != null) return { basis: close - change, source: 'derived' };
  return { basis: null, source: 'none' };
}

/**
 * 結算某一天。
 *
 * holdings: [{ code, name, shares, avgCost?, supported }]
 * quotes:   { [code]: { close, change?, prevClose?, exDay?, refPrice?, cashPerShare? } }
 *
 * 回傳的金額全部是 BigInt 微元（或 null）。
 */
export function settleDay({ date, holdings = [], quotes = {}, includeDividend = true } = {}) {
  const byCode = [];
  let excludedUnsupported = 0;
  let excludedMissing = 0;
  let counted = 0;

  const plParts = [];
  const valueParts = [];
  const dividendParts = [];

  for (const hd of holdings) {
    const q = quotes[hd.code] || {};
    const row = {
      code: hd.code,
      name: hd.name,
      shares: hd.shares,
      close: null,
      basis: null,
      basisSource: 'none',
      plMicro: null,
      valueMicro: null,
      dividendMicro: null,
      status: 'ok',
    };

    if (!hd.supported) {
      // 不支援報價：連 close 都不要填進去，畫面上就沒有任何數字可以誤顯示。
      row.status = 'unsupported';
      excludedUnsupported += 1;
      byCode.push(row);
      continue;
    }

    const close = q.close ?? null;
    if (close == null) {
      row.status = 'noClose';
      excludedMissing += 1;
      byCode.push(row);
      continue;
    }
    row.close = close;
    row.valueMicro = mulShares(hd.shares, toMicro(close));
    valueParts.push(row.valueMicro);

    const { basis, source } = basisFor({
      exDay: !!q.exDay,
      refPrice: q.refPrice ?? null,
      prevClose: q.prevClose ?? null,
      close,
      change: q.change ?? null,
    });
    row.basis = basis;
    row.basisSource = source;

    if (basis == null) {
      row.status = q.exDay ? 'exNoRef' : 'noBasis';
      excludedMissing += 1;
      byCode.push(row);
      continue;
    }

    const diffMicro = toMicro(close) - toMicro(basis);
    row.plMicro = mulShares(hd.shares, diffMicro);
    plParts.push(row.plMicro);

    if (q.cashPerShare != null) {
      // 股利金額**一律算出來**；includeDividend 只決定要不要加進當日損益。
      // 關掉開關時畫面仍要能說「當日應收股利 X 元（未計入）」。
      row.dividendMicro = mulShares(hd.shares, toMicro(q.cashPerShare));
      dividendParts.push(row.dividendMicro);
    }

    counted += 1;
    byCode.push(row);
  }

  const dividendMicro = dividendParts.length ? sumMicro(dividendParts) : null;
  // 一檔都算不出來 → 當日損益是「不知道」，不是 0。
  const priceMicro = counted > 0 ? sumMicro(plParts) : null;
  const dayPLMicro = priceMicro == null
    ? null
    : priceMicro + (includeDividend && dividendMicro != null ? dividendMicro : 0n);

  return {
    date,
    dayPLMicro,
    // 價格造成的部分單獨留著：股利會把價格的漲跌蓋掉，除權息日尤其明顯
    // （息值 5 元、參考價也降 5 元 → 價格部分 0、股利部分 +5000）。
    // 兩者分開才看得出「基準價用錯」這件事。
    pricePLMicro: priceMicro,
    marketValueMicro: valueParts.length ? sumMicro(valueParts) : null,
    dividendMicro,
    includeDividend,
    byCode,
    counted,
    excludedUnsupported,
    excludedMissing,
    total: holdings.length,
  };
}

/**
 * 未實現損益。**只算有填平均成本的持股。**
 * 一檔都沒填 → 回 null，畫面上整個區塊都不要出現（不是顯示「—」）。
 */
export function computeUnrealized({ holdings = [], quotes = {} } = {}) {
  const costParts = [];
  const valueParts = [];
  let withCost = 0;
  const codes = [];

  for (const hd of holdings) {
    if (!hd.supported) continue;
    if (hd.avgCost == null) continue;
    const close = quotes[hd.code]?.close ?? null;
    if (close == null) continue;
    costParts.push(mulShares(hd.shares, toMicro(hd.avgCost)));
    valueParts.push(mulShares(hd.shares, toMicro(close)));
    withCost += 1;
    codes.push(hd.code);
  }

  if (withCost === 0) {
    return { unrealizedMicro: null, costMicro: null, valueMicro: null, returnRate: null, withCost: 0, total: holdings.length, codes: [] };
  }

  const costMicro = sumMicro(costParts);
  const valueMicro = sumMicro(valueParts);
  const unrealizedMicro = valueMicro - costMicro;
  return {
    unrealizedMicro,
    costMicro,
    valueMicro,
    returnRate: costMicro === 0n ? null : Number(unrealizedMicro) / Number(costMicro) * 100,
    withCost,
    total: holdings.length,
    codes,
  };
}

/**
 * 總和旁邊那一行「這個數字不含什麼」。
 * 沒有任何排除就回 null（不要顯示一行「不含 0 檔」）。
 */
export function exclusionNote(result) {
  const parts = [];
  if (result.excludedUnsupported > 0) parts.push(`不含 ${result.excludedUnsupported} 檔不支援報價的持股`);
  if (result.excludedMissing > 0) parts.push(`不含 ${result.excludedMissing} 檔尚未取得收盤價`);
  return parts.length ? parts.join('；') : null;
}

/** 有填均價的檔數說明；全部都填了就回 null。 */
export function partialCostNote(u) {
  if (u.withCost === 0) return null;
  if (u.withCost >= u.total) return null;
  return `僅含 ${u.withCost} 檔有填平均成本的持股`;
}

/** 每一檔在畫面上的狀態文字。不支援的永遠不給價格。 */
export const STATUS_TEXT = {
  ok: null,
  unsupported: '不支援報價',
  noClose: '尚未取得收盤價',
  noBasis: '尚未取得前一交易日收盤價',
  exNoRef: '除權息日，尚未取得參考價',
};
