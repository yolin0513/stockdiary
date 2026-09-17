// 靜態資料檔與代號判斷（npm run datatest）。
//
// 兩件事在這裡守住：
//   · data/calendar.json 的交易日要跟 TWSE 實際有成交的日子一致
//     （2026 年 2 月那一串是用 STOCK_DAY 實際回應核對過的，見 scripts/livecheck.mjs）
//   · 上櫃／興櫃代號永遠判成「不支援」，而且提示文字裡不出現任何價格

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { isTradingMarker, classifyHolidaySchedule, tradingDaysOfYear } from './build-calendar.mjs';
import * as catalog from '../js/catalog.js';
import { makeCalendar, isTradingDay, covers } from '../js/market.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(ROOT + p, 'utf8'));

// ---------- 休市表的分類 ----------
section('holidaySchedule：哪些是休市、哪些是「照常交易」的標記');
detects(
  (name) => isTradingMarker({ Name: name }),
  {
    shouldHit: ['國曆新年開始交易日', '農曆春節前最後交易日', '農曆春節後開始交易日', '補行交易日'],
    shouldMiss: ['中華民國開國紀念日', '農曆除夕及春節', '市場無交易，僅辦理結算交割作業', '中秋節', '國慶日'],
  },
  '「照常交易」的標記判斷有對照組'
);

const schedule = readJson('/scripts/fixtures/holiday-schedule-115.json');
ok(schedule.length === 27, `固定樣本有 ${schedule.length} 筆公告`);
const cls = classifyHolidaySchedule(schedule);
eq(cls.bad.length, 0, '每一筆的日期都解得出來');
eq(cls.tradingMarkers.map((m) => m.date).sort(),
  ['2026-01-02', '2026-02-11', '2026-02-23'],
  '三個「照常交易」的日子被挑出來，沒有被當成休市');
noneOf(cls.closed, (c) => isTradingMarker({ Name: c.name }), '休市清單裡沒有混進照常交易的標記');
ok(cls.closed.some((c) => c.date === '2026-02-12' && c.name.includes('市場無交易')),
  '「市場無交易，僅辦理結算交割作業」算休市');

section('由休市表推出整年交易日');
const days = tradingDaysOfYear(2026, cls.closed, cls.tradingMarkers);
ok(days.length > 200 && days.length < 260, `2026 年推出 ${days.length} 個交易日`);
noneOf(days, (d) => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}, '交易日裡沒有週六週日');
noneOf(days, (d) => cls.closed.some((c) => c.date === d), '交易日裡沒有任何休市日');
everyOf(cls.tradingMarkers, (m) => days.includes(m.date), '三個「照常交易」的日子都在交易日裡');

// ---------- 產出的 calendar.json ----------
section('data/calendar.json');
const calJson = readJson('/data/calendar.json');

// **多年份格式**：{ years: { "2026": { tradingDays, closed }, ... } }
// 改成多年是因為單年的日曆在 1/1 當天會讓整個更新流程停擺 —— covers() 對每一天
// 都回 false，除權息同步與定期定額待確認也一起停，而且事前沒有任何提示。
ok(calJson.years && typeof calJson.years === 'object' && !Array.isArray(calJson.years),
  '是多年份格式（有 years 這個物件）');
const calYears = Object.keys(calJson.years).sort();
ok(calYears.length >= 1, `涵蓋 ${calYears.length} 個年份：${calYears.join('、')}`);
everyOf(calYears, (y) => /^\d{4}$/.test(y), '每個年份都是四位數西元年');
ok(calYears.includes('2026'), '2026 年在裡面');

// 每一年自己的內容都要成立 —— 只驗合併後的總數的話，某一年整個是空的也看不出來
for (const y of calYears) {
  const one = calJson.years[y];
  ok(Array.isArray(one.tradingDays) && one.tradingDays.length > 200,
    `${y} 年有 ${one.tradingDays?.length} 個交易日`);
  everyOf(one.tradingDays, (d) => d.startsWith(`${y}-`) && /^\d{4}-\d{2}-\d{2}$/.test(d),
    `${y} 年的每一天都是那一年的 ISO 日期`);
  eq([...new Set(one.tradingDays)].length, one.tradingDays.length, `${y} 年沒有重複的日期`);
  eq([...one.tradingDays].sort().join(), one.tradingDays.join(), `${y} 年的日期是排序好的`);
}

// 舊格式（單一 year）也要讀得懂 —— 使用者手機上可能還存著舊的 calendar.json
// （SW 快取），換版當下不能因為格式變了就整個壞掉。
const legacyJson = {
  year: 2026,
  tradingDays: calJson.years['2026'].tradingDays,
  closed: calJson.years['2026'].closed,
};
const legacyCal = makeCalendar(legacyJson);
eq(legacyCal.years, ['2026'], '舊的單年格式讀進來也會有 years');
eq(legacyCal.days.length, calJson.years['2026'].tradingDays.length, '而且交易日一天都不少');
eq(isTradingDay(legacyCal, '2026-09-25'), false, '舊格式一樣判斷得出中秋節休市');
eq(covers(legacyCal, '2027-01-04'), false, '舊格式涵蓋不到 2027（本來就不該涵蓋）');

// 對照：格式壞掉的不能被當成「有日曆」
eq(makeCalendar({}).days.length, 0, '（對照）空物件不會生出任何交易日');
eq(makeCalendar({ years: {} }).years, [], '（對照）years 是空的就是沒有年份');
eq(covers(makeCalendar({ years: {} }), '2026-03-02'), false,
  '（對照）沒有年份的日曆什麼都涵蓋不到');

// 合併後的整體
const allDays = calYears.flatMap((y) => calJson.years[y].tradingDays);
ok(allDays.length > 200, `合起來共 ${allDays.length} 個交易日`);
const calJsonDays2026 = calJson.years['2026'].tradingDays;

// 2026 年 2 月最難：農曆春節 + 和平紀念日補假。這一串是拿 2330 的 STOCK_DAY
// 實際回應核對過的（npm run livecheck 會再對一次真網路）。
eq(calJsonDays2026.filter((d) => d.startsWith('2026-02')),
  ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06',
    '2026-02-09', '2026-02-10', '2026-02-11',
    '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26'],
  '2026 年 2 月的交易日與 TWSE 實際成交日一致（春節休到 2/20、2/27 補假）');

const cal = makeCalendar(calJson);
eq(isTradingDay(cal, '2026-09-25'), false, '中秋節休市');
eq(isTradingDay(cal, '2026-01-01'), false, '元旦休市');
eq(isTradingDay(cal, '2026-01-02'), true, '元旦隔天照常交易');

// ---------- 產出的 stocks.json ----------
section('data/stocks.json');
const stocksJson = readJson('/data/stocks.json');
const entries = Object.entries(stocksJson.stocks);
ok(entries.length > 2000, `共 ${entries.length} 檔證券`);
everyOf(entries, ([code]) => /^[0-9A-Z]{4,6}$/.test(code), '代號格式都正常');
everyOf(entries, ([, s]) => typeof s.name === 'string' && s.name.length > 0, '每一檔都有名稱');
everyOf(entries, ([, s]) => ['上市', '上櫃', '興櫃'].includes(s.market),
  '市場別只有上市／上櫃／興櫃三種');
noneOf(entries, ([, s]) => /認購|認售|權證/.test(String(s.type ?? '')), '權證沒有被放進來');

const byMarket = {};
for (const [, s] of entries) byMarket[s.market] = (byMarket[s.market] || 0) + 1;
ok(byMarket['上市'] > 1000, `上市 ${byMarket['上市']} 檔`);
ok(byMarket['上櫃'] > 500, `上櫃 ${byMarket['上櫃']} 檔`);
ok(byMarket['興櫃'] > 100, `興櫃 ${byMarket['興櫃']} 檔`);

const etfs = entries.filter(([, s]) => s.type === 'ETF');
ok(etfs.length > 0, `ETF ${etfs.length} 檔`);
ok(stocksJson.stocks['0050']?.type === 'ETF', '0050 元大台灣50 是 ETF');
everyOf(etfs, ([, s]) => s.market === '上市' || s.market === '上櫃', 'ETF 的市場別正常');

ok(Object.keys(stocksJson.industries).length >= 30,
  `產業別 ${Object.keys(stocksJson.industries).length} 種`);
everyOf(Object.entries(stocksJson.industries), ([code, name]) => /^\d{2}$/.test(code) && name.length > 0,
  '產業別是「兩位數代碼 → 名稱」');

// ---------- 代號查詢 ----------
section('代號查詢：上櫃／興櫃永遠不支援');
catalog.__setDataForTest(stocksJson);

const tsmc = catalog.lookup('2330');
eq(tsmc.found, true, '2330 找得到');
eq(tsmc.market, '上市', '2330 是上市');
eq(tsmc.supported, true, '2330 支援報價');
eq(tsmc.industry, '半導體業', '2330 產業別');

const gws = catalog.lookup('6488');
eq(gws.found, true, '6488 找得到');
eq(gws.market, '上櫃', '6488 是上櫃');
eq(gws.supported, false, '6488 不支援報價');

const emerging = Object.entries(stocksJson.stocks).find(([, s]) => s.market === '興櫃');
eq(catalog.lookup(emerging[0]).supported, false, `興櫃 ${emerging[0]} 不支援報價`);

eq(catalog.lookup('9999').found, false, '9999 不存在');
eq(catalog.lookup('9999').supported, undefined, '不存在的代號沒有 supported 欄位，不會被誤判成支援');
eq(catalog.lookup('').found, false, '空字串不存在');
eq(catalog.lookup('2330 ').code, '2330', '前後空白會被去掉');
eq(catalog.lookup('00632r').code, '00632R', '小寫代號轉大寫');

noneOf(entries.filter(([, s]) => s.market !== '上市'), ([code]) => catalog.lookup(code).supported === true,
  '所有非上市的代號都判成不支援');
everyOf(entries.filter(([, s]) => s.market === '上市').slice(0, 200), ([code]) => catalog.lookup(code).supported === true,
  '上市代號都判成支援（抽前 200 檔）');

detects(
  (code) => catalog.lookup(code).supported === true,
  {
    shouldHit: ['2330', '0050', '2317', '1101'],
    shouldMiss: ['6488', '6547', emerging[0], '9999', '', 'abcd'],
  },
  '「支援報價」的判斷有對照組'
);

section('不支援的提示文字裡不能出現價格');
const msg = catalog.unsupportedMessage(gws);
ok(msg.includes('上櫃'), `講清楚是哪個市場：「${msg}」`);
ok(msg.includes('不會顯示價格'), '明講不會顯示價格');
// 提示句裡唯一該出現的數字是代號本身。出現小數就是漏了價格進來。
noneOf([msg], (t) => /\d+\.\d+/.test(t), '提示文字裡沒有任何小數（價格長那樣）');
eq(catalog.unsupportedMessage({ found: false }), '找不到這個代號', '不存在的代號有自己的文案');

section('代號表過期提醒（B3）');
//
// 使用者想加一檔新上市的股票，代號表還沒收進去 —— 畫面只會說「找不到代號」，
// 而那句話會讓人以為自己打錯了。超過 60 天就多講一句，他才知道下一步是更新 App。
//
// SPEC §4 B3 的決定：**不打 STOCK_DAY 試查**未在清單的代號
//（那會多出一種「未在清單」的持股，每一個畫面都要處理它），改成過期提醒。

const catDay = catalog.catalogDate();
ok(/^\d{4}-\d{2}-\d{2}$/.test(String(catDay)), `（前提）代號表有產生日期：${catDay}`);
const at = (days) => new Date(Date.parse(`${catDay}T00:00:00`) + days * 86400000 + 36000000);

// 門檻兩側。寫死日期的話明年跑這支就會漂掉，所以一律從代號表自己的日期往後推。
eq(catalog.staleness(at(0)).days, 0, '產生當天是 0 天');
eq(catalog.staleness(at(59)).days, 59, '59 天後是 59 天');
eq(catalog.staleness(at(59)).stale, false, '59 天還不算過期');
eq(catalog.staleness(at(60)).stale, false, '剛好 60 天也還不算（門檻是「超過」）');
eq(catalog.staleness(at(61)).stale, true, '61 天就算過期了');
eq(catalog.staleness(at(400)).stale, true, '很久以後當然也算');

// 訊息：過期才有，沒過期是 null（不是空字串 —— 呼叫端才不必自己判斷）
eq(catalog.stalenessNote(at(59)), null, '沒過期時沒有那句話');
const note61 = catalog.stalenessNote(at(61));
ok(note61 != null, `過期時講得出來：「${note61}」`);
ok(note61.includes(catDay), '訊息裡有代號表的產生日期');
ok(/61 天/.test(note61), '也講得出距今幾天');
ok(/請更新 App/.test(note61), '而且講得出下一步該做什麼');
noneOf([note61], (t) => /建議|應該|最好|風險/.test(t), '訊息裡沒有任何判斷或建議的字');

// 門檻真的是 60 —— 寫死在常數裡，改了會被這條抓到
eq(catalog.CATALOG_STALE_DAYS, 60, '門檻是 60 天');

section('代號格式判斷');
detects(catalog.looksLikeCode, {
  shouldHit: ['2330', '0050', '00632R', '6488'],
  shouldMiss: ['233', '台積電', 'abcd', '', '12345678', 'A2330'],
}, 'looksLikeCode 有對照組');

section('搜尋');
const found = catalog.search('台積');
ok(found.some((r) => r.code === '2330'), '用名稱搜得到 2330');
ok(catalog.search('0050').some((r) => r.code === '0050'), '用代號前綴搜得到 0050');
everyOf(catalog.search('23'), (r) => r.code.startsWith('23') || r.name.includes('23'), '搜尋結果都相關');
eq(catalog.search(''), [], '空字串不回東西');

done('datatest');
