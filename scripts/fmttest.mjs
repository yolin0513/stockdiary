// 顯示格式（npm run fmttest）。
//
// 這個檔只守一條規則，但它是整個 App 最重要的一條：
// **拿不到的數字顯示「—」，永遠不顯示 0。**
//
// 「今日收盤尚未公布時顯示 0」會讓使用者以為今天真的沒賺沒賠。
// 那不是顯示問題，是講了一句不實的話。

import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { fmtMoney, fmtPrice, fmtPct, fmtShares, fmtDate, NO_VALUE } from '../js/ui.js';

const NOTHING = [null, undefined, NaN, Infinity, -Infinity, '', 'abc', {}];

section('拿不到的數字一律「—」');
eq(NO_VALUE, '—', '沒有值的顯示符號是全形破折號');
everyOf(NOTHING, (v) => fmtMoney(v) === NO_VALUE, 'fmtMoney 對所有「沒有值」回「—」');
everyOf(NOTHING, (v) => fmtPrice(v) === NO_VALUE, 'fmtPrice 對所有「沒有值」回「—」');
everyOf(NOTHING, (v) => fmtPct(v) === NO_VALUE, 'fmtPct 對所有「沒有值」回「—」');
everyOf(NOTHING, (v) => fmtShares(v) === NO_VALUE, 'fmtShares 對所有「沒有值」回「—」');
noneOf(NOTHING.map((v) => fmtMoney(v)), (s) => /\d/.test(s), '「沒有值」的輸出裡不含任何數字');
noneOf(NOTHING.map((v) => fmtPct(v)), (s) => /\d/.test(s), '百分比也是');

section('對照組：真的是 0 的時候，就要顯示 0');
eq(fmtMoney(0), '0', '金額 0 顯示成 0');
eq(fmtPct(0), '0.00%', '報酬率 0 顯示成 0.00%');
eq(fmtPrice(0), '0.00', '價格 0 顯示成 0.00');
ok(fmtMoney(0) !== NO_VALUE, '真的是 0 不能顯示成「—」—— 不然這個測試分不出兩者');
detects(
  (v) => fmtMoney(v) === NO_VALUE,
  { shouldHit: [null, undefined, NaN], shouldMiss: [0, -1, 1, 1234.5] },
  '「沒有值」與「值是 0」分得開'
);

section('金額');
eq(fmtMoney(1234), '1,234', '千分位');
eq(fmtMoney(1234567), '1,234,567', '百萬');
eq(fmtMoney(-1234), '-1,234', '負數帶負號');
eq(fmtMoney(1234, { sign: true }), '+1,234', 'sign 開啟時正數帶正號');
eq(fmtMoney(-1234, { sign: true }), '-1,234', 'sign 開啟時負數還是負號');
eq(fmtMoney(0, { sign: true }), '0', '0 不加正號');
eq(fmtMoney(1234.6), '1,235', '金額四捨五入到元');
eq(fmtMoney(-1234.6), '-1,235', '負金額也四捨五入到元');

section('價格與百分比');
eq(fmtPrice(2450), '2,450.00', '價格固定兩位小數');
eq(fmtPrice(9.73), '9.73', '個位數價格');
eq(fmtPrice(0.125), '0.13', '每股配息 0.125 顯示 0.13（兩位小數）');
eq(fmtPct(-0.52), '-0.52%', '負報酬率');
eq(fmtPct(12.3456, { sign: true }), '+12.35%', '正報酬率帶正號、兩位小數');

section('股數');
eq(fmtShares(1000), '1,000', '股數千分位');
eq(fmtShares(0), '0', '0 股就是 0 股');
eq(fmtShares(1234.6), '1,235', '股數四捨五入成整數');

section('日期');
eq(fmtDate('2026-09-10'), '9/10', 'ISO 日期顯示成 M/D');
eq(fmtDate('2026-01-02'), '1/2', '不補零');
everyOf(['', null, undefined, '2026/09/10', '115-09-10', 'abc'],
  (v) => fmtDate(v) === NO_VALUE, '壞掉的日期顯示「—」，不顯示今天');

done('fmttest');
