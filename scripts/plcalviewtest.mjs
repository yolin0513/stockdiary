// 每日損益日曆的畫面（npm run plcalviewtest）：從真實入口走——首頁「當日損益」右上角的日曆圖示。
//
// 在手機寬度（390）開 App，預先放入上個月的幾筆合成結算紀錄（不是誰的真實資料），點圖示進日曆、切到上個月，
// 逐格核對：有資料的天數＝放進去的紀錄數（母體）、「算不出」與「無資料」顯示不同、沒資料的格子不是 0、
// 賺賠的顏色、今天有標出來、點一天看得到明細、沒有橫向捲動。
// **對外連線一律擋掉**（證交所、新聞 Worker）：開首頁會觸發自動更新，這支測試不打真網路。
//
// 情境用「頁面上的今天」往回推一個月、從 data/calendar.json 挑那個月的交易日，不寫死日期；
// 前提斷言確認那個月有日曆、交易日夠多——不成立就紅（例如跨年後日曆還沒更新）。

import puppeteer from 'puppeteer';
import { ok, eq, section, done, note } from './tap.mjs';
import { listen } from './serve.mjs';

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.setRequestInterception(true);
  const blocked = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') req.continue();
    else { blocked.push(u.hostname); req.abort(); }
  });
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  section('預先放入上個月的結算紀錄');
  const seed = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    const { makeCalendar } = await import('./js/market.js');
    const { localISODate } = await import('./js/roc.js');
    const { shiftMonth } = await import('./js/plcal.js');
    const { fmtDate } = await import('./js/ui.js');
    for (const s of db.EXPORTABLE_STORES) await db.clear(s);
    await db.clear('settle');
    const cal = makeCalendar(await (await fetch('./data/calendar.json')).json());
    const today = localISODate();
    const prev = shiftMonth(today.slice(0, 7), -1);
    const td = cal.days.filter((d) => d.startsWith(prev));
    if (td.length < 5) return { ok: false, prev, tradingDays: td.length };
    await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 1000, date: `${prev}-01` });
    const Y = (yuan) => String(BigInt(Math.round(yuan * 1e6)));
    const rows = [
      { date: td[0], dayPL: Y(12345), counted: 1 },
      { date: td[1], dayPL: Y(-850), counted: 1 },
      { date: td[2], dayPL: null, counted: 0, excludedMissing: 1, byCode: [{ code: '0050', status: 'exNoRef' }] },
      // td[3]：交易日、沒有紀錄 → 無資料
      { date: td.at(-1), dayPL: Y(1), counted: 1 },
    ];
    for (const r of rows) await db.put('settle', r);
    return { ok: true, prev, today, rows: rows.map((r) => r.date), gap: td[3], firstText: fmtDate(td[0]) };
  });
  ok(seed.ok, `（前提）上個月（${seed.prev}）有開休市日、而且至少 5 個交易日`, JSON.stringify(seed));

  section('從首頁的日曆圖示進去');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-action="openPlCalendar"]');
  await page.click('[data-action="openPlCalendar"]');
  // 等不到要變成一條明寫的斷言，不是逾時崩掉（突變判定才分得出紅在哪裡）
  const opened = await page.waitForFunction(() => document.getElementById('topTitle').textContent === '每日損益', { timeout: 20000 })
    .then(() => true, () => false);
  ok(opened, '日曆畫面入口：點首頁當日損益的日曆圖示，進到「每日損益」');
  if (!opened) throw new Error('沒有進到日曆畫面，後面的斷言無從驗起');
  const cur = await page.evaluate(() => ({
    today: document.querySelector('.plcal-cell[aria-current="date"]')?.dataset.date ?? null,
    todayClass: document.querySelector('.plcal-cell[aria-current="date"]')?.classList.contains('plcal-today') ?? false,
    nextDisabled: document.querySelector('.plcal-nav[aria-label="下個月"]')?.getAttribute('aria-disabled') === 'true',
  }));
  eq(cur.today, seed.today, '日曆畫面：今天那一格有標出來（aria-current＝date）');
  ok(cur.todayClass, '日曆畫面：今天那一格有 plcal-today 的樣式');
  ok(cur.nextDisabled, '日曆畫面：本月是最新一頁，「下個月」不能按');

  section('切到上個月，逐格核對');
  await page.click('.plcal-nav[aria-label="上個月"]');
  await page.waitForFunction((p) => document.querySelector('[data-field="plcalMonth"]')?.textContent === `${p.slice(0, 4)} 年 ${Number(p.slice(5))} 月`, {}, seed.prev);
  const got = await page.evaluate(() => [...document.querySelectorAll('.plcal-cell')].map((c) => ({
    date: c.dataset.date,
    state: c.dataset.state,
    text: c.querySelector('.plcal-v')?.textContent ?? '',
    cls: c.querySelector('.plcal-v')?.className ?? '',
  })));
  const cell = (d) => got.find((c) => c.date === d) ?? {};
  const withData = got.filter((c) => c.state === 'value' || c.state === 'uncomputable');
  eq(withData.map((c) => c.date).sort(), [...seed.rows].sort(), '日曆畫面母體：畫出「有資料」的日子剛好是放進去的那幾天（不多不少）');
  eq(got.length, new Date(Date.UTC(Number(seed.prev.slice(0, 4)), Number(seed.prev.slice(5)), 0)).getUTCDate(),
    '日曆畫面母體：這個月的每一天都畫出來了');
  eq(cell(seed.rows[2]).state, 'uncomputable', '日曆畫面：有結算但算不出的那天 → 算不出');
  eq(cell(seed.gap).state, 'noData', '日曆畫面：沒有紀錄的交易日 → 無資料');
  eq([cell(seed.rows[2]).text, cell(seed.gap).text], ['算不出', '無資料'], '日曆畫面：「算不出」與「無資料」顯示不同的字');
  const blank = got.filter((c) => ['noData', 'uncomputable', 'pending', 'closed', 'uncovered'].includes(c.state));
  ok(blank.length > 0 && blank.every((c) => c.text && c.text !== '0'), '日曆畫面：沒有數字的格子都顯示狀態字，不是 0、不是空白',
    JSON.stringify(blank.filter((c) => !c.text || c.text === '0')));
  ok(cell(seed.rows[0]).cls.includes('v-up') && cell(seed.rows[0]).text === '+1.2萬', '日曆畫面顏色：賺的那天是紅（v-up），寫 +1.2萬', JSON.stringify(cell(seed.rows[0])));
  ok(cell(seed.rows[1]).cls.includes('v-down') && cell(seed.rows[1]).text === '-850', '日曆畫面顏色：賠的那天是綠（v-down），寫 -850', JSON.stringify(cell(seed.rows[1])));

  section('點一天看明細、起點說明、手機版面');
  await page.click(`.plcal-cell[data-date="${seed.rows[2]}"]`);
  const detail = await page.evaluate(() => document.querySelector('[data-field="plcalDetail"]')?.textContent ?? '');
  ok(detail.includes('算不出') && detail.includes('0050'), '日曆畫面：點「算不出」那天，明細講得出是哪一檔、為什麼', detail);
  const startNote = await page.evaluate(() => document.querySelector('[data-note="plcalStart"]')?.textContent ?? '');
  ok(startNote.includes(seed.firstText) && startNote.includes('開始記錄'), `日曆畫面：寫出歷史的起點（${seed.firstText}）`, startNote);
  ok(await page.evaluate(() => !document.querySelector('[data-note="plcalCoverage"]')), '日曆畫面：母體檢查沒有報警');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `日曆畫面：手機寬度 390 沒有橫向捲動（多出 ${overflow}px）`);
  note(`擋掉 ${blocked.length} 個對外請求（${[...new Set(blocked)].join('、') || '沒有'}）`);
  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('plcalviewtest');
