// 產業集中度。
//
// 只陳述事實：「半導體業佔 62%」。**不做任何評價** ——
// 不寫「過度集中」「建議分散」「風險偏高」，那些都是投資建議。
// 使用者看到 62% 自己會有判斷，那是他的事。
//
// 算不出市值的持股（不支援報價、或當天沒有收盤價）**不計入分母**，
// 並且要回報有幾檔被排除。把它們當成 0 會讓百分比看起來很精準，其實是錯的。

import { mulSharesPrecise } from './money.js';

/**
 * 依產業彙總。
 *
 * @param holdings  [{code, name, industry, shares, supported}]
 * @param quotes    { code: { close } }
 * @returns {{rows, totalMicro, excluded, counted}}
 *   rows: [{industry, valueMicro, pct, codes}]，由大到小
 *   excluded: [{code, why}]
 */
export function byIndustry(holdings = [], quotes = {}) {
  const excluded = [];
  const buckets = new Map();
  const parts = [];

  for (const hd of holdings) {
    if (hd.supported === false) { excluded.push({ code: hd.code, why: '不支援報價' }); continue; }
    if (!(hd.shares > 0)) { excluded.push({ code: hd.code, why: '沒有股數' }); continue; }
    const close = quotes[hd.code]?.close;
    if (close == null) { excluded.push({ code: hd.code, why: '沒有收盤價' }); continue; }

    // mulSharesPrecise 自己會把每股金額轉成奈刻度，這裡**不要**先 toMicro ——
    // 轉兩次會讓市值差好幾個數量級（踩過）。
    const valueMicro = mulSharesPrecise(hd.shares, close);
    const key = hd.industry || '產業未知';
    const cur = buckets.get(key) ?? { industry: key, valueMicro: 0n, codes: [] };
    cur.valueMicro += valueMicro;
    cur.codes.push(hd.code);
    buckets.set(key, cur);
    parts.push(valueMicro);
  }

  const totalMicro = parts.reduce((a, b) => a + b, 0n);
  const rows = [...buckets.values()]
    .map((b) => ({ ...b, pct: totalMicro > 0n ? pctOf(b.valueMicro, totalMicro) : null }))
    .sort((a, b) => (b.valueMicro > a.valueMicro ? 1 : b.valueMicro < a.valueMicro ? -1 : 0));

  return { rows, totalMicro, excluded, counted: parts.length };
}

/**
 * 佔比，小數點後一位。
 * 用整數算（先乘 1000 再除）—— 浮點數在這裡會讓各項加起來不是 100.0。
 */
export function pctOf(partMicro, totalMicro) {
  if (totalMicro <= 0n) return null;
  return Number((partMicro * 1000n) / totalMicro) / 10;
}

/** 被排除的那幾檔要講清楚，不能讓百分比看起來像全部。 */
export function exclusionNote({ excluded, counted }) {
  if (!excluded.length) return null;
  const byWhy = new Map();
  for (const e of excluded) byWhy.set(e.why, [...(byWhy.get(e.why) ?? []), e.code]);
  const parts = [...byWhy.entries()].map(([why, codes]) => `${codes.join('、')}（${why}）`);
  return `以下 ${excluded.length} 檔不計入：${parts.join('；')}。這裡的百分比只算得出市值的 ${counted} 檔。`;
}
