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
import { makeCalendar, isTradingDay } from '../js/market.js';

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
eq(calJson.year, 2026, '年份');
ok(calJson.tradingDays.length > 200, `交易日 ${calJson.tradingDays.length} 天`);
everyOf(calJson.tradingDays, (d) => /^2026-\d{2}-\d{2}$/.test(d), '每一天都是 2026 年的 ISO 日期');
eq([...new Set(calJson.tradingDays)].length, calJson.tradingDays.length, '沒有重複的日期');
eq([...calJson.tradingDays].sort().join(), calJson.tradingDays.join(), '日期是排序好的');

// 2026 年 2 月最難：農曆春節 + 和平紀念日補假。這一串是拿 2330 的 STOCK_DAY
// 實際回應核對過的（npm run livecheck 會再對一次真網路）。
eq(calJson.tradingDays.filter((d) => d.startsWith('2026-02')),
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
