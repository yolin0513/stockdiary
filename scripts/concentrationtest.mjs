// 產業集中度（npm run concentrationtest）。
//
// 兩件事：
//   1. 百分比算得對，而且**加起來是 100.0**（浮點數在這裡會讓它變成 99.9 或 100.1）
//   2. 算不出市值的持股**不計入分母**，而且要講出來 ——
//      把它們當成 0 會讓百分比看起來很精準，其實是錯的

import { ok, eq, near, section, done, noneOf, everyOf } from './tap.mjs';
import { byIndustry, pctOf, exclusionNote } from '../js/concentration.js';
import { toMicro } from '../js/money.js';

const H = (code, industry, shares, supported = true) => ({ code, name: code, industry, shares, supported });

// ---------------------------------------------------------------------------
section('基本彙總');
const holdings = [
  H('2330', '半導體業', 1000),
  H('2454', '半導體業', 500),
  H('2317', '其他電子業', 2000),
  H('2882', '金融保險業', 3000),
];
const quotes = {
  2330: { close: 1000 },   // 1,000,000
  2454: { close: 1200 },   //   600,000
  2317: { close: 200 },    //   400,000
  2882: { close: 80 },     //   240,000
};
const r = byIndustry(holdings, quotes);
eq(r.counted, 4, '四檔都算得出市值');
eq(r.excluded, [], '沒有被排除的');
eq(r.totalMicro, toMicro(2240000), '總市值 2,240,000 元');
eq(r.rows.map((x) => x.industry), ['半導體業', '其他電子業', '金融保險業'], '由大到小排');
eq(r.rows[0].codes.sort(), ['2330', '2454'], '同產業的代號併在一起');
near(r.rows[0].pct, 71.4, 0.05, '半導體業 1,600,000 / 2,240,000 ＝ 71.4%');
near(r.rows[1].pct, 17.8, 0.05, '其他電子業 400,000 / 2,240,000 ＝ 17.8%');
near(r.rows[2].pct, 10.7, 0.05, '金融保險業 240,000 / 2,240,000 ＝ 10.7%');

section('百分比加起來要是 100');
// 用整數算就是為了這件事。三等分是最容易露餡的случай。
const thirds = byIndustry(
  [H('A', 'X', 1), H('B', 'Y', 1), H('C', 'Z', 1)],
  { A: { close: 1 }, B: { close: 1 }, C: { close: 1 } },
);
const sum = thirds.rows.reduce((a, b) => a + b.pct, 0);
near(sum, 100, 0.3, `三等分加起來 ${sum}%（整數運算，不會漂掉）`);
everyOf(thirds.rows, (x) => x.pct === 33.3, '每一份都是 33.3%');

const many = byIndustry(
  Array.from({ length: 7 }, (_, i) => H(`C${i}`, `產業${i}`, 1)),
  Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`C${i}`, { close: 1 }])),
);
const sum7 = many.rows.reduce((a, b) => a + b.pct, 0);
near(sum7, 100, 0.8, `七等分加起來 ${sum7}%`);

// ---------------------------------------------------------------------------
section('算不出市值的不計入分母，而且要講出來');
const mixed = byIndustry(
  [
    H('2330', '半導體業', 1000),
    H('6488', '半導體業', 500, false),    // 上櫃，不支援報價
    H('9999', '其他', 100),               // 沒有收盤價
    H('0050', 'ETF', 0),                  // 沒有股數
  ],
  { 2330: { close: 1000 }, 6488: { close: 700 } },
);
eq(mixed.counted, 1, '只有一檔算得出市值');
eq(mixed.totalMicro, toMicro(1000000), '分母只有那一檔');
eq(mixed.rows.length, 1, '只有一個產業出現');
eq(mixed.rows[0].pct, 100, '它就是 100%');
eq(mixed.excluded.map((e) => e.code).sort(), ['0050', '6488', '9999'], '三檔被排除');
eq(mixed.excluded.find((e) => e.code === '6488').why, '不支援報價', '不支援報價的原因寫對');
eq(mixed.excluded.find((e) => e.code === '9999').why, '沒有收盤價', '沒有收盤價的原因寫對');
eq(mixed.excluded.find((e) => e.code === '0050').why, '沒有股數', '沒有股數的原因寫對');
// 上櫃那檔即使「有報價」也不可以混進來
ok(!mixed.rows[0].codes.includes('6488'),
  '**不支援報價的持股就算 quotes 裡有價，也不計入** —— 那個價不可信');

const note = exclusionNote(mixed);
ok(note.includes('6488') && note.includes('9999') && note.includes('0050'), '排除說明列出每一檔');
ok(note.includes('不支援報價'), '也講出原因');
ok(note.includes('1 檔') || note.includes('的 1'), `而且說清楚分母只有幾檔：「${note}」`);
eq(exclusionNote({ excluded: [], counted: 3 }), null, '沒有被排除的就不顯示說明');

// ---------------------------------------------------------------------------
section('邊界');
eq(byIndustry([], {}).rows, [], '沒有持股就沒有列');
eq(byIndustry([], {}).totalMicro, 0n, '總額 0');
eq(exclusionNote(byIndustry([], {})), null, '也沒有說明要顯示');
const noIndustry = byIndustry([H('1234', null, 100)], { 1234: { close: 10 } });
eq(noIndustry.rows[0].industry, '產業未知', '沒有產業的歸到「產業未知」，不是丟掉');
eq(pctOf(1n, 0n), null, '分母 0 時回 null，不是 NaN 也不是 0');
eq(pctOf(0n, 100n), 0, '分子 0 是 0%');

// ---------------------------------------------------------------------------
section('不做任何評價');
// 這一節守的是「不得出現投資建議」。集中度只陳述事實，不說「過度集中」「建議分散」。
const src = (await import('node:fs')).readFileSync(
  new URL('../js/concentration.js', import.meta.url), 'utf8');
const view = (await import('node:fs')).readFileSync(
  new URL('../js/views/holdings.js', import.meta.url), 'utf8');
const { stripComments } = await import('./srcscan.mjs');
const words = ['過度集中', '風險偏高', '建議分散', '太集中', '不宜', '應該分散', '偏高風險'];
noneOf(words, (w) => stripComments(src).includes(w) || stripComments(view).includes(w),
  '程式碼裡沒有任何帶評價意味的字');
ok(words.length >= 5, `（母體）檢查了 ${words.length} 個帶評價意味的詞`);

section('ETF 沒有產業別，但那不是「資料缺了」');
// 這位使用者的定期定額三檔全是 ETF。整批落在「產業未知」那一格的話，
// 看起來像 App 沒抓到資料 —— 其實 ETF 本來就沒有單一產業別。
{
  const held = [
    { code: '2330', shares: 1000, supported: true, industry: '半導體業', type: '股票' },
    { code: '0050', shares: 1000, supported: true, industry: null, type: 'ETF' },
    { code: '00878', shares: 1000, supported: true, industry: null, type: 'ETF' },
    { code: '9999', shares: 1000, supported: true, industry: null, type: null },
  ];
  const quotes = { 2330: { close: 100 }, '0050': { close: 100 }, '00878': { close: 100 }, 9999: { close: 100 } };
  const r = byIndustry(held, quotes);
  const keys = r.rows.map((x) => x.industry);
  ok(keys.includes('ETF'), `ETF 自成一格：${keys.join('、')}`);
  const etf = r.rows.find((x) => x.industry === 'ETF');
  eq(etf.codes.sort(), ['0050', '00878'], '而且就是那兩檔 ETF');
  // 對照：真的查不到產業的（不是 ETF）仍然叫「產業未知」
  ok(keys.includes('產業未知'), '（對照）查不到產業又不是 ETF 的，還是叫產業未知');
  eq(r.rows.find((x) => x.industry === '產業未知').codes, ['9999'], '而且只有那一檔');
  noneOf(r.rows.filter((x) => x.industry === '產業未知'), (x) => x.codes.some((c) => c.startsWith('00')),
    'ETF 一檔都沒有掉進「產業未知」');
}

done('concentrationtest');
