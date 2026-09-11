// 線上巡檢（npm run sweep）。**打的是正式環境**，每次部署完跑一次。
//
// 這支跟 npm test 的分工：
//   npm test  在本機驗「程式對不對」
//   sweep     在線上驗「部署對不對」—— 版本一致、每一頁真的開得起來、
//             Service Worker 接得了手、離線開得起來、Worker 活著
//
// 它會打真網路（GitHub Pages、Cloudflare Worker、四家 RSS 上游），
// 所以**不進 `npm test`**（慣例 10）。上游來源一次只碰一下，不連打。

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, everyOf, noneOf } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = process.argv[2] || 'https://yolin0513.github.io/stockdiary/';
const WORKER = 'https://stockdiary-news.yolin0513.workers.dev';

const LOCAL_VERSION = /APP_VERSION = '([^']+)'/.exec(
  fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];

const ROUTES = [
  ['/', 'StockDiary 股息日記'],
  ['/holdings', '持股'],
  ['/plans', '定期定額'],
  ['/dividends', '股利'],
  ['/news', '新聞'],
  ['/calc', '定期定額試算'],
  ['/settings', '設定'],
];

const bust = () => `?cb=${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section(`線上版本（${SITE}）`);
const swText = await (await fetch(`${SITE}sw.js${bust()}`)).text();
const liveSw = /const VERSION = '([^']+)';/.exec(swText)?.[1];
const htmlText = await (await fetch(`${SITE}${bust()}`)).text();
const liveHtml = /app\.js\?v=([^"]+)"/.exec(htmlText)?.[1];

eq(liveSw, LOCAL_VERSION, `線上 sw.js 的版本跟工作目錄一致（${liveSw}）`);
eq(liveHtml, LOCAL_VERSION, `線上 index.html 載入的 app.js 也是同一版`);
ok(/^stockdiary-v\d+\.\d+\.\d+$/.test(String(liveSw)), '版本號格式正確');

// ---------------------------------------------------------------------------
section('新聞 Worker');
const health = await fetch(`${WORKER}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
eq(health.ok, true, 'Worker 活著');
ok(Array.isArray(health.sources) && health.sources.length === 4, `四個來源都在（${health.sources?.length}）`);
const blocked = await fetch(`${WORKER}/rss?src=notawhitelistedsource`);
eq(blocked.status, 400, '非白名單來源仍然回 400');

// ---------------------------------------------------------------------------
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  await page.setViewport({ width: 390, height: 844 });
  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
  page.on('requestfailed', (r) => failed.push(`${r.url().slice(-60)} ${r.failure()?.errorText}`));

  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card', { timeout: 90000 });

  section('每一頁都開得起來');
  const landed = [];
  for (const [route, title] of ROUTES) {
    await page.evaluate((r) => { location.hash = `#${r}`; }, route);
    let okLanded = true;
    try {
      await page.waitForFunction((t) => document.getElementById('topTitle').textContent === t,
        { timeout: 60000 }, title);
    } catch { okLanded = false; }
    // 新聞頁會先畫一張「正在抓取六個來源…」再換成真的內容 ——
    // 標題換到了不代表畫完了，要等那張暫時的卡片消失。
    if (route === '/news') {
      await page.waitForFunction(
        () => !document.querySelector('#view [data-card="newsLoading"]'),
        { timeout: 90000 },
      ).catch(() => {});
    }
    const text = await page.$eval('#view', (el) => el.textContent.trim().length);
    landed.push({ route, title, okLanded, text });
  }
  everyOf(landed, (x) => x.okLanded, '每一頁的標題都換到正確的那一個');
  everyOf(landed, (x) => x.text > 20, '每一頁都畫得出內容');

  section('執行中的版本');
  const running = await page.evaluate(async () => {
    const v = await import('./js/version.js');
    const r = await import('./js/router.js');
    return { version: v.APP_VERSION, patterns: r.routePatterns() };
  });
  eq(running.version, LOCAL_VERSION, '瀏覽器裡真的在跑的就是這一版');
  // 要守的是「app.js 沒有被載入兩次」（v0.5.2 發生過，路由會變成兩倍）。
  // 硬寫條數會在新增路由時誤報，所以檢查的是**有沒有重複**。
  eq(running.patterns.length, new Set(running.patterns).size,
    `路由沒有重複註冊（${running.patterns.length} 條：${running.patterns.join('、')}）`);
  ok(running.patterns.length >= ROUTES.length,
    `而且至少涵蓋巡檢清單裡的 ${ROUTES.length} 頁`);
  everyOf(ROUTES.map(([r]) => r), (r) => running.patterns.includes(r),
    '巡檢清單裡的每一條路由線上都真的註冊了');

  section('Service Worker');
  const sw = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) await new Promise((r) => setTimeout(r, 100));
    return { controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() };
  });
  ok(sw.controlled, 'Service Worker 接手了這個頁面');
  ok(sw.caches.some((c) => c.includes(LOCAL_VERSION)), `快取名稱帶著這一版（${sw.caches.join('、')}）`);
  noneOf(sw.caches, (c) => !c.includes(LOCAL_VERSION), '沒有留下別版的快取');

  section('離線也開得起來');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const offline = await page.evaluate(async () => {
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#view .card')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { cards: document.querySelectorAll('#view .card').length, tabs: document.querySelectorAll('#tabbar .tab').length };
  });
  ok(offline.cards > 0, `離線重載之後畫面還在（${offline.cards} 張卡片）`);
  ok(offline.tabs >= 3, `底部分頁也在（${offline.tabs} 個）`);
  // 離線時動態載入的 view 也要進得去
  await page.evaluate(() => { location.hash = '#/calc'; });
  const offlineRoute = await page.evaluate(async () => {
    for (let i = 0; i < 100; i += 1) {
      if (document.getElementById('topTitle')?.textContent === '定期定額試算') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('topTitle')?.textContent;
  });
  eq(offlineRoute, '定期定額試算', '離線時動態載入的畫面也打得開');
  await page.setOfflineMode(false);

  section('主控台與網路');
  // 新聞來源偶爾會限速（見 STATUS「新聞來源的已知狀況」），那不算部署壞掉。
  const realErrors = errors.filter((e) => !/502|favicon/.test(e));
  eq(realErrors, [], '沒有未攔截的例外，也沒有主控台錯誤');
  const realFailed = failed.filter((f) => !/favicon/.test(f));
  eq(realFailed, [], '沒有失敗的請求');
  if (errors.length !== realErrors.length) {
    console.log(`      （忽略了 ${errors.length - realErrors.length} 筆新聞上游限速造成的 502，畫面上會顯示「這次沒抓到」）`);
  }
} finally {
  await browser.close();
}

done('sweep');
