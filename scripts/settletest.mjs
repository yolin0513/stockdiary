// 每日結算（npm run settletest）。全部是手算過的固定案例。
//
// 每個案例底下都寫出手算過程，數字對不上的時候才知道是程式錯還是案例錯。

import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { settleDay, computeUnrealized, basisFor, exclusionNote, partialCostNote, STATUS_TEXT } from '../js/settle.js';
import { toMicro, toYuan, sumMicro, mulShares, roundToYuan, MICRO } from '../js/money.js';

const yuan = (n) => BigInt(Math.round(n * 1e6));   // 測試裡寫「元」比較好讀

// ---------- 金額運算 ----------
section('BigInt 微元：浮點數會錯的地方它不會');
eq(toMicro(2450).toString(), '2450000000', '2450 元');
eq(toMicro(0.125).toString(), '125000', '每股配息 0.125 元');
eq(toMicro(-15).toString(), '-15000000', '負數');
eq(toMicro(0.0000005).toString(), '1', '半個微元往上進位');
eq(toMicro(-0.0000005).toString(), '-1', '負的半微元往下（遠離零）');
everyOf([null, undefined, NaN, Infinity, 'abc', ''], (v) => toMicro(v) === null, '無效輸入回 null');

// 0.1 + 0.2 !== 0.3 的實際後果
ok(0.1 + 0.2 !== 0.3, '（對照）浮點數上 0.1 + 0.2 確實不等於 0.3');
eq((toMicro(0.1) + toMicro(0.2)).toString(), toMicro(0.3).toString(), '微元上 0.1 + 0.2 就是 0.3');

const tenTimes = Array.from({ length: 10 }, () => toMicro(0.1));
eq(sumMicro(tenTimes).toString(), '1000000', '0.1 加十次剛好是 1 元');
ok(Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b, 0) !== 1,
  '（對照）浮點數加十次 0.1 不等於 1');

eq(sumMicro([toMicro(1), null, toMicro(2)]), null, '總和裡有「不知道」就整個回 null，不當成 0 加進去');
eq(mulShares(1000, toMicro(2.5)).toString(), '2500000000', '1000 股 × 2.5 元 = 2500 元');
eq(roundToYuan(toMicro(1234.4)).toString(), toMicro(1234).toString(), '1234.4 → 1234');
eq(roundToYuan(toMicro(1234.5)).toString(), toMicro(1235).toString(), '1234.5 → 1235');
eq(roundToYuan(toMicro(-1234.5)).toString(), toMicro(-1235).toString(), '-1234.5 → -1235');
eq(MICRO.toString(), '1000000', '一元是一百萬微元');

// ---------- 基準價 ----------
section('基準價：除權息日只認參考價');
eq(basisFor({ prevClose: 2465, close: 2450, change: -15 }), { basis: 2465, source: 'prevClose' },
  '一般日用前一交易日收盤');
eq(basisFor({ close: 24.8, change: 0.05 }), { basis: 24.75, source: 'derived' },
  '沒有前收就用「今收 − 漲跌價差」倒推');
eq(basisFor({ exDay: true, refPrice: 2250, prevClose: 2255, close: 2250 }),
  { basis: 2250, source: 'refPrice' }, '除權息日用參考價');
// 這一條是整個 App 最重要的斷言之一。
eq(basisFor({ exDay: true, refPrice: null, prevClose: 2255, close: 2250, change: null }),
  { basis: null, source: 'none' },
  '除權息日拿不到參考價 → null，**不退回前一日收盤**（退回去會生出等於息值的假虧損）');
eq(basisFor({}), { basis: null, source: 'none' }, '什麼都沒有 → null');
detects(
  (args) => basisFor(args).basis === null,
  {
    shouldHit: [
      { exDay: true, refPrice: null, prevClose: 2255, close: 2250 },
      { close: 100 },
      {},
    ],
    shouldMiss: [
      { prevClose: 2465, close: 2450 },
      { close: 24.8, change: 0.05 },
      { exDay: true, refPrice: 2250, close: 2250 },
    ],
  },
  '「算不出基準價」的判斷有對照組'
);

// ---------- 固定案例 ----------
const H = (code, shares, extra = {}) => ({ code, name: code, shares, supported: true, ...extra });

section('案例 A：一般交易日，兩檔上市 + 一檔上櫃');
// 手算：
//   2330  1000 股 × (2450.00 − 2465.00) = 1000 × (−15) = −15,000
//   2317  2000 股 × ( 251.00 −  250.50) = 2000 × (+0.5) =  +1,000
//   6488  不支援報價，不參與
//   當日損益 = −14,000
//   市值 = 1000×2450 + 2000×251 = 2,450,000 + 502,000 = 2,952,000
const A = settleDay({
  date: '2026-09-11',
  holdings: [H('2330', 1000), H('2317', 2000), { code: '6488', name: '環球晶', shares: 500, supported: false }],
  quotes: {
    2330: { close: 2450, prevClose: 2465 },
    2317: { close: 251.0, prevClose: 250.5 },
  },
});
eq(A.dayPLMicro.toString(), yuan(-14000).toString(), '當日損益 −14,000 元');
eq(A.marketValueMicro.toString(), yuan(2952000).toString(), '市值 2,952,000 元');
eq(A.counted, 2, '算進去 2 檔');
eq(A.excludedUnsupported, 1, '排除 1 檔不支援報價');
eq(A.excludedMissing, 0, '沒有「尚未取得」的');
eq(exclusionNote(A), '不含 1 檔不支援報價的持股', '總和旁邊的文案');
eq(A.byCode.find((r) => r.code === '2330').plMicro.toString(), yuan(-15000).toString(), '2330 單檔 −15,000');
eq(A.byCode.find((r) => r.code === '2317').plMicro.toString(), yuan(1000).toString(), '2317 單檔 +1,000');

section('不支援報價的持股，任何欄位都不能有價格');
const otcRow = A.byCode.find((r) => r.code === '6488');
eq(otcRow.status, 'unsupported', '狀態是「不支援報價」');
eq(STATUS_TEXT[otcRow.status], '不支援報價', '有對應的畫面文字');
noneOf(
  [otcRow.close, otcRow.basis, otcRow.plMicro, otcRow.valueMicro, otcRow.dividendMicro],
  (v) => v != null,
  '收盤價、基準價、損益、市值、股利全部是 null'
);
noneOf(A.byCode.filter((r) => r.status === 'unsupported'), (r) => r.close != null || r.valueMicro != null,
  '所有不支援的列都沒有價格');

section('案例 B：除息日，有參考價');
// 2330 於除息日：前收 2255、息值 5.00 → 參考價 2250、當日收盤 2250
// 手算：
//   價格部分 = 1000 × (2250 − 2250) = 0
//   應收股利 = 1000 × 5.00 = 5,000
//   當日損益（含股利）= 5,000
//   當日損益（不含股利）= 0
const exQuotes = { 2330: { close: 2250, prevClose: 2255, exDay: true, refPrice: 2250, cashPerShare: 5.0 } };
const B = settleDay({ date: '2026-06-11', holdings: [H('2330', 1000)], quotes: exQuotes, includeDividend: true });
eq(B.pricePLMicro.toString(), '0', '價格部分是 0（股價跌的正好是息值）');
eq(B.dividendMicro.toString(), yuan(5000).toString(), '應收股利 5,000 元');
eq(B.dayPLMicro.toString(), yuan(5000).toString(), '當日損益 +5,000 元（含股利）');
eq(B.byCode[0].basisSource, 'refPrice', '基準價來自除權息參考價');

const B2 = settleDay({ date: '2026-06-11', holdings: [H('2330', 1000)], quotes: exQuotes, includeDividend: false });
eq(B2.dayPLMicro.toString(), '0', '關掉「含應收股利」時當日損益是 0');
eq(B2.dividendMicro.toString(), yuan(5000).toString(), '但股利金額還是算得出來，只是沒加進去');

// 對照：如果基準價退回前一日收盤 2255，價格部分會變成 1000 × (2250−2255) = −5,000，
// 而含股利的當日損益剛好被股利抵成 0 —— 看起來「很正常」，但兩個數字都是錯的。
ok(B.pricePLMicro !== yuan(-5000), '價格部分不是 −5,000（那是用錯基準價的結果）');
ok(B.dayPLMicro !== 0n, '含股利的當日損益不是 0（那也是用錯基準價的結果）');

section('案例 C：除息日，拿不到參考價 → 整檔不算，不是算成虧損');
const C = settleDay({
  date: '2026-06-11',
  holdings: [H('2330', 1000)],
  quotes: { 2330: { close: 2250, prevClose: 2255, exDay: true, refPrice: null } },
});
eq(C.byCode[0].status, 'exNoRef', '狀態是「除權息日，尚未取得參考價」');
eq(STATUS_TEXT.exNoRef, '除權息日，尚未取得參考價', '有對應的畫面文字');
eq(C.dayPLMicro, null, '當日損益是 null');
ok(C.dayPLMicro !== yuan(-5000), '不是 −5,000（用前一日收盤當基準的假虧損）');
ok(C.dayPLMicro !== 0n, '也不是 0');
eq(C.counted, 0, '沒有任何一檔算得出來');
eq(C.excludedMissing, 1, '算成「尚未取得」1 檔');
eq(C.marketValueMicro.toString(), yuan(2250000).toString(), '但市值算得出來（1000 × 2250）—— 市值不需要基準價');

section('案例 D：今日收盤尚未公布');
const D = settleDay({ date: '2026-09-11', holdings: [H('2330', 1000), H('2317', 2000)], quotes: {} });
eq(D.dayPLMicro, null, '當日損益是 null');
ok(D.dayPLMicro !== 0n, '不是 0 —— 顯示 0 會讓使用者以為今天沒賺沒賠');
eq(D.marketValueMicro, null, '市值也是 null');
eq(D.counted, 0, '一檔都沒算');
eq(D.excludedMissing, 2, '兩檔都是「尚未取得」');
eq(exclusionNote(D), '不含 2 檔尚未取得收盤價', '文案講清楚');
everyOf(D.byCode, (r) => r.status === 'noClose' && r.close == null && r.plMicro == null,
  '每一列都沒有價格也沒有損益');

section('案例 E：沒有持股');
const E = settleDay({ date: '2026-09-11', holdings: [], quotes: {} });
eq(E.dayPLMicro, null, '當日損益是 null，不是 0');
eq(E.marketValueMicro, null, '市值是 null，不是 0');
eq(exclusionNote(E), null, '沒有任何排除就不顯示「不含」那行');

section('案例 F：只有不支援報價的持股');
const F = settleDay({
  date: '2026-09-11',
  holdings: [{ code: '6488', name: '環球晶', shares: 500, supported: false }],
  quotes: { 6488: { close: 999, prevClose: 900 } },   // 就算硬塞報價進來也不能用
});
eq(F.dayPLMicro, null, '當日損益 null');
eq(F.marketValueMicro, null, '市值 null');
eq(F.byCode[0].close, null, '硬塞的報價沒有被採用');
eq(exclusionNote(F), '不含 1 檔不支援報價的持股', '文案');

section('案例 G：部分尚未取得');
// 2330 有收盤、2317 沒有 → 只算 2330
const G = settleDay({
  date: '2026-09-11',
  holdings: [H('2330', 1000), H('2317', 2000)],
  quotes: { 2330: { close: 2450, prevClose: 2465 } },
});
eq(G.dayPLMicro.toString(), yuan(-15000).toString(), '只算得出 2330 的 −15,000');
eq(G.counted, 1, '算進去 1 檔');
eq(G.excludedMissing, 1, '1 檔尚未取得');
eq(exclusionNote(G), '不含 1 檔尚未取得收盤價', '文案講清楚少了什麼');
eq(G.marketValueMicro.toString(), yuan(2450000).toString(), '市值也只含 2330');

section('案例 H：沒有前收，用漲跌價差倒推（浮點數陷阱）');
// 1101 台泥：收 24.80、漲跌 +0.05 → 基準 24.75
// 手算：1000 × 0.05 = 50 元
const Hc = settleDay({ date: '2026-09-10', holdings: [H('1101', 1000)], quotes: { 1101: { close: 24.8, change: 0.05 } } });
eq(Hc.byCode[0].basisSource, 'derived', '基準價是倒推出來的');
eq(Hc.dayPLMicro.toString(), yuan(50).toString(), '當日損益剛好 50 元，一分不差');
eq(toYuan(Hc.dayPLMicro), 50, '轉回元也是 50');

section('案例 I：多檔小數相加不會漂');
// 10 檔各 1 股，每檔漲 0.1 元 → 總共剛好 1 元
const many = Array.from({ length: 10 }, (_, i) => H(`900${i}`, 1));
const manyQuotes = Object.fromEntries(many.map((h) => [h.code, { close: 10.1, prevClose: 10.0 }]));
const I = settleDay({ date: '2026-09-11', holdings: many, quotes: manyQuotes });
eq(I.dayPLMicro.toString(), yuan(1).toString(), '總和剛好 1 元（浮點數相加會是 0.9999999999999999）');

section('案例 J：休市日沒有報價就是沒有');
const J = settleDay({ date: '2026-09-25', holdings: [H('2330', 1000)], quotes: {} });
eq(J.dayPLMicro, null, '休市日不會憑空生出當日損益');

// ---------- 未實現損益 ----------
section('未實現損益：沒填平均成本就完全不算');
const noCost = computeUnrealized({
  holdings: [H('2330', 1000), H('2317', 2000)],
  quotes: { 2330: { close: 2450 }, 2317: { close: 251 } },
});
eq(noCost.unrealizedMicro, null, '沒有任何一檔填了均價 → null');
eq(noCost.costMicro, null, '成本也是 null');
eq(noCost.returnRate, null, '報酬率也是 null');
eq(noCost.withCost, 0, '有填均價的檔數是 0');
eq(partialCostNote(noCost), null, '也不顯示「僅含 N 檔」');
noneOf([noCost.unrealizedMicro, noCost.costMicro, noCost.valueMicro, noCost.returnRate],
  (v) => v != null, '整組都是 null —— 畫面上不該出現任何未實現數字');

section('未實現損益：部分有填');
// 2330 1000 股，均價 1000 → 成本 1,000,000；市值 1000 × 2450 = 2,450,000
// 未實現 = +1,450,000；報酬率 = 1,450,000 / 1,000,000 = 145%
const partial = computeUnrealized({
  holdings: [H('2330', 1000, { avgCost: 1000 }), H('2317', 2000), { code: '6488', name: '環球晶', shares: 500, supported: false, avgCost: 500 }],
  quotes: { 2330: { close: 2450 }, 2317: { close: 251 } },
});
eq(partial.unrealizedMicro.toString(), yuan(1450000).toString(), '未實現 +1,450,000 元');
eq(partial.costMicro.toString(), yuan(1000000).toString(), '成本 1,000,000 元');
eq(partial.returnRate, 145, '報酬率 145%');
eq(partial.withCost, 1, '只有 1 檔有填均價');
eq(partial.codes, ['2330'], '而且只有 2330');
eq(partialCostNote(partial), '僅含 1 檔有填平均成本的持股', '文案講清楚只含哪些');
ok(!partial.codes.includes('6488'), '不支援報價的持股就算填了均價也不算進去');

section('未實現損益：全部都填了就不顯示「僅含」');
const allCost = computeUnrealized({
  holdings: [H('2330', 1000, { avgCost: 1000 }), H('2317', 2000, { avgCost: 200 })],
  quotes: { 2330: { close: 2450 }, 2317: { close: 251 } },
});
// 成本 1,000,000 + 400,000 = 1,400,000；市值 2,450,000 + 502,000 = 2,952,000
eq(allCost.costMicro.toString(), yuan(1400000).toString(), '成本 1,400,000');
eq(allCost.valueMicro.toString(), yuan(2952000).toString(), '市值 2,952,000');
eq(allCost.unrealizedMicro.toString(), yuan(1552000).toString(), '未實現 +1,552,000');
eq(partialCostNote(allCost), null, '全部都填了就不顯示「僅含 N 檔」');

section('未實現損益：有填均價但拿不到收盤價');
const noQuote = computeUnrealized({ holdings: [H('2330', 1000, { avgCost: 1000 })], quotes: {} });
eq(noQuote.unrealizedMicro, null, '沒有收盤價就算不出未實現，回 null 不回 0');

done('settletest');
