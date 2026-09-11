// 持股變動的純邏輯（npm run changestest）。
//
// 核心不變式：**股數 = 所有「已確認」變動的總和。**
// 未確認的不能算進去 —— 使用者還沒對過券商通知，那個數字還不是真的。
// 而且要回推得出「某一天收盤時手上有幾股」，缺漏日的損益才補得回來。

import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { sharesFromChanges, sharesOn, pendingOf, validateChange, KINDS, STATUSES } from '../js/holdings.js';

const c = (date, delta, status = 'confirmed', kind = 'manual') =>
  ({ id: `${date}-${delta}`, code: '2330', date, deltaShares: delta, kind, status });

const CHANGES = [
  c('2026-01-05', 1000, 'confirmed', 'opening'),
  c('2026-03-16', 500, 'confirmed', 'dca'),
  c('2026-06-16', 300, 'confirmed', 'dca'),
  c('2026-07-20', -200, 'confirmed'),
  c('2026-09-16', 400, 'pending', 'dca'),      // 還沒確認
];

section('股數是已確認變動的總和');
// 手算：1000 + 500 + 300 − 200 = 1600（9/16 那筆還沒確認，不算）
eq(sharesFromChanges(CHANGES), 1600, '1000 + 500 + 300 − 200 = 1600');
ok(sharesFromChanges(CHANGES) !== 2000, '沒有把未確認的 400 股算進去（那會是 2000）');
eq(sharesFromChanges([]), 0, '沒有任何變動 → 0 股');
eq(sharesFromChanges(CHANGES.filter((x) => x.status === 'pending')), 0, '全部都未確認 → 0 股');
noneOf(CHANGES.filter((x) => x.status === 'pending'), (x) => x.deltaShares === 0,
  '（前提）測試資料裡的未確認變動不是 0 股，不然上一條證明不了什麼');

section('某一天收盤時有幾股');
eq(sharesOn(CHANGES, '2026-01-04'), 0, '買進前一天：0 股');
eq(sharesOn(CHANGES, '2026-01-05'), 1000, '買進當天就算進去（當天收盤已經持有）');
eq(sharesOn(CHANGES, '2026-03-15'), 1000, '第二次扣款前：1000 股');
eq(sharesOn(CHANGES, '2026-03-16'), 1500, '第二次扣款當天：1500 股');
eq(sharesOn(CHANGES, '2026-06-30'), 1800, '六月底：1800 股');
eq(sharesOn(CHANGES, '2026-07-20'), 1600, '賣出當天：1600 股');
eq(sharesOn(CHANGES, '2026-12-31'), 1600, '年底仍是 1600（9/16 那筆還沒確認）');
ok(sharesOn(CHANGES, '2026-12-31') !== sharesFromChanges(CHANGES) + 400,
  '未確認的變動不會因為日期過了就自己生效');

// 回推整條時間線：每一天的股數都不能是負的
const timeline = ['2026-01-04', '2026-01-05', '2026-03-16', '2026-06-16', '2026-07-20', '2026-12-31']
  .map((d) => ({ date: d, shares: sharesOn(CHANGES, d) }));
everyOf(timeline, (t) => t.shares >= 0, '時間線上每一天的股數都不是負的');
eq(timeline.at(-1).shares, sharesFromChanges(CHANGES), '時間線最後一天的股數等於「已確認總和」');
ok(new Set(timeline.map((t) => t.shares)).size > 1,
  `（前提）時間線上的股數真的有變動過：${timeline.map((t) => t.shares).join(' → ')}`);

section('待確認清單');
const pend = pendingOf(CHANGES);
eq(pend.length, 1, '一筆待確認');
eq(pend[0].date, '2026-09-16', '就是 9/16 那筆');
everyOf(pend, (x) => x.status === 'pending', '清單裡全部都是 pending');
noneOf(pend, (x) => x.status === 'confirmed', '沒有混進已確認的');

// 多筆待確認要照日期排序（跳過三個月再開 App 會一次冒出好幾筆）
const many = [
  c('2026-08-16', 100, 'pending', 'dca'),
  c('2026-06-16', 100, 'pending', 'dca'),
  c('2026-07-16', 100, 'pending', 'dca'),
];
eq(pendingOf(many).map((x) => x.date), ['2026-06-16', '2026-07-16', '2026-08-16'], '照日期排序');

section('新增變動前的檢查');
const base = { code: '2330', date: '2026-09-11', deltaShares: 1000, kind: 'manual', status: 'confirmed' };
eq(validateChange(base), null, '正常的變動通過');
eq(validateChange({ ...base, code: '' }), '沒有代號', '沒代號');
eq(validateChange({ ...base, date: '2026/09/11' }), '日期格式不對', '日期格式不對');
eq(validateChange({ ...base, date: '115-09-11' }), '日期格式不對', '民國年不是 ISO 日期');
eq(validateChange({ ...base, deltaShares: 0 }), '股數要是不為零的數字', '0 股的變動沒有意義');
eq(validateChange({ ...base, deltaShares: 'abc' }), '股數要是不為零的數字', '非數字');
eq(validateChange({ ...base, deltaShares: 10.5 }), '股數要是整數', '不能有小數股');
eq(validateChange({ ...base, deltaShares: -500 }), null, '負數（賣出）是合法的');
ok(/不認得的變動類型/.test(validateChange({ ...base, kind: 'buy' })), '不認得的類型');
ok(/不認得的狀態/.test(validateChange({ ...base, status: 'done' })), '不認得的狀態');

detects(
  (x) => validateChange(x) !== null,
  {
    shouldHit: [
      { ...base, deltaShares: 0 },
      { ...base, date: 'tomorrow' },
      { ...base, kind: 'buy' },
      { ...base, code: '' },
    ],
    shouldMiss: [
      base,
      { ...base, deltaShares: -1 },
      { ...base, kind: 'dca', status: 'pending' },
      { ...base, kind: 'stockDividend' },
    ],
  },
  '檢查器有對照組'
);

section('類型與狀態的清單');
everyOf(KINDS, (k) => typeof k === 'string' && k.length > 0, `變動類型：${KINDS.join('、')}`);
eq(STATUSES, ['pending', 'confirmed'], '狀態只有兩種');
ok(KINDS.includes('opening'), '有「快速設定持股」用的 opening');
ok(KINDS.includes('dca') && KINDS.includes('dividendReinvest') && KINDS.includes('stockDividend'),
  '定期定額、配息再投入、配股的類型都先留好了');

done('changestest');
