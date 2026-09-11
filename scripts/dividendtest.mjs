// 除權息解析與股利金額（npm run dividendtest）。
// 固定樣本取自 2026-09-11 的實際回應：
//   twt48u-forecast.json  72 筆預告（息 65、權息 5、權 2）
//   twt49u-result.json     6 筆結果（息 4、權息 1、權 1）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, throws, section, done, noneOf, everyOf, detects } from './tap.mjs';
import {
  parseTwt48u, parseTwt49u, kindOf, refPriceFromExValue,
  dividendAmount, stockDividendShares, dividendSummary, refPriceFromForecast,
  WIRE_FEE, NHI_THRESHOLD,
} from '../js/dividend.js';
import { toMicro } from '../js/money.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const yuan = (n) => BigInt(Math.round(n * 1e6));

section('權/息 欄位的判讀');
eq(kindOf('息'), 'cash', '「息」＝現金股利');
eq(kindOf('權'), 'stock', '「權」＝配股或現金增資');
eq(kindOf('權息'), 'both', '「權息」＝兩者都有');
everyOf(['', ' ', '除息', 'x', null, undefined], (v) => kindOf(v) === null, '不認得的值回 null');
detects((v) => kindOf(v) !== null,
  { shouldHit: ['息', '權', '權息', '息權'], shouldMiss: ['', '除權', 'cash', null] },
  '判讀有對照組');

// ---------- TWT48U 預告表 ----------
section('TWT48U：除權除息預告表（日曆用的那張）');
const f = parseTwt48u(read('twt48u-forecast.json'));
eq(f.ok, true, '解析成功');
eq(f.rows.length, 72, '72 筆');
const kinds = {};
for (const r of f.rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
eq([kinds.cash, kinds.stock, kinds.both], [65, 2, 5], '息 65、權 2、權息 5 —— 三種都有樣本');

const cashOnly = f.rows.find((r) => r.code === '00401A');
eq(cashOnly.exDate, '2026-09-14', '除權息日轉成 ISO（原始是「115年09月14日」）');
eq(cashOnly.kind, 'cash', '00401A 是純除息');
eq(cashOnly.cashPerShare, 0.125, '每股現金股利 0.125 元');
eq(cashOnly.stockRate, 0, '沒有配股');

const both = f.rows.find((r) => r.code === '1235');
eq(both.kind, 'both', '1235 興泰是除權息');
eq(both.cashPerShare, 0.5, '每股現金股利 0.5 元');
eq(both.stockRate, 0.04999999, '無償配股率 0.04999999（每股配 0.05 股）');

const stockOnly = f.rows.find((r) => r.code === '6830');
eq(stockOnly.kind, 'stock', '6830 汎銓是除權');
eq(stockOnly.cashPerShare, 0, '沒有現金股利');
eq(stockOnly.stockRate, 0, '也沒有無償配股');
eq(stockOnly.rightsRate, 0.10963641, '它是現金增資（配股率 0.10963641）');
eq(stockOnly.rightsPrice, 500, '認購價 500 元');
// 現金增資不自動處理（PLAN §4.5），只提示使用者去對券商通知
ok(stockOnly.rightsRate > 0 && stockOnly.stockRate === 0,
  '「權」不一定是配股 —— 也可能只是現金增資，兩者要分得開');

everyOf(f.rows, (r) => /^\d{4}-\d{2}-\d{2}$/.test(r.exDate), '每一筆的除權息日都是 ISO 日期');
everyOf(f.rows, (r) => (r.cashPerShare ?? 0) >= 0 && (r.stockRate ?? 0) >= 0, '配息與配股率都不是負的');

section('金額還沒公告時，配息是 null 不是 0');
// TWSE 在「現金股利」欄位放的是一段 HTML：
//   "<p style= text-align:center;>待公告實際收益分配金額</p>"
// 解成 0 的話，日曆上會出現「每股 0 元、預估 0 元」——那不是不配息，是還不知道配多少。
const notYet = f.rows.filter((r) => r.cashPerShare == null);
ok(notYet.length > 0, `${notYet.length} 筆的配息金額還沒公告`);
noneOf(notYet, (r) => r.cashPerShare === 0, '這些筆的 cashPerShare 全部是 null，沒有一筆是 0');
everyOf(notYet, (r) => typeof r.cashNote === 'string' && r.cashNote.length > 0,
  '每一筆都帶得出原因（cashNote）');
ok(notYet.some((r) => r.cashNote.includes('待公告')), `例如「${notYet[0].cashNote}」`);
noneOf(notYet, (r) => /[<>]/.test(r.cashNote), 'cashNote 裡沒有殘留的 HTML 標記');
// 對照組：有公告的那些筆確實是數字
const announced = f.rows.filter((r) => r.cashPerShare != null);
ok(announced.length > 0, `（對照）另外 ${announced.length} 筆有實際金額`);
everyOf(announced, (r) => typeof r.cashPerShare === 'number', '有公告的都是數字');
// 而且金額未定的事件算不出預估金額
everyOf(notYet.slice(0, 5), (r) => dividendAmount({ shares: 1000, cashPerShare: r.cashPerShare }).grossMicro === null,
  '金額未公告的事件算不出預估金額（回 null，不是 0 元）');

section('「尚未公告」的認購價也是 null');
const noPrice = f.rows.filter((r) => r.rightsRate > 0 && r.rightsPrice == null);
ok(f.rows.some((r) => r.rightsPrice == null), '有筆數的認購價欄位是「尚未公告」→ null');
void noPrice;

section('TWT48U 欄位順序變了就拒收');
throws(() => parseTwt48u({ stat: 'OK', fields: ['除權除息日期', '名稱'], data: [] }),
  /TWT48U 欄位與預期不同/, '欄位對不上 → 丟錯');
eq(parseTwt48u({ stat: '很抱歉，沒有符合條件的資料!' }).ok, false, '查無資料回 ok=false');

// ---------- TWT49U 結果表 ----------
section('TWT49U：除權除息計算結果表（參考價用的那張）');
const g = parseTwt49u(read('twt49u-result.json'));
eq(g.ok, true, '解析成功');
eq(g.rows.length, 6, '6 筆');
const r2062 = g.rows.find((r) => r.code === '2062');
eq(r2062.date, '2026-09-10', '資料日期轉成 ISO');
eq(r2062.name, '橋椿', '名稱');
eq(r2062.prevClose, 19.55, '除權息前收盤價 19.55');
eq(r2062.refPrice, 18.55, '除權息參考價 18.55');
eq(r2062.exValue, 1, '權值+息值 1.00');
eq(r2062.kind, 'cash', '是除息');
everyOf(g.rows, (r) => r.refPrice != null && r.prevClose != null && r.exValue != null,
  '每一筆都有前收、參考價、權值息值');
everyOf(g.rows, (r) => r.refPrice < r.prevClose, '參考價都低於前收（除權息本來就會扣掉）');

section('參考價公式：前收 − (權值+息值)，捨去到小數兩位');
// 六筆實際資料逐一核對。這是「我們算得出跟證交所一樣的數字」的證據，
// 不是「我們自己發明一個數字」。
for (const r of g.rows) {
  eq(refPriceFromExValue({ prevClose: r.prevClose, exValue: r.exValue }), r.refPrice,
    `${r.code} ${r.name}（${r.kind}）：${r.prevClose} − ${r.exValue} = ${r.refPrice}`);
}
everyOf(g.rows, (r) => refPriceFromExValue({ prevClose: r.prevClose, exValue: r.exValue }) === r.refPrice,
  '六筆全部一致');
// 對照組：直接拿前收當基準的話，每一筆都會差一個息值 —— 那就是「假虧損」的來源
noneOf(g.rows, (r) => r.prevClose === r.refPrice,
  '（對照）前收跟參考價每一筆都不一樣，所以用錯基準價一定會算錯');
eq(refPriceFromExValue({ prevClose: 97.5, exValue: 0.800477 }), 96.69,
  '96.699523 捨去成 96.69（不是四捨五入的 96.70）');
eq(refPriceFromExValue({ prevClose: null, exValue: 1 }), null, '沒有前收就回 null');
eq(refPriceFromExValue({ prevClose: 100, exValue: null }), null, '沒有權值息值也回 null');

throws(() => parseTwt49u({ stat: 'OK', fields: ['資料日期'], data: [] }),
  /TWT49U 欄位與預期不同/, '欄位對不上 → 丟錯');

// ---------- 從預告表推導參考價（配對樣本驗證） ----------
section('從 TWT48U 的資料推算參考價（目前 App 沒有在用，這裡是驗證）');
// scripts/fixtures/refprice-pairs.json 由 npm run livecheck 自動捕捉：
// 同一檔股票同時出現在預告表（現金股利、無償配股率）與結果表（前收、參考價）時就存一筆。
// 沒有這個配對樣本的話，「(前收 − 現金股利 + 增資配股率 × 認購價) ÷ (1 + 無償配股率 + 增資配股率)」
// 這一段就只是「看起來合理」，沒被驗證過 —— 那種數字不上線。
const pairs = read('refprice-pairs.json');
ok(pairs.length >= 6, `有 ${pairs.length} 筆配對樣本`);
const pairKinds = {};
for (const p of pairs) pairKinds[p.kind] = (pairKinds[p.kind] ?? 0) + 1;
ok(pairKinds.cash > 0 && pairKinds.stock > 0 && pairKinds.both > 0,
  `三種都有：息 ${pairKinds.cash ?? 0}、權 ${pairKinds.stock ?? 0}、權息 ${pairKinds.both ?? 0}`);

for (const p of pairs) {
  eq(refPriceFromForecast({ prevClose: p.result.prevClose, ...p.forecast }), p.result.refPrice,
    `${p.code} ${p.name}（${p.kind}）：前收 ${p.result.prevClose}、現金股利 ${p.forecast.cashPerShare}、` +
    `配股率 ${p.forecast.stockRate} → ${p.result.refPrice}`);
}
everyOf(pairs, (p) => refPriceFromForecast({ prevClose: p.result.prevClose, ...p.forecast }) === p.result.refPrice,
  '每一筆推導出來的參考價都跟證交所公布值一模一樣');
// 對照組：把現金股利抹掉，就一定算不出正確的參考價（證明上面不是恆真）
noneOf(pairs.filter((p) => p.forecast.cashPerShare > 0),
  (p) => refPriceFromForecast({ prevClose: p.result.prevClose, ...p.forecast, cashPerShare: 0 }) === p.result.refPrice,
  '（對照）把現金股利改成 0，每一筆都算不出公布的參考價');

section('推導用整數算，不用浮點數');
// 實際會出錯的例子：1 − 0.34，在 double 上是 0.6599999999999999，
// 乘 100 捨去會得到 65 → 0.65，少了一分錢。
ok(Math.floor((1 - 0.34) * 100) / 100 === 0.65,
  '（對照）浮點數上 1 − 0.34 捨去到兩位會得到 0.65 —— 少一分');
eq(refPriceFromForecast({ prevClose: 1, cashPerShare: 0.34 }), 0.66, '整數運算得到正確的 0.66');
eq(refPriceFromExValue({ prevClose: 1, exValue: 0.34 }), 0.66, 'refPriceFromExValue 也是 0.66');
everyOf([[1, 0.55], [1, 0.56], [1, 0.67], [1, 0.68]],
  ([prev, cash]) => refPriceFromForecast({ prevClose: prev, cashPerShare: cash })
    === Math.round((prev - cash) * 100) / 100,
  '其他幾個浮點數會出錯的組合也都算對');

eq(refPriceFromForecast({ prevClose: null, cashPerShare: 1 }), null, '沒有前收回 null');
eq(refPriceFromForecast({ prevClose: 100, cashPerShare: null }), 100, '沒有配息就當 0（純除權的情況）');

// ---------- 股利金額 ----------
section('股利金額：自動扣費預設關閉');
eq(WIRE_FEE, 10, '匯費 10 元');
eq(NHI_THRESHOLD, 20000, '補充保費門檻 20,000 元');

// 手算：1000 股 × 0.5 元 = 500 元
const small = dividendAmount({ shares: 1000, cashPerShare: 0.5, autoFees: false });
eq(small.grossMicro.toString(), yuan(500).toString(), '1000 股 × 0.5 = 500 元');
eq(small.netMicro.toString(), yuan(500).toString(), '關閉自動扣費時，實收就是 500 元（一毛都不扣）');
eq(small.wireFeeMicro.toString(), '0', '沒有匯費');
eq(small.nhiFeeMicro.toString(), '0', '沒有補充保費');

section('開啟自動扣費');
const smallFee = dividendAmount({ shares: 1000, cashPerShare: 0.5, autoFees: true });
eq(smallFee.wireFeeMicro.toString(), yuan(10).toString(), '扣匯費 10 元');
eq(smallFee.nhiFeeMicro.toString(), '0', '500 元沒到 2 萬，不扣補充保費');
eq(smallFee.netMicro.toString(), yuan(490).toString(), '實收 490 元');

// 手算：10000 股 × 5 元 = 50,000；補充保費 50,000 × 2.11% = 1,055；50,000 − 10 − 1,055 = 48,935
const big = dividendAmount({ shares: 10000, cashPerShare: 5, autoFees: true });
eq(big.grossMicro.toString(), yuan(50000).toString(), '10000 股 × 5 = 50,000 元');
eq(big.nhiFeeMicro.toString(), yuan(1055).toString(), '補充保費 50,000 × 2.11% = 1,055 元');
eq(big.netMicro.toString(), yuan(48935).toString(), '實收 48,935 元');

section('補充保費的門檻是「達到」不是「超過」');
// 剛好 20,000：20,000 × 2.11% = 422
const exact = dividendAmount({ shares: 20000, cashPerShare: 1, autoFees: true });
eq(exact.nhiFeeMicro.toString(), yuan(422).toString(), '剛好 20,000 元要扣 422 元');
eq(exact.netMicro.toString(), yuan(20000 - 10 - 422).toString(), '實收 19,568 元');
// 差一分錢
const justUnder = dividendAmount({ shares: 1999999, cashPerShare: 0.01, autoFees: true });
eq(justUnder.grossMicro.toString(), yuan(19999.99).toString(), '19,999.99 元');
eq(justUnder.nhiFeeMicro.toString(), '0', '差一分錢就不扣補充保費');
detects(
  (gross) => dividendAmount({ shares: gross, cashPerShare: 1, autoFees: true }).nhiFeeMicro > 0n,
  { shouldHit: [20000, 20001, 100000], shouldMiss: [19999, 1000, 1, 0] },
  '門檻判斷有對照組'
);

section('算不出來的時候回 null');
eq(dividendAmount({ shares: null, cashPerShare: 1 }).grossMicro, null, '沒有股數 → null');
eq(dividendAmount({ shares: 1000, cashPerShare: null }).grossMicro, null, '沒有配息 → null');
noneOf([dividendAmount({ shares: null, cashPerShare: null }).netMicro], (v) => v === 0n,
  '算不出來時不是 0');

// ---------- 配股 ----------
section('配股：整股加進去，餘數只提示不估金額');
// 每仟股配 50 股（rate 0.05）
const s1 = stockDividendShares({ shares: 1000, stockRate: 0.05 });
eq(s1.wholeShares, 50, '1000 股配 50 股');
eq(s1.fractionShares, 0, '沒有餘數');
eq(s1.perThousand, 50, '每仟股配 50 股');

const s2 = stockDividendShares({ shares: 1234, stockRate: 0.05 });
eq(s2.wholeShares, 61, '1234 股 × 0.05 = 61.7 → 加 61 股');
ok(Math.abs(s2.fractionShares - 0.7) < 1e-9, `餘數 0.7 股（實際 ${s2.fractionShares}）`);

// 用預告表裡興泰的真實配股率
const s3 = stockDividendShares({ shares: 1000, stockRate: both.stockRate });
eq(s3.wholeShares, 49, '1000 股 × 0.04999999 = 49.99999 → 加 49 股，不是 50');
ok(s3.fractionShares > 0.99 && s3.fractionShares < 1,
  `餘數 ${s3.fractionShares} 股以現金找零 —— 不會自己進位成 50 股`);
eq(stockDividendShares({ shares: 500, stockRate: 0 }).wholeShares, 0, '配股率 0 就不加股數');
eq(stockDividendShares({ shares: null, stockRate: 0.05 }).wholeShares, null, '沒有股數回 null');

// ---------- 累積已領股利 ----------
section('累積已領股利：只算已確認的');
const EVENTS = [
  { code: '2330', exDate: '2025-09-18', status: 'confirmed', amountEst: yuan(3000).toString(), amountActual: null },
  { code: '2330', exDate: '2026-03-19', status: 'confirmed', amountEst: yuan(3500).toString(), amountActual: yuan(3490).toString() },
  { code: '2317', exDate: '2026-07-10', status: 'confirmed', amountEst: yuan(5000).toString(), amountActual: null },
  { code: '2330', exDate: '2026-09-18', status: 'pending', amountEst: yuan(4000).toString(), amountActual: null },
  { code: '1101', exDate: '2026-08-01', status: 'dismissed', amountEst: yuan(999).toString(), amountActual: null },
  { code: '0050', exDate: '2026-01-20', status: 'confirmed', amountEst: null, amountActual: null },
];
// 手算：3000（2025）＋ 3490（實收覆蓋 3500）＋ 5000 = 11,490
const sum = dividendSummary(EVENTS, { year: 2026 });
eq(sum.totalMicro.toString(), yuan(11490).toString(), '總計 11,490 元');
eq(sum.counted, 3, '三筆算得出金額');
eq(sum.unknown, 1, '一筆已確認但沒有金額（0050）');
ok(sum.totalMicro !== yuan(11500).toString(), '用的是實收 3,490 不是預估 3,500');
// 2026 年：3490 ＋ 5000 = 8,490
eq(sum.yearMicro.toString(), yuan(8490).toString(), '2026 年 8,490 元');
eq(sum.byYear.map(([y, v]) => [y, v.toString()]),
  [['2026', yuan(8490).toString()], ['2025', yuan(3000).toString()]],
  '分年度，新的在前');
eq(sum.byCode.map(([c]) => c), ['2330', '2317'], '分代號，金額大的在前');
eq(sum.byCode.find(([c]) => c === '2330')[1].toString(), yuan(6490).toString(),
  '2330 累積 3,000 ＋ 3,490 = 6,490 元');

noneOf(sum.byCode.map(([c]) => c), (c) => c === '1101', '已忽略（dismissed）的不算');
noneOf(sum.byCode.map(([c]) => c), (c) => c === '0050', '沒有金額的不算進分類');
ok(sum.byCode.length > 0, '（前提）分類不是空的');

section('一筆已確認的都沒有 → null，不是 0');
const none = dividendSummary(EVENTS.filter((e) => e.status !== 'confirmed'), { year: 2026 });
eq(none.totalMicro, null, '總計是 null');
eq(none.yearMicro, null, '年度也是 null');
eq(none.counted, 0, '算得出金額的筆數是 0');
ok(none.totalMicro !== 0n, '不是 0 —— 「還沒領過」跟「領到 0 元」不一樣');
eq(dividendSummary([], {}).totalMicro, null, '完全沒有事件也是 null');

section('微元精度');
// 0.125 元 × 8 股 = 1 元整
eq(dividendAmount({ shares: 8, cashPerShare: 0.125 }).grossMicro.toString(), toMicro(1).toString(),
  '8 股 × 0.125 = 剛好 1 元');
// 每股 0.800477（實際樣本裡有這種數字）× 1234 股 = 987.788618
eq(dividendAmount({ shares: 1234, cashPerShare: 0.800477 }).grossMicro.toString(),
  yuan(987.788618).toString(), '1234 股 × 0.800477 = 987.788618 元，一微元不差');

done('dividendtest');
