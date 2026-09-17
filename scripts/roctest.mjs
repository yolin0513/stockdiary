// 民國日期換算與交易日曆判斷（npm run roctest）。
//
// 這兩個模組看起來很無聊，但它們錯了會讓**每一個數字**都對不上：
// 日期差一天，當日損益就會拿錯一天的收盤價當基準。

import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import {
  rocCompactToISO, rocSlashToISO, rocCharsToISO, anyRocToISO,
  isoToRocCompact, isoToRocSlash, isoToYyyymmdd, localISODate,
} from '../js/roc.js';
import {
  makeCalendar, isTradingDay, prevTradingDay, tradingDaysBetween,
  latestPublishedTradingDay, todayPending, missingTradingDays, hhmmToMinutes, covers,
  calendarRunway,
} from '../js/market.js';

section('民國 → 西元');
eq(rocCompactToISO('1150910'), '2026-09-10', 'STOCK_DAY_ALL 的 7 碼格式');
eq(rocCompactToISO('0990910'), '2010-09-10', '民國 99 年（7 碼補零）');
eq(rocCompactToISO('990910'), '2010-09-10', '民國 99 年（6 碼）');
eq(rocSlashToISO('115/09/10'), '2026-09-10', 'STOCK_DAY 的斜線格式');
eq(rocSlashToISO('115/9/1'), '2026-09-01', '月日沒補零也要能解');
eq(rocCharsToISO('115年09月10日'), '2026-09-10', '中文年月日格式');
eq(anyRocToISO('115年09月10日'), '2026-09-10', 'anyRocToISO 認得中文格式');
eq(anyRocToISO('115/09/10'), '2026-09-10', 'anyRocToISO 認得斜線格式');
eq(anyRocToISO('1150910'), '2026-09-10', 'anyRocToISO 認得緊湊格式');

section('壞輸入一律回 null，不回一個看起來正常的日期');
const badInputs = ['', '   ', null, undefined, 'abc', '115/13/01', '115/02/30', '1151301', '115-09-10', '20260910'];
everyOf(badInputs, (x) => anyRocToISO(x) === null, '壞掉的民國日期回 null');
eq(rocCompactToISO('1150230'), null, '民國 115 年 2 月 30 日不存在 → null');
eq(rocSlashToISO('115/02/29'), null, '2026 不是閏年，2/29 不存在 → null');
eq(rocSlashToISO('113/02/29'), '2024-02-29', '2024 是閏年，2/29 存在');

section('西元 → 民國');
eq(isoToRocCompact('2026-09-10'), '1150910', 'ISO → 7 碼民國');
eq(isoToRocSlash('2026-09-10'), '115/09/10', 'ISO → 斜線民國');
eq(isoToYyyymmdd('2026-09-10'), '20260910', 'ISO → 查詢參數用的 yyyymmdd');
eq(isoToRocCompact('2026-9-10'), null, '不合法的 ISO 回 null');
eq(isoToRocCompact('2026-02-30'), null, '不存在的日期回 null');

section('往返一致');
const roundTrip = ['2024-02-29', '2026-01-01', '2026-09-10', '2026-12-31'];
everyOf(roundTrip, (iso) => rocCompactToISO(isoToRocCompact(iso)) === iso, '緊湊格式來回轉回得去');
everyOf(roundTrip, (iso) => rocSlashToISO(isoToRocSlash(iso)) === iso, '斜線格式來回轉回得去');

section('localISODate 不受時區影響');
// toISOString() 在台北時間的早上會退成前一天的 UTC 日期 —— 那會讓整個 App 差一天。
const morning = new Date(2026, 8, 11, 7, 30, 0);   // 2026-09-11 07:30 本地
eq(localISODate(morning), '2026-09-11', '早上七點半仍然是 9/11');
ok(morning.toISOString().slice(0, 10) !== localISODate(morning),
  '（對照）toISOString() 在這個時刻確實會給出不同的日期，所以不能用它',
  `toISOString=${morning.toISOString().slice(0, 10)}`);
const lateNight = new Date(2026, 11, 31, 23, 59, 0);
eq(localISODate(lateNight), '2026-12-31', '跨年前一分鐘仍然是 12/31');

// ---------- 交易日曆 ----------
// 固定樣本：2026 年 9 月。9/25（中秋）與 9/28（教師節）休市，週末休市。
const cal = makeCalendar({
  year: 2026,
  tradingDays: [
    '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
    '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
    '2026-09-29', '2026-09-30',
  ],
  closed: [{ date: '2026-09-25', name: '中秋節' }, { date: '2026-09-28', name: '教師節' }],
});

section('交易日判斷');
eq(isTradingDay(cal, '2026-09-11'), true, '9/11 週五是交易日');
eq(isTradingDay(cal, '2026-09-12'), false, '9/12 週六不是交易日');
eq(isTradingDay(cal, '2026-09-25'), false, '9/25 中秋節不是交易日');
eq(isTradingDay(cal, '2025-09-11'), null, '日曆沒涵蓋的年份回 null，不是 false');
eq(covers(cal, '2027-01-04'), false, '2027 年不在這份日曆裡');
detects(
  (d) => isTradingDay(cal, d) === false,
  {
    shouldHit: ['2026-09-12', '2026-09-13', '2026-09-25', '2026-09-28'],
    shouldMiss: ['2026-09-11', '2026-09-14', '2026-09-24', '2026-09-29'],
  },
  '休市判斷有對照組'
);

section('前一個交易日');
eq(prevTradingDay(cal, '2026-09-11'), '2026-09-10', '9/11 的前一交易日是 9/10');
eq(prevTradingDay(cal, '2026-09-14'), '2026-09-11', '週一的前一交易日是上週五，不是週日');
eq(prevTradingDay(cal, '2026-09-29'), '2026-09-24', '連假後第一天的前一交易日跨過 9/25 與 9/28');
eq(prevTradingDay(cal, '2026-09-07'), null, '日曆最前面一天沒有前一交易日 → null');
eq(tradingDaysBetween(cal, '2026-09-23', '2026-09-30'), ['2026-09-23', '2026-09-24', '2026-09-29', '2026-09-30'],
  '區間內的交易日不含休市日');

section('今日資料公布門檻');
const at = (h, m, day = 11) => new Date(2026, 8, day, h, m, 0);
eq(latestPublishedTradingDay(cal, at(9, 30), '15:00'), '2026-09-10', '交易日盤中 → 最新應有收盤是昨天');
eq(latestPublishedTradingDay(cal, at(14, 59), '15:00'), '2026-09-10', '門檻前一分鐘 → 還是昨天');
eq(latestPublishedTradingDay(cal, at(15, 0), '15:00'), '2026-09-11', '剛好到門檻 → 今天');
eq(latestPublishedTradingDay(cal, at(20, 0), '15:00'), '2026-09-11', '晚上 → 今天');
eq(latestPublishedTradingDay(cal, at(20, 0, 12), '15:00'), '2026-09-11', '週六晚上 → 最後一個交易日是週五');
eq(latestPublishedTradingDay(cal, at(20, 0, 25), '15:00'), '2026-09-24', '中秋節晚上 → 9/24');
eq(latestPublishedTradingDay(cal, at(20, 0), '不是時間'), null, '門檻設定壞掉 → 回 null，不要自己選一天');

eq(todayPending(cal, at(13, 40), '15:00'), true, '收盤後、門檻前 → 今日收盤尚未公布');
eq(todayPending(cal, at(15, 1), '15:00'), false, '過了門檻就不是「尚未公布」');
eq(todayPending(cal, at(13, 40, 12), '15:00'), false, '週六不是「今日收盤尚未公布」，是休市');
eq(todayPending(cal, at(13, 40, 25), '15:00'), false, '中秋節不是「尚未公布」，是休市');

section('hhmmToMinutes');
eq(hhmmToMinutes('15:00'), 900, '15:00 是第 900 分鐘');
eq(hhmmToMinutes('00:00'), 0, '00:00 是第 0 分鐘');
eq(hhmmToMinutes('9:05'), 545, '一位數小時也要能解');
everyOf(['', '25:00', '15:60', '15', '15:0', 'abc', null], (s) => hhmmToMinutes(s) === null,
  '壞掉的時間字串回 null');

section('缺漏的交易日');
eq(missingTradingDays(cal, '2026-09-10', '2026-09-11'), ['2026-09-11'], '只差一天');
eq(missingTradingDays(cal, '2026-09-18', '2026-09-29'),
  ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-29'],
  '跨連假的缺漏日不含 9/25 與 9/28');
eq(missingTradingDays(cal, '2026-09-11', '2026-09-11'), [], '已經結算到今天就沒有缺漏');
eq(missingTradingDays(cal, null, '2026-09-11'), ['2026-09-11'],
  '從來沒結算過時只回今天 —— 不要一次回補一整年（會被 TWSE 封 IP）');
noneOf(missingTradingDays(cal, '2026-09-07', '2026-09-30'),
  (d) => d === '2026-09-25' || d === '2026-09-28' || isTradingDay(cal, d) !== true,
  '整個月的缺漏日裡沒有任何一天是休市日');

section('多年份日曆：跨年不會整個停擺');
//
// 這是 A1 在守的東西：舊的單年日曆在 2027-01-01 當天會讓 covers() 對每一天都回 false，
// 於是 latestPublishedTradingDay 回 null、runUpdate 直接回 NO_CALENDAR ——
// **除權息同步與定期定額待確認也一起停**，而且 12 月裡完全沒有提示。

const twoYear = makeCalendar({
  years: {
    2026: { tradingDays: ['2026-12-30', '2026-12-31'], closed: [] },
    2027: { tradingDays: ['2027-01-04', '2027-01-05'], closed: [] },
  },
});
eq(twoYear.years, ['2026', '2027'], '兩個年份都讀進來了');
eq(twoYear.days, ['2026-12-30', '2026-12-31', '2027-01-04', '2027-01-05'],
  '交易日合併成一串，而且是排序好的');
eq(twoYear.year, null, '跨年份的日曆沒有單一「年份」—— 畫面要講範圍，不能講某一年');

eq(covers(twoYear, '2026-12-31'), true, '涵蓋 2026');
eq(covers(twoYear, '2027-01-04'), true, '也涵蓋 2027');
eq(covers(twoYear, '2028-01-03'), false, '2028 不在裡面');
eq(covers(twoYear, '2025-12-31'), false, '2025 也不在裡面');

// **跨年那一步**：2027 的第一個交易日，前一個交易日在 2026 年。
// 單年日曆在這裡只能回 null，整個回補鏈就斷在這裡。
eq(prevTradingDay(twoYear, '2027-01-04'), '2026-12-31',
  '2027 第一個交易日的前一個交易日是 2026-12-31（跨年接得起來）');
eq(isTradingDay(twoYear, '2027-01-04'), true, '2027-01-04 是交易日');
eq(isTradingDay(twoYear, '2027-01-01'), false, '2027-01-01 不是（元旦）');
eq(tradingDaysBetween(twoYear, '2026-12-31', '2027-01-04'), ['2026-12-31', '2027-01-04'],
  '跨年的區間也算得出來');
eq(missingTradingDays(twoYear, '2026-12-30', '2027-01-05'),
  ['2026-12-31', '2027-01-04', '2027-01-05'],
  '跨年的缺漏日回補得出來（以前這裡會是空的）');

// 對照：同一份資料只留 2026，跨年的每一件事都要回 null／false
const oneYear = makeCalendar({ year: 2026, tradingDays: ['2026-12-30', '2026-12-31'] });
eq(covers(oneYear, '2027-01-04'), false, '（對照）只有 2026 的日曆涵蓋不到 2027');
eq(prevTradingDay(oneYear, '2027-01-04'), null, '（對照）所以跨年那一步只能回 null');
eq(missingTradingDays(oneYear, '2026-12-30', '2027-01-05'), [],
  '（對照）缺漏日也是空的 —— 這正是跨年停擺的樣子');

section('日曆快用完了要提前講');
//
// 45 天：證交所通常第四季才公布隔年的休市日，11 月中開始提醒還來得及讓人更新 App。
// 實測（2026-09-17）openapi 的 holidaySchedule 目前**只有民國 115 年（2026）**，
// 一筆 116 年的都沒有 —— 所以這個提醒是目前唯一的防線。

const endOf2026 = makeCalendar({ year: 2026, tradingDays: ['2026-06-01', '2026-12-31'] });
const runwayAt = (iso) => calendarRunway(endOf2026, new Date(`${iso}T10:00:00`));

eq(runwayAt('2026-12-31').daysLeft, 0, '最後一天當天剩 0 天');
eq(runwayAt('2026-11-16').daysLeft, 45, '11/16 剩 45 天');
eq(runwayAt('2026-11-17').daysLeft, 44, '11/17 剩 44 天');
eq(runwayAt('2026-11-16').warn, true, '剛好 45 天就開始提醒');
eq(runwayAt('2026-11-15').warn, false, '46 天的時候還不提醒');
eq(runwayAt('2026-09-17').warn, false, '今天（9/17，剩 105 天）不提醒');
eq(runwayAt('2027-01-05').daysLeft, -5, '已經過期就是負的');
eq(runwayAt('2027-01-05').warn, true, '過期了當然要提醒');
eq(runwayAt('2026-12-31').lastDay, '2026-12-31', '講得出涵蓋到哪一天');

// 門檻可以調，而且**調了真的會改變結果**（不然上面每一條都可能是巧合）
eq(calendarRunway(endOf2026, new Date('2026-09-17T10:00:00'), 200).warn, true,
  '門檻放寬到 200 天，9/17 就會提醒了');
eq(calendarRunway(endOf2026, new Date('2026-11-16T10:00:00'), 10).warn, false,
  '門檻收緊到 10 天，11/16 就不提醒了');

// 沒有日曆的時候不能假裝知道
eq(calendarRunway(makeCalendar({}), new Date('2026-11-16T10:00:00')),
  { lastDay: null, daysLeft: null, warn: false },
  '沒有日曆就回 null，不要猜一個天數出來');

// 多年份日曆看的是**最後一年**的最後一天
eq(calendarRunway(twoYear, new Date('2026-11-16T10:00:00')).lastDay, '2027-01-05',
  '有 2027 的話，看的是 2027 的最後一天');
eq(calendarRunway(twoYear, new Date('2026-11-16T10:00:00')).warn, false,
  '補上 2027 之後，11/16 就不必再提醒了');

done('roctest');
