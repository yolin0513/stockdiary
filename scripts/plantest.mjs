// 定期定額與平均成本的純邏輯（npm run plantest）。
//
// 兩件事在這裡守住：
//   · 扣款日展開：週末與休市要順延、月底要夾住、同一天不重複
//   · 平均成本：沒填成交價就不動（猜一個價格比不算還糟）、賣出不動、配股會稀釋

import { ok, eq, near, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { validatePlan, dueOccurrences, nextTradingDay, estimateDca, dcaChangeId, reinvestChangeId , MAX_FEE_RATE } from '../js/plans.js';
import { avgCostAfter, avgCostFromChanges, costNote, REASON } from '../js/avgcost.js';
import { makeCalendar } from '../js/market.js';

// 固定日曆：2026 年 9 月（9/25 中秋、9/28 教師節休市）＋ 10 月頭幾天
const cal = makeCalendar({
  year: 2026,
  tradingDays: [
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
    '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
    '2026-09-29', '2026-09-30',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  ],
});

section('計畫的檢查');
const base = { code: '2330', amount: 3000, days: [6, 16, 26], feeRate: 0.001425 };
eq(validatePlan(base), null, '正常的計畫通過');
eq(validatePlan({ ...base, code: '' }), '請選擇股票代號', '沒代號');
eq(validatePlan({ ...base, amount: 0 }), '每次扣款金額要大於零', '金額 0');
eq(validatePlan({ ...base, amount: -100 }), '每次扣款金額要大於零', '負金額');
eq(validatePlan({ ...base, days: [] }), '至少要有一個扣款日', '沒有扣款日');
eq(validatePlan({ ...base, days: [0] }), '扣款日要是 1 到 31 之間的整數', '0 號不存在');
eq(validatePlan({ ...base, days: [32] }), '扣款日要是 1 到 31 之間的整數', '32 號不存在');
eq(validatePlan({ ...base, days: [6, 6] }), '扣款日有重複', '重複的扣款日');
ok(String(validatePlan({ ...base, feeRate: 1 })).includes('100.0000%'), '費率 1 不合理（那是 100%）');
// 負的走另一條訊息 —— 兩種錯要分得開
ok(String(validatePlan({ ...base, feeRate: -0.1 })).includes('不小於零'), '負的費率講的是另一件事');
eq(validatePlan({ ...base, feeRate: '' }), null, '費率留空是可以的');
detects((p) => validatePlan(p) !== null, {
  shouldHit: [{ ...base, amount: 0 }, { ...base, days: [] }, { ...base, code: null }, { ...base, feeRate: 2 }],
  shouldMiss: [base, { ...base, feeRate: 0 }, { ...base, days: [1] }, { ...base, days: [31] }],
}, '檢查器有對照組');

section('順延到下一個交易日');
eq(nextTradingDay(cal, '2026-09-11'), '2026-09-11', '交易日就是當天');
eq(nextTradingDay(cal, '2026-09-12'), '2026-09-14', '週六 → 下週一');
eq(nextTradingDay(cal, '2026-09-13'), '2026-09-14', '週日 → 下週一');
eq(nextTradingDay(cal, '2026-09-25'), '2026-09-29', '中秋節 → 跳過 9/28 教師節，到 9/29');
eq(nextTradingDay(cal, '2027-01-05'), null, '日曆沒涵蓋 → null');

// 日曆有缺口（不是放假）時不能亂跳：跳到兩個月後會生出一筆日期完全錯的扣款
const gappy = makeCalendar({ year: 2026, tradingDays: ['2026-03-02', '2026-05-04'] });
eq(nextTradingDay(gappy, '2026-03-10'), null,
  '下一個交易日在兩個月後 → 回 null（那是日曆缺了一段，不是連假）');
// 對照組：真正的長假（農曆春節 2026 休到 2/22，前後交易日相隔 12 天）要照樣順延
const lny = makeCalendar({ year: 2026, tradingDays: ['2026-02-11', '2026-02-23', '2026-02-24'] });
eq(nextTradingDay(lny, '2026-02-16'), '2026-02-23', '（對照）春節休 12 天照樣順延得過去');
eq(nextTradingDay(lny, '2026-02-12'), '2026-02-23', '（對照）春節第一天也順延得過去');
detects((iso) => nextTradingDay(gappy, iso) === null, {
  shouldHit: ['2026-03-10', '2026-03-20', '2026-04-01'],
  shouldMiss: ['2026-03-02', '2026-05-04'],
}, '「跳太遠就是缺口」的判斷有對照組');

section('扣款日展開');
// 每月 6、16、26 號，2026 年 9 月：
//   9/6 是週日 → 順延到 9/7
//   9/16 是週三 → 就是 9/16
//   9/26 是週六 → 順延，9/28 教師節也休市 → 9/29
const sep = dueOccurrences({ days: [6, 16, 26], from: '2026-08-31', to: '2026-09-30', calendar: cal });
eq(sep.map((o) => o.date), ['2026-09-07', '2026-09-16', '2026-09-29'], '三個扣款日');
eq(sep[0].movedFrom, '2026-09-06', '9/6 是週日，順延並記下原本的日期');
eq(sep[1].movedFrom, null, '9/16 沒有順延');
eq(sep[2].movedFrom, '2026-09-26', '9/26 順延到 9/29');
everyOf(sep, (o) => cal.set.has(o.date), '展開出來的每一天都是交易日');
noneOf(sep, (o) => o.clamped, '9 月有 30 天，這三個日子都不用夾');

section('月底沒有那一天就夾到最後一天');
// 2026 年 2 月只有 28 天，扣款日 31 號 → 夾到 2/28（週六）→ 順延
const feb = makeCalendar({ year: 2026, tradingDays: ['2026-02-26', '2026-03-02', '2026-03-03'] });
const clamped = dueOccurrences({ days: [31], from: '2026-02-01', to: '2026-03-03', calendar: feb });
ok(clamped.length > 0, `展開出 ${clamped.length} 筆`);
ok(clamped[0].clamped, '標記了「當月沒有這一天」');
eq(clamped[0].scheduled, '2026-02-28', '夾到 2 月 28 日');
eq(clamped[0].date, '2026-03-02', '2/28 是週六，順延到下一個交易日');

section('範圍：from 之後、to 之前');
eq(dueOccurrences({ days: [16], from: '2026-09-16', to: '2026-09-30', calendar: cal }).map((o) => o.date),
  [], 'from 當天不算（已經產生過了）');
eq(dueOccurrences({ days: [16], from: '2026-09-15', to: '2026-09-30', calendar: cal }).map((o) => o.date),
  ['2026-09-16'], 'from 之後算');
eq(dueOccurrences({ days: [16], from: '2026-08-31', to: '2026-09-15', calendar: cal }).map((o) => o.date),
  [], 'to 之後不算');
eq(dueOccurrences({ days: [6], from: null, to: null, calendar: cal }), [], '沒有 to 就不展開');

section('跳過三個月再開 App');
// 6/16 建立計畫，一直到 9/30 才開 App —— 中間每個月的扣款都要出現，一筆都不能少
const long = makeCalendar({
  year: 2026,
  tradingDays: [
    '2026-06-16', '2026-07-16', '2026-08-17', '2026-09-16', '2026-09-30',
  ],
});
const missed = dueOccurrences({ days: [16], from: '2026-06-16', to: '2026-09-30', calendar: long });
eq(missed.map((o) => o.date), ['2026-07-16', '2026-08-17', '2026-09-16'],
  '三個月的扣款都在（8/16 是週日，順延到 8/17）');
eq(missed.length, 3, '剛好三筆，不多不少');
noneOf(missed, (o) => o.date <= '2026-06-16', '建立當天那一筆不重複產生');

section('同一天只產生一筆');
// 扣款日 26、27 號，兩天都休市而順延到同一個交易日 → 只能算一次
const dup = dueOccurrences({ days: [26, 27], from: '2026-09-25', to: '2026-09-30', calendar: cal });
eq(dup.map((o) => o.date), ['2026-09-29'], '9/26 與 9/27 都順延到 9/29，只產生一筆');

section('估算股數與餘額');
// 3000 元、無手續費、收盤 24.80 → floor(3000 / 24.8) = 120 股，花 2976，餘 24
const e1 = estimateDca({ amount: 3000, feeRate: 0, price: 24.8 });
eq(e1.shares, 120, '120 股');
eq(Number(e1.spentMicro) / 1e6, 2976, '花費 2,976 元');
eq(Number(e1.remainderMicro) / 1e6, 24, '餘額 24 元');
eq(Number(e1.usableMicro) / 1e6, 3000, '沒有手續費時可用金額就是 3,000');

// 5000 元、費率 0.001425、收盤 24.80
// 手續費 5000 × 0.001425 = 7.125 → 可用 4992.875
// floor(4992.875 / 24.8) = 201 股，花 4984.8，餘 8.075
const e2 = estimateDca({ amount: 5000, feeRate: 0.001425, price: 24.8 });
eq(Number(e2.usableMicro) / 1e6, 4992.875, '可用金額 4,992.875 元（手續費 7.125）');
eq(e2.shares, 201, '201 股');
eq(Number(e2.spentMicro) / 1e6, 4984.8, '花費 4,984.8 元');
eq(Number(e2.remainderMicro) / 1e6, 8.075, '餘額 8.075 元');

// 買不到一股
const e3 = estimateDca({ amount: 1000, feeRate: 0, price: 2450 });
eq(e3.shares, 0, '1,000 元買不到一股 2,450 元的股票 → 0 股');
eq(Number(e3.remainderMicro) / 1e6, 1000, '整筆都是餘額');

section('拿不到收盤價就估不出股數（但不是 0 股）');
const noPrice = estimateDca({ amount: 3000, feeRate: 0, price: null });
eq(noPrice.shares, null, '股數是 null');
ok(noPrice.shares !== 0, '不是 0 —— 0 股代表「買不到一股」，null 代表「不知道」');
eq(Number(noPrice.usableMicro) / 1e6, 3000, '可用金額還是算得出來');
eq(estimateDca({ amount: null, feeRate: 0, price: 24.8 }).shares, null, '沒有金額也回 null');
eq(estimateDca({ amount: 3000, feeRate: 0, price: 0 }).shares, null, '收盤價 0 → null，不做除以零');

section('變動 id 是決定性的（重跑不會產生重複）');
eq(dcaChangeId('plan1', '2026-09-16'), 'dca:plan1:2026-09-16', '定期定額');
eq(reinvestChangeId('2330-2026-09-16'), 'rei:2330-2026-09-16', '配息再投入');
ok(dcaChangeId('p', '2026-09-16') === dcaChangeId('p', '2026-09-16'), '同樣的輸入永遠得到同樣的 id');

// ---------- 平均成本 ----------
section('平均成本：沒填成交價就不動');
const noPriceBuy = avgCostAfter({ oldAvg: 100, oldShares: 1000, delta: 500, price: null, kind: 'dca' });
eq(noPriceBuy.avgCost, 100, '均價維持 100');
eq(noPriceBuy.reason, REASON.UNCHANGED_NO_PRICE, '原因是「沒填成交價」');
ok(noPriceBuy.avgCost !== 0, '不會變成 0');

section('平均成本：有填成交價就加權平均');
// (100 × 1000 + 120 × 500) ÷ 1500 = (100000 + 60000) / 1500 = 106.666667
const w = avgCostAfter({ oldAvg: 100, oldShares: 1000, delta: 500, price: 120, kind: 'dca' });
near(w.avgCost, 106.666667, 1e-6, '加權平均 106.666667');
eq(w.reason, REASON.WEIGHTED, '原因是加權平均');
// 整數案例：(50 × 1000 + 60 × 1000) / 2000 = 55
eq(avgCostAfter({ oldAvg: 50, oldShares: 1000, delta: 1000, price: 60 }).avgCost, 55, '剛好 55');

section('平均成本：賣出不動（平均成本法）');
const sell = avgCostAfter({ oldAvg: 100, oldShares: 1000, delta: -300, price: 150 });
eq(sell.avgCost, 100, '賣出之後均價還是 100');
eq(sell.reason, REASON.UNCHANGED_SELL, '原因是賣出');

section('平均成本：配股會稀釋');
// 1000 股、均價 100（總成本 100,000）；配 50 股 → 1050 股
// 總成本不變 → 均價 = 100000 / 1050 = 95.238095
const sd = avgCostAfter({ oldAvg: 100, oldShares: 1000, delta: 50, price: null, kind: 'stockDividend' });
near(sd.avgCost, 95.238095, 1e-6, '配股後均價降到 95.238095');
eq(sd.reason, REASON.STOCK_DIVIDEND, '原因是配股');
ok(sd.avgCost < 100, '配股一定會讓每股成本下降');
// 配股不需要成交價，所以「沒填價格」不適用
ok(sd.avgCost !== 100, '配股不會因為沒有成交價就不動');

section('平均成本：原本就沒填的情況');
eq(avgCostAfter({ oldAvg: null, oldShares: 0, delta: 1000, price: 50 }).avgCost, 50,
  '原本 0 股 → 第一筆的價格就是均價');
eq(avgCostAfter({ oldAvg: null, oldShares: 0, delta: 1000, price: 50 }).reason, REASON.FIRST, '原因是「第一次有成本」');
eq(avgCostAfter({ oldAvg: null, oldShares: 1000, delta: 500, price: 120 }).avgCost, null,
  '已經有部位但沒填過成本 → 還是 null（不能拿一筆新的推算整個部位）');
eq(avgCostAfter({ oldAvg: null, oldShares: 1000, delta: 500, price: 120 }).reason, REASON.UNCHANGED_NO_BASE,
  '原因是「沒有基礎可以加權」');
eq(avgCostAfter({ oldAvg: 100, oldShares: 1000, delta: 0, price: 120 }).avgCost, 100, '0 股的變動不動均價');

section('從變動紀錄重播出平均成本');
const c = (date, delta, price, kind = 'dca', status = 'confirmed') => ({ id: date + kind, date, deltaShares: delta, price, kind, status });
// 起始 1000 股、均價 100
// 3/16 買 500 股 @120 → (100×1000 + 120×500)/1500 = 106.666667
// 4/16 買 500 股，沒填價 → 不動
// 5/16 賣 200 股 @150 → 不動
const replayed = avgCostFromChanges([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 500, 120),
  c('2026-04-16', 500, null),
  c('2026-05-16', -200, 150, 'manual'),
], { openingAvg: 100 });
near(replayed.avgCost, 106.666667, 1e-6, '重播結果 106.666667');
eq(replayed.shares, 1800, '股數 1000 + 500 + 500 − 200 = 1800');

// 重播是決定性的：同樣的輸入跑兩次結果一樣
const again = avgCostFromChanges([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 500, 120),
  c('2026-04-16', 500, null),
  c('2026-05-16', -200, 150, 'manual'),
], { openingAvg: 100 });
eq(again.avgCost, replayed.avgCost, '重播兩次結果一樣');

// 未確認的不算
const withPending = avgCostFromChanges([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 500, 120),
  c('2026-09-16', 500, 999, 'dca', 'pending'),
], { openingAvg: 100 });
near(withPending.avgCost, 106.666667, 1e-6, '未確認的那筆（價格 999）沒有影響均價');
eq(withPending.shares, 1500, '股數也不含未確認的');

section('沒填起始成本就一路都是 null');
const noBase = avgCostFromChanges([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 500, 120),
], { openingAvg: null });
eq(noBase.avgCost, null, '起始沒填成本 → 之後買再多也算不出整體均價');
ok(noBase.avgCost !== 120, '不會拿後來那一筆的價格冒充整體均價');

section('成本說明：少算了幾次');
eq(costNote([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 500, 120),
]), null, '每一筆都有價格（或是 opening）→ 不顯示說明');
eq(costNote([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 500, null),
  c('2026-04-16', 500, null),
]), '平均成本未含 2 次沒有填成交價的買進', '兩次沒填價格');
eq(costNote([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-03-16', 50, null, 'stockDividend'),
]), null, '配股本來就沒有成交價，不算在內');
eq(costNote([
  c('2026-01-05', 1000, null, 'opening'),
  c('2026-09-16', 500, null, 'dca', 'pending'),
]), null, '未確認的不算');
detects((changes) => costNote(changes) !== null, {
  shouldHit: [
    [c('a-2026-01-05', 500, null, 'dca')],
    [c('b-2026-01-05', 500, null, 'manual')],
  ],
  shouldMiss: [
    [c('c-2026-01-05', 500, 100, 'dca')],
    [c('d-2026-01-05', 500, null, 'stockDividend')],
    [c('e-2026-01-05', -500, null, 'manual')],
    [],
  ],
}, '說明的觸發條件有對照組');

section('手續費率的單位陷阱：填成百分比要擋下來');
// 券商講的是「0.1425%」，欄位要的是比例 0.001425。
// 直接把 0.1425 填進來會變成 14.25%，估出來的股數少一成四 ——
// 而畫面只會寫「手續費率 14.2500%」，看起來完全正常，數字卻是錯的。
detects((f) => validatePlan({ code: '0050', amount: 5000, days: [6], feeRate: f }) != null, {
  shouldHit: [0.1425, 0.15, 0.5, 1, 1.425, 14.25, 0.0101, -0.001, 'abc'],
  shouldMiss: [0.001425, 0.0008, 0, 0.01, '', null, undefined, '0.001425'],
}, '把百分比當比例填（0.1425）會被擋，真的比例（0.001425）放行');

const tooBig = validatePlan({ code: '0050', amount: 5000, days: [6], feeRate: 0.1425 });
ok(tooBig.includes('14.2500%') && tooBig.includes('0.001425'),
  `訊息講得出「你填的等於幾 %」與「應該填什麼」：「${tooBig}」`);
// 上限就是那條線 —— 0.01 過、0.0101 不過
eq(validatePlan({ code: '0050', amount: 5000, days: [6], feeRate: MAX_FEE_RATE }), null,
  `上限 ${MAX_FEE_RATE}（＝1%）本身是放行的`);
ok(validatePlan({ code: '0050', amount: 5000, days: [6], feeRate: MAX_FEE_RATE * 1.01 }) != null,
  '超過一點點就擋');
// 手算對照：5,000 元 × 0.001425 = 7.125 元，扣掉之後買得起的金額是 4,992.875
const est = estimateDca({ amount: 5000, feeRate: 0.001425, price: 107.7 });
eq(est.shares, 46, '手算 (5000 − 7.125) ÷ 107.70 = 46.35… → 46 股');
const wrong = estimateDca({ amount: 5000, feeRate: 0.1425, price: 107.7 });
eq(wrong.shares, 39, '（對照）填錯單位的話會變成 39 股 —— 少 7 股，畫面上完全看不出來');

done('plantest');
