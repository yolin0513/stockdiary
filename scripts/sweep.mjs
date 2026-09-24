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
import { ok, eq, section, done, everyOf, noneOf, note } from './tap.mjs';
import { controls, parseLive, versionProblems, cacheProblems, splitErrors } from './sweepjudge.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = process.argv[2] || 'https://yolin0513.github.io/stockdiary/';
const WORKER = 'https://stockdiary-news.yolin0513.workers.dev';

const LOCAL_VERSION = /APP_VERSION = '([^']+)'/.exec(
  fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];

// 逐頁清單跟 upgradecheck 共用（scripts/routes.mjs）；註冊了卻沒登記的路由，下面「路由孤兒」那條會報。
const { ROUTES, routeOrphans } = await import('./routes.mjs');

const bust = () => `?cb=${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先跑對照組（SPEC_檢查器修補 S4）：用錄好的合成回應，不打網路。判斷邏輯壞了，下面的「全過」就不可信——
// 以前版本比對改成永遠成立，20 項照樣全過（線上版本剛好一致時看不出來）。
process.stdout.write('對照組（判斷邏輯自己有沒有壞，合成樣本、不打網路）：\n');
const ctrl = controls();
for (const c of ctrl) process.stdout.write(`  ${c.ok ? '✓' : '✗'} （對照）${c.name}（${c.detail}）\n`);
if (ctrl.some((c) => !c.ok)) {
  process.stdout.write('對照組沒過：sweep 的判斷邏輯壞了，線上巡檢的結果不可信——停下，不巡檢。\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
section(`線上版本（${SITE}）`);
const swText = await (await fetch(`${SITE}sw.js${bust()}`)).text();
const htmlText = await (await fetch(`${SITE}${bust()}`)).text();
const live = parseLive(swText, htmlText);
const vp = versionProblems({ ...live, local: LOCAL_VERSION });   // 跟對照組同一段程式（sweepjudge.mjs）
const vpAt = (w) => vp.filter((p) => p.where === w);

eq(vpAt('sw.js'), [], `線上 sw.js 的版本跟工作目錄一致（${live.sw}）`);
eq(vpAt('index.html'), [], `線上 index.html 載入的 app.js 也是同一版`);
eq(vpAt('格式'), [], '版本號格式正確');

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
  // 反方向（2026-09-24）：線上註冊了、巡檢清單卻沒有的路由（以前多註冊一條 /zzq，20 項照樣全過）
  eq(routeOrphans(running.patterns).missing, [], 'sweep 路由孤兒：線上註冊的每一條路由都在巡檢清單裡、或寫了不巡的理由');

  section('Service Worker');
  const sw = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) await new Promise((r) => setTimeout(r, 100));
    return { controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() };
  });
  ok(sw.controlled, 'Service Worker 接手了這個頁面');
  const cp = cacheProblems(sw.caches, LOCAL_VERSION);   // 跟對照組同一段程式
  ok(cp.hasCurrent, `快取名稱帶著這一版（${sw.caches.join('、')}）`);
  noneOf(sw.caches, (c) => cp.stale.includes(c), '沒有留下別版的快取');

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
  //
  // 新聞上游（經 Worker 的那四家）偶爾會限速回 502，換頁時還在飛的請求也會被
  // 中止成 ERR_ABORTED。那兩種都不是部署壞掉 —— 畫面上本來就會顯示「這次沒抓到」。
  //
  // 但**不可以靜默丟掉**：分開數、分開報，讓人看得出「忽略了幾筆、是哪一家」。
  // 兩邊的判準要一致（以前主控台排除了 502、失敗請求卻沒有，結果同一件事一邊過一邊紅）。
  // 分類在 sweepjudge.mjs 的 splitErrors（跟對照組同一段程式）。
  const { realErrors, newsErrors, realFailed, newsFailed } = splitErrors(errors, failed);
  eq(realErrors, [], '沒有未攔截的例外，也沒有主控台錯誤');
  eq(realFailed, [], '沒有失敗的請求（新聞上游另外算，見下）');

  // 這一條不是斷言「一定沒事」，是把忽略掉的東西攤開來講。
  note(newsFailed.length + newsErrors.length === 0
    ? '新聞上游這次全部正常'
    : `新聞上游有 ${newsFailed.length + newsErrors.length} 筆失敗（限速或換頁中止），`
      + '畫面上會顯示「這次沒抓到」，不算部署問題：'
      + [...newsFailed, ...newsErrors].slice(0, 3).join(' ／ '));

} finally {
  await browser.close();
}

done('sweep');
