// 每日損益日曆的純邏輯（npm run plcaltest）：js/plcal.js。
//
// 要守的三件事（Dispatch 2026-09-30）：
//   1. 沒有資料的日子**不可以顯示 0 或留白**；「有結算但算不出」與「沒有紀錄」是兩種不同的顯示，測試要分得開。
//   2. 母體檢查：顯示的月份裡「有資料」的天數＝資料來源這個月實際有的紀錄數——跨月、跨年、閏年、月初月末都要對。
//   3. 休市日的來源講清楚：data/calendar.json 涵蓋到哪一年；超出涵蓋範圍的日子標「日曆未涵蓋」，不猜。
// 每條斷言的訊息前面有固定標籤（「日曆狀態：」「日曆母體：」…），突變的 expect 對它。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done } from './tap.mjs';
import { makeCalendar } from '../js/market.js';
import {
  CELL, CELL_TEXT, buildMonth, monthCoverage, daysInMonth, shiftMonth, firstWeekday,
  firstRecordDate, compactMoney, signClass, uncomputableReason, cellText,
} from '../js/plcal.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cal = makeCalendar(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8')));
const Y = (yuan) => String(BigInt(Math.round(yuan * 1e6)));   // 元 → 結算紀錄裡的微元字串

// 合成的結算紀錄（不是誰的真實資料）。2026-09 用真的開休市日：09-05／06 週末、09-25 中秋、09-28 教師節。
const ROWS = [
  { date: '2026-08-31', dayPL: Y(100), counted: 1 },                     // 上個月最後一天：不能算進九月
  { date: '2026-09-01', dayPL: Y(12345), counted: 2 },                   // 月初、賺
  { date: '2026-09-02', dayPL: null, counted: 0, excludedMissing: 1,     // 有結算、算不出
    byCode: [{ code: '0050', status: 'exNoRef' }] },
  { date: '2026-09-03', dayPL: Y(0), counted: 2 },                       // 真的算出 0
  // 09-04（交易日）沒有紀錄 → 無資料
  { date: '2026-09-15', dayPL: Y(-850), counted: 2 },                    // 賠；這是最後一筆
  { date: '2026-10-01', dayPL: Y(1), counted: 1 },                       // 下個月第一天：不能算進九月
];
const TODAY = '2026-09-26';
const sep = buildMonth({ ym: '2026-09', rows: ROWS, calendar: cal, today: TODAY });
const at = (cells, date) => cells.find((c) => c.date === date);

section('日曆資料來源');
ok(cal.years.length > 0 && cal.days.length > 200, `（前提）開休市日有資料：涵蓋 ${cal.years.join('、')} 年，${cal.days.length} 個交易日`);

section('每一格的狀態');
eq(at(sep, '2026-09-01').state, CELL.VALUE, '日曆狀態：有結算、算得出的日子 → value');
eq(at(sep, '2026-09-02').state, CELL.UNCOMPUTABLE, '日曆狀態：有結算但算不出（dayPL 是 null）→ uncomputable');
eq(at(sep, '2026-09-04').state, CELL.NO_DATA, '日曆狀態：交易日、沒有紀錄、在最後一筆之前 → noData');
ok(cellText(at(sep, '2026-09-02')) !== cellText(at(sep, '2026-09-04')),
  `日曆狀態：「算不出」與「無資料」顯示的字不一樣（${cellText(at(sep, '2026-09-02'))}／${cellText(at(sep, '2026-09-04'))}）`);
{
  // 「未結算」只給最後一筆結算之後的日子；夾在兩筆紀錄中間、沒有紀錄的交易日是「無資料」
  const upToMid = ROWS.filter((r) => r.date <= '2026-09-15');
  eq(at(buildMonth({ ym: '2026-09', rows: upToMid, calendar: cal, today: TODAY }), '2026-09-16').state, CELL.PENDING,
    '日曆狀態：交易日、在最後一筆結算之後、今天以前 → pending');
  eq(at(sep, '2026-09-16').state, CELL.NO_DATA, '日曆狀態：交易日沒有紀錄、但之後還有紀錄（中間漏了）→ noData，不是 pending');
}
eq(at(sep, '2026-09-05').state, CELL.CLOSED, '日曆狀態：週六 → closed');
eq(at(sep, '2026-09-25').state, CELL.CLOSED, '日曆狀態：國定假日（中秋）→ closed');
eq(at(sep, '2026-09-25').closedName, '中秋節', '日曆狀態：休市的名稱取自 data/calendar.json');
eq(at(sep, '2026-09-06').closedName, '週日', '日曆狀態：週末沒有名稱時寫週六／週日');
eq(at(sep, '2026-09-29').state, CELL.FUTURE, '日曆狀態：今天以後 → future');
{
  // 「有紀錄一律優先」：結算紀錄落在日曆說的休市日（不該發生，但真的發生就照紀錄顯示，不藏起來）
  const jan = buildMonth({ ym: '2026-01', rows: [{ date: '2026-01-01', dayPL: Y(5), counted: 1 }], calendar: cal, today: '2026-01-31' });
  eq(at(jan, '2026-01-01').state, CELL.VALUE, '日曆狀態：有紀錄的日子照紀錄顯示，就算日曆說那天休市');
}

section('沒有資料的日子不是 0，也不是留白');
const nonValue = sep.filter((c) => [CELL.NO_DATA, CELL.UNCOMPUTABLE, CELL.PENDING, CELL.CLOSED].includes(c.state));
ok(nonValue.length >= 4, `（前提）九月裡有 ${nonValue.length} 格是沒有數字的狀態`);
ok(nonValue.every((c) => cellText(c) && cellText(c) !== '0' && !/^[+-]?0$/.test(cellText(c))),
  '日曆零值：沒有數字的每一格都顯示狀態字，不是 0、不是空白', JSON.stringify(nonValue.map((c) => [c.date, cellText(c)])));
ok(nonValue.every((c) => c.dayPL == null), '日曆零值：沒有數字的格子 dayPL 是 null（不是被補成 0）');
eq(cellText(at(sep, '2026-09-03')), '0', '日曆零值：真的算出 0 的那天顯示 0（那是資料，不是沒資料）');
eq(CELL_TEXT.noData, '無資料', '日曆零值：無資料的字');
eq(CELL_TEXT.uncomputable, '算不出', '日曆零值：算不出的字');

section('母體：畫出「有資料」的天數＝資料來源這個月的紀錄數（跨月、跨年、閏年、月初月末）');
{
  const c = monthCoverage(sep, ROWS, '2026-09');
  eq([c.shown, c.source], [4, 4], '日曆母體：九月有 4 筆紀錄（8/31、10/1 不算），畫出 4 格有資料');
  ok(c.ok, '日曆母體：九月相等');
  eq(sep.length, 30, '日曆母體：九月畫出 30 天');
  const dec = buildMonth({ ym: '2026-12', rows: [{ date: '2026-12-31', dayPL: Y(3), counted: 1 }, { date: '2027-01-04', dayPL: Y(4), counted: 1 }], calendar: cal, today: '2027-01-10' });
  eq(at(dec, '2026-12-31')?.state, CELL.VALUE, '日曆母體：月底（12/31）那一格畫得出來');
  ok(monthCoverage(dec, [{ date: '2026-12-31' }, { date: '2027-01-04' }], '2026-12').ok, '日曆母體：跨年——十二月不含隔年一月的紀錄，而且相等');
  eq(shiftMonth('2026-12', 1), '2027-01', '日曆母體：十二月的下一個月是隔年一月');
  eq(shiftMonth('2026-01', -1), '2025-12', '日曆母體：一月的上一個月是前一年十二月');
  eq(shiftMonth('2026-09', 1), '2026-10', '日曆母體：一般的下一個月');
  eq([daysInMonth('2026-02'), daysInMonth('2028-02'), daysInMonth('2100-02'), daysInMonth('2000-02')], [28, 29, 28, 29],
    '日曆母體：二月的天數（2028、2000 是閏年，2100 不是）');
  eq([daysInMonth('2026-01'), daysInMonth('2026-04'), daysInMonth('2026-12')], [31, 30, 31], '日曆母體：大月小月的天數');
  const leap = buildMonth({ ym: '2028-02', rows: [{ date: '2028-02-29', dayPL: Y(9), counted: 1 }], calendar: cal, today: '2028-03-01' });
  eq(leap.length, 29, '日曆母體：閏年二月畫出 29 天');
  eq(at(leap, '2028-02-29')?.state, CELL.VALUE, '日曆母體：閏年 2/29 的紀錄畫得出來');
  ok(monthCoverage(leap, [{ date: '2028-02-29' }], '2028-02').ok, '日曆母體：閏年二月相等');
  // 檢查器自己的對照：少畫一天，母體檢查要報不相等
  ok(!monthCoverage(sep.slice(1), ROWS, '2026-09').ok, '（對照）日曆母體：少畫月初那一天，母體檢查報不相等');
}

section('超出開休市日涵蓋範圍：標「日曆未涵蓋」，不猜');
{
  const last = cal.years.at(-1);
  const nextYear = String(Number(last) + 1);
  ok(!cal.years.includes(nextYear), `（前提）開休市日沒有 ${nextYear} 年`);
  const jan = buildMonth({ ym: `${nextYear}-01`, rows: [{ date: `${nextYear}-01-05`, dayPL: Y(7), counted: 1 }], calendar: cal, today: `${nextYear}-01-31` });
  eq(at(jan, `${nextYear}-01-06`).state, CELL.UNCOVERED, '日曆未涵蓋：沒有紀錄的平日 → uncovered（不猜是不是交易日）');
  eq(at(jan, `${nextYear}-01-03`).state, CELL.UNCOVERED, '日曆未涵蓋：週末也標 uncovered（補班、休市都猜不得）');
  eq(at(jan, `${nextYear}-01-05`).state, CELL.VALUE, '日曆未涵蓋：有結算紀錄的日子照樣顯示');
  ok(cellText(at(jan, `${nextYear}-01-06`)) === '未涵蓋', '日曆未涵蓋：顯示的字是「未涵蓋」，不是無資料、不是 0');
}

section('其他');
eq(firstWeekday('2026-09'), 2, '2026-09-01 是週二（格子前面空兩格）');
eq(firstRecordDate(ROWS), '2026-08-31', '歷史的起點是最早那一筆');
eq(firstRecordDate([]), null, '沒有紀錄時起點是 null');
eq([compactMoney(Y(12345)), compactMoney(Y(-850)), compactMoney(Y(0)), compactMoney(Y(-123456)), compactMoney(null)],
  ['+1.2萬', '-850', '0', '-12.3萬', null], '格子裡的金額：萬以上寫萬、正數帶 +、null 就是 null');
eq([signClass(Y(1)), signClass(Y(-1)), signClass(Y(0)), signClass(null)], ['v-up', 'v-down', 'v-flat', 'v-none'],
  '日曆顏色：賺 v-up（紅）、賠 v-down（綠）、0 不上色、沒資料灰');
ok(/0050/.test(uncomputableReason(ROWS[2])) && /1 檔沒有取得收盤價/.test(uncomputableReason(ROWS[2])),
  '算不出的原因講得出是哪一檔、缺什麼', uncomputableReason(ROWS[2]));

done('plcaltest');
