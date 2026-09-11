// 配息紀錄（npm run divrecordtest）。
//
// 這支測試守的**主要不是功能，是界線**。試算器的規矩是「所有假設由使用者輸入，
// 不得有預設值、不得給建議值或歷史平均」。查詢過去配了多少是事實，很有用；
// 但只要多走一步 —— 自動填欄位、除以股價算殖利率、算個平均 ——
// 就變成我們替他決定了未來會配多少。
//
// 所以這裡最重要的四條：
//   1. 查詢結果**不會流進任何試算欄位**（執行期比對每一個欄位的值）
//   2. 畫面上**不出現百分比**（除以股價就是殖利率，殖利率就是預期報酬的語言）
//   3. **沒有「帶入」按鈕**（按鈕只是把責任偽裝成使用者的選擇）
//   4. **不算平均**，只做合計（加總是事實，平均是推論；而且每檔中位數只有 1 筆）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { listen } from './serve.mjs';
import { stripComments } from './srcscan.mjs';
import { forCode, fmtPerShare, receivedFor, staleness, __setDataForTest, STALE_DAYS } from '../js/divrecord.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dividends.json'), 'utf8'));

// ---------------------------------------------------------------------------
section('資料檔本身');
ok(real.reportDate && /^\d{7}$/.test(real.reportDate), `出表日期存在：${real.reportDate}`);
ok(Object.keys(real.codes).length > 500, `涵蓋 ${Object.keys(real.codes).length} 檔`);
eq(real.source, 't187ap45_L', '記下了來源');
const allRecs = Object.values(real.codes).flat();
everyOf(allRecs, (r) => Number.isFinite(r.cash) && Number.isFinite(r.stock),
  '每一筆的現金與配股都是數字');
noneOf(allRecs, (r) => r.cash === 0 && r.stock === 0, '沒有「兩種都是 0」的空紀錄');
everyOf(allRecs, (r) => typeof r.status === 'string' && r.status.length > 0,
  '每一筆都記了決議進度（董事會決議 vs 股東會確認，數字可能還會變）');
noneOf(allRecs, (r) => /<br/.test(r.status), '決議進度裡的 HTML 標籤清掉了');

section('歷史深度的限制要誠實面對');
// 這份資料只有兩年、每檔中位數 1 筆。**這就是不能算平均的理由。**
const counts = Object.values(real.codes).map((l) => l.length).sort((a, b) => a - b);
const median = counts[Math.floor(counts.length / 2)];
ok(median <= 3,
  `每檔筆數中位數只有 ${median} 筆（最少 ${counts[0]}、最多 ${counts[counts.length - 1]}）`
  + ' —— 拿這個算平均沒有統計意義');
const years = [...new Set(allRecs.map((r) => r.year))].sort();
ok(years.length <= 3, `只涵蓋 ${years.length} 個股利年度：${years.join('、')}`);

// ---------------------------------------------------------------------------
section('查詢：查得到與查不到是兩件事');
__setDataForTest(real);
const tsmc = forCode('2330');
ok(tsmc.found, '2330 查得到');
ok(tsmc.records.length >= 1, `有 ${tsmc.records.length} 筆`);
eq(tsmc.totalCash, Math.round(tsmc.records.reduce((a, r) => a + r.cash, 0) * 1e8) / 1e8,
  '合計就是各期加總，沒有別的加工');
eq(forCode('9999').found, false, '不存在的代號回 found:false');
eq(forCode('9999').records, [], '而且 records 是空的');
// ETF 不在這份資料裡 —— 這是真的限制，不是 bug，畫面要講
eq(forCode('0050').found, false, '0050（ETF）不在這份資料裡 —— 它涵蓋的是上市公司的股利決議');

section('每股金額的顯示');
eq(fmtPerShare(7.00000137), '7', '來源的浮點雜訊（總額÷股數）不要原樣顯示');
eq(fmtPerShare(6.00003573), '6', '同上');
eq(fmtPerShare(0.12345), '0.1235', '真的配到小數第 4 位以上的，看得見');
eq(fmtPerShare(0.125), '0.125', '不要四捨五入到 2 位 —— 那是真的改了數字');
eq(fmtPerShare(NaN), '—', '算不出來寫「—」，不是 0');

section('資料過期要講出來');
__setDataForTest({ reportDate: '1150910', codes: {} });
const fresh = staleness(new Date('2026-09-20'));
eq(fresh.stale, false, '出表日期十天前 → 不算過期');
eq(fresh.iso, '2026-09-10', '換算成西元日期給畫面用');
const old = staleness(new Date('2027-01-20'));
eq(old.stale, true, `超過 ${STALE_DAYS} 天 → 標為可能過期`);
ok(old.days > STALE_DAYS, `距今 ${old.days} 天`);
__setDataForTest({ codes: {} });
eq(staleness().known, false, '沒有出表日期時就說不知道，不要假裝是新的');
__setDataForTest(real);

section('自己實際領到的：只算已確認、有金額的');
const evs = [
  { code: '2330', status: 'confirmed', exDate: '2026-03-15', amountActual: '12000000000' },
  { code: '2330', status: 'confirmed', exDate: '2026-06-15', amountActual: '14000000000' },
  { code: '2330', status: 'confirmed', exDate: '2026-09-15', amountActual: null, amountEst: null },
  { code: '2330', status: 'pending', exDate: '2026-12-15', amountActual: '99000000000' },
  { code: '2317', status: 'confirmed', exDate: '2026-07-15', amountActual: '5000000000' },
];
const got = receivedFor(evs, '2330');
eq(got.counted, 2, '只算了兩筆（已確認且有金額）');
eq(got.unknown, 1, '沒填金額的那筆單獨記著，不當成 0');
eq(got.totalMicro, 26000000000n, '合計 12000 + 14000 元');
eq(got.rows.length, 3, '三筆已確認的都列出來（含沒金額那筆）');
noneOf(got.rows, (r) => String(r.exDate) === '2026-12-15', '待確認的完全不進來');
eq(got.rows.map((r) => r.exDate), ['2026-09-15', '2026-06-15', '2026-03-15'], '照除息日新到舊');
eq(receivedFor(evs, '0000').totalMicro, null, '完全沒有紀錄時回 null，不是 0');

// ---------------------------------------------------------------------------
section('程式碼裡不存在「把結果換算成試算假設」的路徑');
// 這是結構性的：沒有那條路，就不會有人不小心走上去。
const calcSrc = stripComments(fs.readFileSync(path.join(ROOT, 'js/views/calc.js'), 'utf8'));
const divSrc = stripComments(fs.readFileSync(path.join(ROOT, 'js/divrecord.js'), 'utf8'));
noneOf(['yieldRate =', 'state.yieldRate ='], (pat) => {
  // 允許使用者自己輸入時的賦值（field() 裡那個），不允許在查詢流程裡賦值
  const lookupPart = calcSrc.slice(calcSrc.indexOf('runLookup'));
  return lookupPart.includes(pat);
}, '查詢流程裡沒有任何一行在寫 yieldRate');
noneOf(['/ price', '/ state.price', '殖利率'], (pat) => divSrc.includes(pat) || calcSrc.slice(calcSrc.indexOf('runLookup')).includes(pat),
  '沒有任何地方拿配息去除以股價（那就是殖利率）');
noneOf(['average', 'avg', '平均'], (pat) => divSrc.includes(`${pat}Cash`) || divSrc.includes(`${pat}Dividend`),
  'divrecord 裡沒有算平均的函式');
ok(divSrc.includes('totalCash'), '（對照）它確實有算合計 —— 上面那條不是因為整個檔案是空的');

// ---------------------------------------------------------------------------
const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  section('查詢結果不會流進任何試算欄位（執行期實測）');
  const probe = await page.evaluate(async () => {
    location.hash = '#/calc';
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#view [data-card="dividendLookup"]')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const fieldValues = () => Object.fromEntries(
      [...document.querySelectorAll('#view [data-card="calcInputs"] input')]
        .map((i, n) => [i.placeholder || `field${n}`, i.value]));
    const before = fieldValues();

    const input = document.querySelector('[data-field="lookupCode"]');
    input.value = '2330';
    input.parentElement.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 1200));

    const card = document.querySelector('#view [data-card="dividendLookup"]');
    return {
      before,
      after: fieldValues(),
      cardText: card.textContent.replace(/\s+/g, ' '),
      buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
      percents: (card.textContent.match(/%/g) || []).length,
      announcedTotal: card.querySelector('[data-note="announcedTotal"]')?.textContent ?? '',
      dataDate: card.querySelector('[data-note="dividendDataDate"]')?.textContent ?? '',
    };
  });

  eq(probe.after, probe.before, '**查詢前後，每一個試算欄位的值都沒有變**');
  everyOf(Object.values(probe.after), (v) => v === '', '（對照）而且它們本來就全是空的');
  eq(probe.buttons, ['查詢'], '這張卡片上只有「查詢」一顆按鈕 —— 沒有「帶入」');
  noneOf(probe.buttons, (b) => /帶入|套用|填入|使用/.test(b), '沒有任何把數字送進試算的按鈕');
  eq(probe.percents, 0, '**畫面上一個百分比都沒有**（除以股價就是殖利率）');
  // 「預測」這兩個字本身不是問題 —— 免責句就寫著「不是未來的預測」。
  // 有問題的是把它用在配息上，所以比對的是詞組不是單字。
  noneOf(['殖利率', '預估配息', '預測配息', '預期配發', '平均每股配', '預計配發'],
    (w) => probe.cardText.includes(w),
    '沒有把配息講成預估／預測／殖利率／平均每股配');
  ok(probe.cardText.includes('不是未來的預測'),
    '（正面）而且明講「不是未來的預測」');
  ok(probe.announcedTotal.includes('合計'), `合計是加總不是平均：「${probe.announcedTotal}」`);
  ok(probe.cardText.includes('過去配息不代表未來'), '有寫「過去配息不代表未來」');
  ok(probe.dataDate.includes('出表日期'), `標出了資料日期：「${probe.dataDate}」`);

  section('ETF 與查不到的代號，講清楚是「沒有這筆資料」');
  const etf = await page.evaluate(async () => {
    const input = document.querySelector('[data-field="lookupCode"]');
    input.value = '0050';
    input.parentElement.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelector('#view [data-card="dividendLookup"]').textContent.replace(/\s+/g, ' ');
  });
  ok(etf.includes('不含 ETF') || etf.includes('ETF'), '講出 ETF 不在這份資料裡');
  ok(!/合計實際配發/.test(etf), '而且沒有生出一個「合計 0 元」—— 查不到不等於沒配過');

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('divrecordtest');
