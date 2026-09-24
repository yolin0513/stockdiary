// 定期定額試算器（npm run calctest）。全部是手算過、對得到元的固定案例。
//
// 這支測試除了算術，還守兩條**產品規則**：
//   · 沒有任何預設值、建議值、歷史平均 —— 少填一個欄位就算不出來，不會自己補
//   · 原始碼裡不出現「建議」意味的字（那會把「你給的假設」變成「我們的看法」）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, near, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { BANNED } from './banned.mjs';
import {
  validateInputs, simulate, compareScenarios, methodGap, monthlyFactor,
  REQUIRED, CONTRIB_FREQ, DIVIDEND_FREQ, METHODS, MAX_FEE_RATE, compareMulti,
} from '../js/calc.js';
import { toMicro } from '../js/money.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const yuan = (micro) => (micro == null ? null : Number(micro) / 1e6);
const base = { amount: 10000, perMonth: 1, years: 10, growthRate: 0, yieldRate: 0, dividendFreq: 1 };
const run = (over = {}, opts = { reinvest: true }) => {
  const v = validateInputs({ ...base, ...over });
  if (!v.ok) throw new Error('輸入不合法：' + JSON.stringify(v.errors));
  return simulate(v.values, opts);
};

section('輸入檢查：空白不是 0');
eq(validateInputs(base).ok, true, '完整的輸入通過');
for (const key of REQUIRED) {
  const v = validateInputs({ ...base, [key]: '' });
  ok(!v.ok && !!v.errors[key], `${key} 留空 → 報錯「${v.errors[key]}」`);
  ok(v.values[key] === undefined, `${key} 留空時不會被當成 0`);
}
eq(validateInputs({ ...base, growthRate: '' }).values.growthRate, undefined,
  '成長率空白 → undefined，**不是 0%**');
eq(validateInputs({ ...base, growthRate: 0 }).values.growthRate, 0, '（對照）真的填 0 就是 0');
eq(validateInputs({ ...base, growthRate: -5 }).ok, true, '成長率可以是負的（使用者要假設下跌是他的自由）');
eq(validateInputs({ ...base, years: 10.5 }).ok, false, '期間要是整數年');
eq(validateInputs({ ...base, perMonth: 4 }).ok, false, '每月扣款次數只有 1／2／3');
eq(validateInputs({ ...base, dividendFreq: 3 }).ok, false, '配息頻率只有 1／2／4／12');
eq(validateInputs({ ...base, method: 'share' }).ok, false, '股數法沒填股價 → 不合法');
eq(validateInputs({ ...base, method: 'share', price: 100 }).ok, true, '股數法填了股價就合法');
eq(validateInputs({ ...base, amount: 0 }).ok, true, '扣款金額可以是 0（只試算現有部位）');
detects((raw) => !validateInputs(raw).ok, {
  shouldHit: [{ ...base, amount: '' }, { ...base, years: '' }, { ...base, yieldRate: 'abc' }, { ...base, years: 0 }],
  shouldMiss: [base, { ...base, growthRate: -3 }, { ...base, amount: 0 }, { ...base, feeRate: 0.001425 }],
}, '輸入檢查有對照組');

section('案例 1：零成長、零配息 —— 期末等於投入');
// 手算：每月 1 次 10,000 元 × 120 個月 = 1,200,000
const c1 = run();
eq(yuan(c1.investedMicro), 1200000, '累積投入 1,200,000 元');
eq(yuan(c1.finalValueMicro), 1200000, '期末市值 1,200,000 元');
eq(yuan(c1.dividendTotalMicro), 0, '沒有配息');
eq(c1.yearly.length, 10, '逐年表有 10 列');
eq(yuan(c1.yearly[0].investedMicro), 120000, '第 1 年底投入 120,000');
eq(yuan(c1.yearly.at(-1).valueMicro), 1200000, '第 10 年底市值 1,200,000');

section('案例 2：純複利 —— 對得上 1,000,000 × 1.12^10');
// 手算：1,000,000 × 1.12^10 = 3,105,848.21
const c2 = run({ amount: 0, startValue: 1000000, growthRate: 12, years: 10 });
near(yuan(c2.finalValueMicro), 1000000 * Math.pow(1.12, 10), 0.5,
  `純複利十年對得上手算：期末 ${yuan(c2.finalValueMicro).toFixed(2)}，手算 ${(1000000 * Math.pow(1.12, 10)).toFixed(2)}`);
eq(yuan(c2.investedMicro), 1000000, '累積投入就是那筆已有部位');
near(Math.pow(Number(monthlyFactor(12)) / 1e12, 12), 1.12, 1e-9,
  '月成長倍數連乘 12 次剛好回到 12%（複利換算，不是除以 12）');

section('案例 3：配息再投入 vs 配息領現');
// 起始 1,000,000、零成長、年配息率 5%、每年配一次、10 年
//   再投入：1,000,000 × 1.05^10 = 1,628,894.63
//   領現　：市值維持 1,000,000，每年領 50,000，共 500,000 → 手上總共 1,500,000
const cmp = compareScenarios(validateInputs({
  ...base, amount: 0, startValue: 1000000, growthRate: 0, yieldRate: 5, dividendFreq: 1, years: 10,
}).values);
near(yuan(cmp.reinvest.finalValueMicro), 1000000 * Math.pow(1.05, 10), 0.5,
  `配息再投入十年對得上手算：再投入期末 ${yuan(cmp.reinvest.finalValueMicro).toFixed(2)}，手算 ${(1000000 * Math.pow(1.05, 10)).toFixed(2)}`);
eq(yuan(cmp.payout.finalValueMicro), 1000000, '領現時市值維持 1,000,000');
eq(yuan(cmp.payout.dividendPaidOutMicro), 500000, '領現累積 500,000 元（10 年 × 50,000）');
eq(yuan(cmp.payout.totalEndMicro), 1500000, '領現手上總共 1,500,000 元');
ok(cmp.reinvest.totalEndMicro > cmp.payout.totalEndMicro,
  '這組假設下再投入的期末比較高 —— 那是這組假設算出來的，不是誰比較好');

section('案例 4：扣款手續費率');
// 每月 10,000、費率 0.1425% → 可用 9,985.75；零成長 10 年 → 120 × 9,985.75 = 1,198,290
const c4 = run({ feeRate: 0.001425 });
eq(yuan(c4.investedMicro), 1200000, '累積投入還是 1,200,000（手續費也是你付的錢）');
eq(yuan(c4.finalValueMicro), 1198290, '期末市值 1,198,290 元（扣掉 1,710 元手續費）');
eq(yuan(c4.investedMicro) - yuan(c4.finalValueMicro), 1710, '差額剛好是 120 次 × 14.25 元');

section('案例 5：股利扣費（預設關）');
// 起始 1,000,000、配息率 5%、每年一次 → 每次毛額 50,000
//   關閉：50,000
//   開啟：50,000 − 匯費 10 − 2.11%（1,055）= 48,935
const off = run({ amount: 0, startValue: 1000000, growthRate: 0, yieldRate: 5, years: 1 }, { reinvest: false });
eq(yuan(off.dividendPaidOutMicro), 50000, '關閉自動扣費：領到 50,000 元');
const on = run({ amount: 0, startValue: 1000000, growthRate: 0, yieldRate: 5, years: 1, dividendFees: true }, { reinvest: false });
eq(yuan(on.dividendPaidOutMicro), 48935, '開啟：50,000 − 10 − 1,055 = 48,935 元');
eq(yuan(on.dividendTotalMicro), 50000, '毛額仍然是 50,000（扣的是費用，不是配息變少）');
const small = run({ amount: 0, startValue: 100000, growthRate: 0, yieldRate: 5, years: 1, dividendFees: true }, { reinvest: false });
eq(yuan(small.dividendPaidOutMicro), 4990, '5,000 元的配息只扣匯費 10 元 → 4,990');

section('案例 6：股數法 —— 餘額結轉，不捨棄');
// 股價 700、每月 3,000、零成長零配息、1 年
// 逐月：3000→4股餘200；3200→4股餘400；3400→4股餘600；3600→5股餘100；
//       3100→4股餘300；3300→4股餘500；3500→5股餘0；3000→4股餘200；
//       3200→4股餘400；3400→4股餘600；3600→5股餘100；3100→4股餘300
// 共 51 股，餘額 300 元
const c6 = run({ amount: 3000, years: 1, method: 'share', price: 700 });
eq(c6.shares, 51, '買到 51 股');
eq(yuan(c6.leftoverCashMicro), 300, '餘額 300 元結轉著，沒有被丟掉');
eq(yuan(c6.finalValueMicro), 36000, '期末 51 × 700 + 300 = 36,000 元');
eq(yuan(c6.investedMicro), 36000, '投入也是 36,000 —— 零成長時一分錢都沒有不見');
ok(yuan(c6.finalValueMicro) === yuan(c6.investedMicro), '餘額有算進期末市值（不然會憑空少 300 元）');

section('零成長時，兩種算法完全相同');
const gapZero = methodGap(validateInputs({ ...base, amount: 3000, years: 1, method: 'share', price: 700 }).values, { reinvest: true });
eq(yuan(gapZero.diffMicro), 0, '零成長時金額法與股數法期末差距是 0');

section('有成長時，股數法會略低（湊不滿一股的現金沒跟著漲）');
const gap = methodGap(validateInputs({
  ...base, amount: 3000, years: 10, growthRate: 8, yieldRate: 0, method: 'share', price: 700,
}).values, { reinvest: true });
ok(gap.diffMicro > 0n, `金額法比股數法高 ${yuan(gap.diffMicro).toFixed(2)} 元`);
ok(gap.inShares > 0, `相當於 ${gap.inShares.toFixed(3)} 股`);
// 驗收條件（STATUS M4）：這組假設下差距小於一股股價
ok(gap.diffMicro < gap.sharePriceMicro,
  `股數法與金額法的差距小於一股：差距 ${yuan(gap.diffMicro).toFixed(2)} 元 < 期末一股股價 ${yuan(gap.sharePriceMicro).toFixed(2)} 元`);
ok(gap.diffMicro !== 0n, '（對照）差距確實不是 0');

section('期間拉長時差距不一定還小於一股 —— 所以畫面不寫死那句話');
const gapLong = methodGap(validateInputs({
  ...base, amount: 3000, years: 40, growthRate: 8, yieldRate: 0, method: 'share', price: 700,
}).values, { reinvest: true });
ok(gapLong.inShares != null, `40 年的差距相當於 ${gapLong.inShares.toFixed(3)} 股`);
ok(gapLong.diffMicro > gap.diffMicro, '期間越長，差距越大（閒置現金錯過的成長越多）');

section('逐年表');
const c7 = run({ growthRate: 6, yieldRate: 3, dividendFreq: 4, years: 5 });
eq(c7.yearly.length, 5, '五年五列');
everyOf(c7.yearly, (r) => r.investedMicro > 0n && r.valueMicro > 0n, '每一列都有投入與市值');
everyOf(c7.yearly.slice(1), (r, i) => r.investedMicro > c7.yearly[i].investedMicro, '投入逐年增加');
eq(c7.yearly.map((r) => r.year), [1, 2, 3, 4, 5], '年份是 1 到 5');
eq(yuan(c7.yearly.at(-1).valueMicro), yuan(c7.finalValueMicro), '最後一列的市值等於期末市值');

section('高精度：不做任何捨入');
const c8 = run({ amount: 1, growthRate: 7, years: 10 });
ok(c8.finalValueMicro % 1000000n !== 0n, '期末市值有小數（沒有被捨成整數元）');
ok(yuan(c8.finalValueMicro) > 120, `期末 ${yuan(c8.finalValueMicro).toFixed(6)} 元 > 投入 120 元`);

section('少一個必填欄位就算不出來');
eq(compareScenarios(validateInputs({ ...base, growthRate: '' }).values), null,
  '成長率沒填 → compareScenarios 回 null（不是拿 0% 算一個結果出來）');
eq(simulate(validateInputs({ ...base, growthRate: '' }).values, { reinvest: true }), null, 'simulate 也回 null');

section('禁用詞清單與檢查器');
// 這些詞會把「你給的假設」變成「我們的看法」。
// **畫面上**（含 placeholder、預設值、說明文字）一個都不能出現 —— 那條斷言在
// scripts/calcviewtest.mjs，因為它要看真的渲染出來的 DOM 與屬性，
// 不是掃原始碼：這個檔案的註解本來就會提到這些詞（說明我們不做什麼）。
// 清單在 scripts/banned.mjs，跟 calcviewtest、uikittest 共用同一份（2026-09-23，以前三處各抄一份）
ok(BANNED.length >= 5, `禁用詞 ${BANNED.length} 個：${BANNED.join('、')}`);
detects((text) => BANNED.some((w) => text.includes(w)), {
  shouldHit: ['建議報酬率 5%', '歷史平均約 8%', '保守情境', '預期年化報酬', '常見的 5%'],
  shouldMiss: ['年化價格成長率', '你的假設 A', '這不是預測', '每期扣款金額', '配息再投入'],
}, '禁用詞檢查器有對照組');

section('模組本身沒有任何預設數值');
// 少一個必填欄位就算不出來（上面已經測過）。這裡再從另一個角度確認：
// validateInputs 對完全空白的輸入，values 裡不會冒出任何必填欄位的值。
const blank = validateInputs({});
eq(blank.ok, false, '完全空白的輸入不合法');
noneOf(REQUIRED.map((k) => ({ k, v: blank.values[k] })), (x) => x.v !== undefined,
  '空白輸入時，沒有任何必填欄位被填上預設值');
everyOf(REQUIRED, (k) => typeof blank.errors[k] === 'string', '每個必填欄位都有自己的錯誤訊息');

section('常數');
eq(CONTRIB_FREQ, [1, 2, 3], '每月扣款次數');
eq(DIVIDEND_FREQ, [1, 2, 4, 12], '配息頻率');
eq(METHODS, ['value', 'share'], '兩種算法');

section('試算的手續費率上限：跟定期定額同一條線');
// 同一個單位陷阱在兩頁都有。以前試算這邊的上限是 0.999 —— 等於什麼都沒擋：
// 填 0.1425 會被當成 14.25%，每一期都少扣一成四，而畫面上看不出來。
{
  const base = { amount: 5000, perMonth: 1, years: 10, growthRate: 5, yieldRate: 4, dividendFreq: 1 };
  detects((f) => validateInputs({ ...base, feeRate: f }).errors.feeRate != null, {
    shouldHit: [0.1425, 0.15, 0.5, 0.999, 1, 14.25, 0.0101],
    shouldMiss: [0.001425, 0.0008, 0, 0.01, '', null, undefined],
  }, '把百分比當比例填會被擋，真的比例放行');
  const msg = validateInputs({ ...base, feeRate: 0.1425 }).errors.feeRate;
  ok(String(msg).includes('14.2500%') && String(msg).includes('0.001425'),
    `訊息講得出「你填的等於幾 %」與「應該填什麼」：「${msg}」`);
  eq(MAX_FEE_RATE, 0.01, '上限跟 js/plans.js 一樣是 1%');
}

section('每一檔各自的假設：沒填完的不算，也不會被當成 0');
// 使用者自己提的：0050、0056、00878、2330 的性質差很多，同一組假設算出來沒有意義。
// 這裡守的是**分開算之後的兩件事**：合計等於各檔相加、沒填完的被列出來而不是被當成 0。
{
  const shared = { years: 10, perMonth: 1, dividendFreq: 4, feeRate: 0.001425, dividendFees: false, method: 'value' };
  const legs = [
    { code: '0050', name: '元大台灣50', amount: 6000, startValue: 323100, growthRate: 6, yieldRate: 3 },
    { code: '0056', name: '元大高股息', amount: 3000, startValue: 176000, growthRate: 3, yieldRate: 8 },
    { code: '2330', name: '台積電', amount: '', startValue: 2410000, growthRate: '', yieldRate: '' },
  ];
  const r = compareMulti(legs, shared);

  eq(r.rows.length, 2, '填完的兩檔算進去了');
  eq(r.skipped.length, 1, '沒填完的那一檔沒有算');
  eq(r.skipped[0].code, '2330', '而且講得出是哪一檔');
  everyOf(['年化價格成長率', '年化配息率', '每期扣款金額'], (f) => r.skipped[0].missing.includes(f),
    `也講得出缺哪幾格（${r.skipped[0].missing.join('、')}）`);

  // **合計必須等於各檔相加** —— 差一塊都不行
  const sumEnd = r.rows.reduce((a, x) => a + x.reinvest.totalEndMicro, 0n);
  eq(r.total.reinvest.totalEndMicro, sumEnd, '合計剛好等於每一檔加起來（配息再投入）');
  const sumPay = r.rows.reduce((a, x) => a + x.payout.totalEndMicro, 0n);
  eq(r.total.payout.totalEndMicro, sumPay, '合計剛好等於每一檔加起來（配息領現）');
  eq(r.total.counted, 2, '合計講得出它含幾檔');

  // 手算：0050 投入 ＝ 323,100 起始 ＋ 6,000 × 12 × 10 ＝ 1,043,100
  eq(r.rows[0].reinvest.investedMicro, toMicro(1043100),
    '手算 0050 累積投入 ＝ 323,100 ＋ 6,000 × 12 × 10 ＝ 1,043,100');

  // **每一檔真的用了自己的假設** —— 不是共用同一組
  ok(r.rows[0].values.growthRate === 6 && r.rows[1].values.growthRate === 3,
    `兩檔的成長率各自是 6% 與 3%（${r.rows[0].values.growthRate}、${r.rows[1].values.growthRate}）`);
  ok(r.rows[0].values.yieldRate === 3 && r.rows[1].values.yieldRate === 8,
    '配息率也各自不同');
  // 對照：假設真的不同就一定算出不同的結果
  ok(r.rows[0].reinvest.totalEndMicro !== r.rows[1].reinvest.totalEndMicro,
    '（對照）不同的假設算出不同的結果 —— 不是兩檔共用同一組');
}

section('一檔都沒填完：不回一個 0，回「沒有東西可以算」');
{
  const shared = { years: 10, perMonth: 1, dividendFreq: 1, feeRate: 0, dividendFees: false, method: 'value' };
  const r = compareMulti([{ code: '0050', name: '元大台灣50', amount: '', growthRate: '', yieldRate: '' }], shared);
  eq(r.rows.length, 0, '沒有任何一檔算得出來');
  eq(r.total, null, '**合計是 null，不是 0** —— 0 會被讀成「算出來是零」');
  eq(r.skipped.length, 1, '而且那一檔被列出來');
}

section('空白不是 0：填 0 與留白是兩件事');
{
  const shared = { years: 5, perMonth: 1, dividendFreq: 1, feeRate: 0, dividendFees: false, method: 'value' };
  const zero = compareMulti([{ code: 'A', amount: 1000, startValue: 0, growthRate: 0, yieldRate: 0 }], shared);
  const blank = compareMulti([{ code: 'A', amount: 1000, startValue: 0, growthRate: '', yieldRate: '' }], shared);
  eq(zero.rows.length, 1, '成長率填 0 是有效的假設（他就是要假設不成長）');
  eq(blank.rows.length, 0, '**留白則完全不算**');
  eq(blank.skipped.length, 1, '而且被列進沒算的名單');
  // 手算：不成長不配息，5 年每月扣 1,000 ＝ 60,000
  eq(zero.rows[0].reinvest.totalEndMicro, toMicro(60000),
    '手算 填 0 的那一檔：1,000 × 12 × 5 ＝ 60,000');
}

done('calctest');
