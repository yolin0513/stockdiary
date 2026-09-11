// 持股與每日結算的畫面行為（npm run holdingtest）。真的開瀏覽器跑。
//
// 這裡守的是「畫面上不能出現的東西」：
//   · 上櫃持股那一列不能有任何報價數字（.num 節點一個都不能有）
//   · 今日收盤尚未公布時，當日損益要是「—」，不能是 0
//   · 沒填平均成本時，畫面上不能有任何「未實現」字樣或數字
//
// TWSE 的回應用假的 fetch 攔下來，內容由固定樣本組出來 —— 測試不打真網路。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { listen } from './serve.mjs';
import { makeCalendar, latestPublishedTradingDay } from '../js/market.js';
import { isoToRocCompact } from '../js/roc.js';
import { DEFAULT_TODAY_THRESHOLD } from '../js/market.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const calJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8'));
const cal = makeCalendar(calJson);

// 這一天是「現在這個時刻，收盤應該已公布的最新交易日」。
// App 會拿它跟 STOCK_DAY_ALL 回應裡的日期比對，所以假資料要用同一天。
const EXPECTED = latestPublishedTradingDay(cal, new Date(), DEFAULT_TODAY_THRESHOLD);
const OLDER = calJson.tradingDays[calJson.tradingDays.indexOf(EXPECTED) - 1];

section('測試前提');
ok(EXPECTED != null,
  `日曆算得出「應公布的最新交易日」：${EXPECTED}`,
  'data/calendar.json 可能過期了（跨年？）→ 跑 npm run build-calendar');
ok(OLDER != null, `也找得到前一個交易日：${OLDER}`);
if (!EXPECTED || !OLDER) done('holdingtest');

const CSV_HEADER = '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數';
function csvRow(date, code, name, close, change) {
  const roc = isoToRocCompact(date);
  const c = close == null ? '' : close.toFixed(2);
  const o = close == null ? '' : close.toFixed(2);
  return `"${roc}","${code}","${name}","1000","1000","${o}","${o}","${o}","${c}","${change == null ? '0.0000' : change.toFixed(4)}","10"`;
}
function dayAllCsv(date, rows) {
  return [CSV_HEADER, ...rows.map((r) => csvRow(date, ...r))].join('\n') + '\n';
}

// 2330 收 2450、漲跌 −15 → 倒推基準 2465
// 1000 股 × (2450 − 2465) = −15,000
const CSV_TODAY = dayAllCsv(EXPECTED, [
  ['2330', '台積電', 2450, -15],
  ['2317', '鴻海', 251, 0.5],
  ['0050', '元大台灣50', 109.15, -0.5],
]);
const CSV_OLDER = dayAllCsv(OLDER, [
  ['2330', '台積電', 2465, 10],
  ['2317', '鴻海', 250.5, 1],
  ['0050', '元大台灣50', 109.65, 0.2],
]);

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  // 假的 fetch：只攔 twse.com.tw，其他（./data/*.json、模組）照樣走真的。
  await page.evaluateOnNewDocument(() => {
    const real = window.fetch.bind(window);
    window.__twseCalls = [];
    window.__mock = null;
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (!url.includes('twse.com.tw')) return real(input, init);
      window.__twseCalls.push(url);
      const m = window.__mock;
      if (!m) return new Response('', { status: 503 });
      if (url.includes('STOCK_DAY_ALL')) {
        if (m.fail) return new Response('', { status: 503 });
        return new Response(m.dayAllCsv, { status: 200, headers: { 'content-type': 'text/csv' } });
      }
      if (url.includes('STOCK_DAY')) {
        const code = new URL(url).searchParams.get('stockNo');
        const body = (m.stockDay && m.stockDay[code])
          || JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', total: 0 });
        return new Response(body, { status: 200 });
      }
      return new Response('', { status: 404 });
    };
  });

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card', { timeout: 60000 });

  /** 清空所有 store，回到全新狀態。 */
  const reset = async () => {
    await page.evaluate(async () => {
      const db = await import('./js/db.js');
      for (const s of db.STORE_NAMES) await db.clear(s);
    });
  };

  /** 設定假資料、建立持股、跑一次更新、回到首頁。 */
  const setup = async ({ mock, holdings: hs }) => {
    await reset();
    await page.evaluate((m) => { window.__mock = m; window.__twseCalls = []; }, mock);
    await page.evaluate(async (list) => {
      const hd = await import('./js/holdings.js');
      for (const x of list) await hd.addOpening(x);
    }, hs);
    await page.evaluate(async () => {
      const store = await import('./js/store.js');
      try {
        const r = await store.update({ force: true });
        // 結果裡有 BigInt，不能整包送回 Node（結構化複製會失敗）
        window.__upd = { status: r.status, message: r.message, settled: r.settled ?? [], problems: r.problems ?? [] };
      } catch (e) {
        window.__upd = { status: 'threw', message: String(e && e.stack || e), settled: [], problems: [] };
      }
    });
    await page.evaluate(() => { location.hash = '#/'; });
    await page.evaluate(async () => (await import('./js/views/home.js')).default());
    await page.waitForSelector('#view .big-number', { timeout: 60000 });
  };

  const viewText = () => page.$eval('#view', (el) => el.textContent.replace(/\s+/g, ' '));
  const bigNumber = () => page.$eval('#view .big-number', (el) => el.textContent.trim());

  // ---------------------------------------------------------------
  section('情境 1：上市 + 上櫃，收盤已公布');
  await setup({
    mock: { dayAllCsv: CSV_TODAY },
    holdings: [
      { code: '2330', shares: 1000, date: '2026-01-05' },
      { code: '6488', shares: 500, date: '2026-01-05' },
    ],
  });

  const upd1 = await page.evaluate(() => window.__upd);
  eq(upd1.status, 'settled', `更新狀態是 settled（訊息：${upd1.message}）`);
  eq(upd1.settled, [EXPECTED], `結算了 ${EXPECTED}`);

  // 手算：1000 股 × (2450 − 2465) = −15,000
  eq(await bigNumber(), '-15,000', '當日損益 −15,000 元（1000 股 × (2450 − 2465)）');

  const text1 = await viewText();
  ok(text1.includes('不含 1 檔不支援報價的持股'),
    `總和旁邊標了「不含 1 檔不支援報價的持股」`, text1.slice(0, 300));

  section('上櫃那一列不能有任何報價數字');
  const otcRow = await page.evaluate(() => {
    const el = document.querySelector('#view .row[data-code="6488"]');
    if (!el) return null;
    return {
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      numNodes: el.querySelectorAll('.num').length,
      classes: el.className,
    };
  });
  ok(otcRow != null, '6488 那一列在畫面上');
  eq(otcRow.numNodes, 0, '那一列連一個 .num（報價數字）節點都沒有');
  ok(otcRow.text.includes('不支援報價'), `而且明講「不支援報價」：「${otcRow.text}」`);
  // 對照組：上市那一列本來就該有 .num，不然上面那條「等於 0」證明不了什麼
  const listedNums = await page.$$eval('#view .row[data-code="2330"] .num', (els) => els.length);
  ok(listedNums > 0, `（對照）上市的 2330 那一列有 ${listedNums} 個 .num 節點`);

  const allUnsupportedNums = await page.evaluate(() =>
    [...document.querySelectorAll('#view .row-unsupported')].map((el) => el.querySelectorAll('.num').length));
  noneOf(allUnsupportedNums, (n) => n > 0, '所有標示不支援的列都沒有報價數字');

  section('沒填平均成本 → 畫面上不能有任何未實現數字');
  const costCards = await page.evaluate(() => ({
    unrealized: !!document.querySelector('#view [data-card="unrealized"]'),
    prompt: !!document.querySelector('#view [data-card="costPrompt"]'),
    promptNums: document.querySelectorAll('#view [data-card="costPrompt"] .num').length,
    titles: [...document.querySelectorAll('#view .card-title')].map((e) => e.textContent),
  }));
  eq(costCards.unrealized, false, '沒有「未實現損益」這張卡片');
  noneOf(costCards.titles, (t) => t.includes('未實現'), '也沒有任何一張卡片的標題是未實現');
  eq(costCards.promptNums, 0, '取而代之的說明卡片裡一個數字都沒有');
  ok(costCards.prompt, '（對照）有一張卡片告訴使用者「填了平均成本之後會顯示什麼」');
  noneOf([text1], (t) => /報酬率s*[+-—d]/.test(t), '畫面上沒有「報酬率」後面接著一個值');

  // ---------------------------------------------------------------
  section('情境 2：今日收盤尚未公布（端點回的是前一天）');
  await setup({
    mock: { dayAllCsv: CSV_OLDER },
    holdings: [{ code: '2330', shares: 1000, date: '2026-01-05' }],
  });
  const upd2 = await page.evaluate(() => window.__upd);
  eq(upd2.status, 'todayPending', `更新狀態是 todayPending（訊息：${upd2.message}）`);
  eq(upd2.settled, [], '什麼都沒有結算 —— 不拿前一天的資料冒充今天');

  const big2 = await bigNumber();
  eq(big2, '—', '當日損益顯示「—」');
  ok(big2 !== '0' && big2 !== '+0' && big2 !== '0.00', `而且不是 0（實際「${big2}」）`);
  const text2 = await viewText();
  ok(text2.includes('尚未結算過') || text2.includes('今日收盤尚未公布'),
    '畫面講清楚狀況', text2.slice(0, 300));
  noneOf([big2], (t) => /\d/.test(t), '當日損益那一格裡一個數字都沒有');

  // ---------------------------------------------------------------
  section('情境 3：連不上證交所');
  await setup({
    mock: { fail: true },
    holdings: [{ code: '2330', shares: 1000, date: '2026-01-05' }],
  });
  const upd3 = await page.evaluate(() => window.__upd);
  eq(upd3.status, 'failed', `更新狀態是 failed（訊息：${upd3.message}）`);
  eq(await bigNumber(), '—', '當日損益還是「—」，不是 0');
  ok((await viewText()).includes('HTTP 503') || upd3.message.includes('503'),
    `畫面或狀態帶得出原因：「${upd3.message}」`);

  // ---------------------------------------------------------------
  section('情境 4：填了平均成本才出現未實現損益');
  await setup({
    mock: { dayAllCsv: CSV_TODAY },
    holdings: [
      { code: '2330', shares: 1000, avgCost: 1000, date: '2026-01-05' },
      { code: '2317', shares: 2000, date: '2026-01-05' },
    ],
  });
  const text4 = await viewText();
  ok(await page.$('#view [data-card="unrealized"]') != null, '（對照）填了平均成本之後，「未實現損益」那張卡片就出現了');
  ok(text4.includes('未實現損益'), '出現「未實現損益」');
  // 手算：1000 股 × (2450 − 1000) = +1,450,000；報酬率 145.00%
  ok(text4.includes('+1,450,000'), `未實現 +1,450,000 元`, text4.slice(0, 400));
  ok(text4.includes('+145.00%'), '報酬率 +145.00%');
  ok(text4.includes('僅含 1 檔有填平均成本的持股'), '標明只含 1 檔');
  // 當日損益：2330 −15,000 ＋ 2317 2000 股 × (251 − 250.5) = +1,000 → −14,000
  eq(await bigNumber(), '-14,000', '當日損益 −14,000 元（兩檔合計）');

  // ---------------------------------------------------------------
  section('情境 5：新增上櫃代號時要先問過');
  await reset();
  await page.evaluate((m) => { window.__mock = m; }, { dayAllCsv: CSV_TODAY });
  await page.evaluate(() => { location.hash = '#/holdings'; });
  await page.waitForSelector('#view .btn-primary', { timeout: 60000 });
  await page.click('#view .btn-primary');
  await page.waitForSelector('.modal-card .field', { timeout: 60000 });
  await page.type('.modal-card .field', '6488');
  await page.waitForFunction(() => document.querySelector('.preview')?.textContent.includes('上櫃'), { timeout: 60000 });
  const previewText = await page.$eval('.preview', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  ok(previewText.includes('不會顯示價格'), `輸入當下就明講：「${previewText}」`);
  noneOf([previewText], (t) => /\d+\.\d+/.test(t), '提示裡沒有任何小數（價格長那樣）');
  await page.evaluate(() => {
    [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '取消')?.click();
  });

  section('請求次數');
  const calls = await page.evaluate(() => window.__twseCalls.length);
  ok(calls <= 2, `這一輪只打了 ${calls} 次證交所（只缺一天時應該只要 1 次）`);

  section('沒有頁面錯誤');
  eq(pageErrors.filter((t) => !/favicon|503|Failed to load resource/i.test(t)), [], '沒有未預期的錯誤');
} finally {
  await browser.close();
  srv.close();
}

everyOf([1], () => true, '測試跑完了');
done('holdingtest');
