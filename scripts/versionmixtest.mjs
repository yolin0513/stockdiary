// 版本混搭的重現與回歸測試（npm run versionmixtest）。
//
// 使用者回報：點「管理定期定額計畫」直接跳回主頁。
//
// 這支用一個「可以逐檔指定版本」的伺服器，真的把舊版的 js/app.js 配上新版的
// js/views/holdings.js，證明這組合就會產生那個症狀 —— 而不是用推論的。
//
// 為什麼這種混搭在真實環境出得來：
//   GitHub Pages 對每一個檔案送 Cache-Control: max-age=600（實測過），而且沒有
//   revalidate。瀏覽器的 HTTP 快取是**逐檔**計時的，所以在 Service Worker 還沒
//   接手的那段時間（第一次載入、SW 被系統回收、剛換版），一個十分鐘前快取的
//   app.js 完全可能跟一個剛抓的 views/holdings.js 湊在一起。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 沒有 /plans 路由、也沒有那顆按鈕的最後一版（v0.3.0）
const OLD_REV = execFileSync('git', ['rev-list', '-1', '--grep=驗證除權息參考價的推導公式', 'HEAD'],
  { cwd: ROOT, encoding: 'utf8' }).trim();

function fromRev(rev, rel) {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * 伺服器：預設服務工作目錄（新版），但 `oldFiles` 裡列到的路徑改服務舊版。
 * 這就是「混搭」。
 */
function makeServer(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    let body = null;
    if (state.oldFiles.has(rel)) {
      body = fromRev(OLD_REV, rel);
      state.served.push(`${rel} ← 舊版`);
    } else {
      const full = path.resolve(ROOT, rel);
      if (full.startsWith(ROOT) && fs.existsSync(full)) body = fs.readFileSync(full);
      state.served.push(`${rel} ← 新版`);
    }
    if (!body) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
}

section('前提：舊版確實沒有那條路由，新版有');
ok(OLD_REV.length >= 7, `舊版 commit ${OLD_REV.slice(0, 7)}`);
const oldApp = fromRev(OLD_REV, 'js/app.js')?.toString('utf8') ?? '';
const oldHoldings = fromRev(OLD_REV, 'js/views/holdings.js')?.toString('utf8') ?? '';
const newApp = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const newHoldings = fs.readFileSync(path.join(ROOT, 'js/views/holdings.js'), 'utf8');
ok(!oldApp.includes("route('/plans'"), '舊版 app.js 沒有 /plans 路由');
ok(newApp.includes("route('/plans'"), '新版 app.js 有 /plans 路由');
ok(!oldHoldings.includes('管理定期定額計畫'), '舊版持股頁沒有那顆按鈕');
ok(newHoldings.includes('管理定期定額計畫'), '新版持股頁有那顆按鈕');

const state = { oldFiles: new Set(), served: [] };
const srv = makeServer(state);
await new Promise((r) => srv.listen(0, r));
const PORT = srv.address().port;
const BASE = `http://localhost:${PORT}/`;

// 「離線」要真的沒有網路。page.setOfflineMode() **管不到 Service Worker 自己發的
// fetch** —— SW 照樣連得到測試伺服器，於是離線那一節其實從來沒有離線過
// （實測：把 SW 的 ignoreSearch 拿掉，離線斷言依然全綠）。所以要把伺服器關掉。
let srvClosed = false;
function closeServer() {
  if (srvClosed) return;
  srvClosed = true;
  srv.close();
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

/** 開一個乾淨的頁面（每次新 context，SW 與快取都不共用）。 */
async function freshPage() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  const logs = [];
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`console: ${m.text()}`); });
  return { ctx, page, logs };
}

/** 走到持股頁、按下「管理定期定額計畫」，回報按完之後在哪。 */
async function clickManagePlans(page) {
  await page.goto(`${BASE}#/holdings`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card');
  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#view a, #view button')]
      .find((x) => x.textContent.includes('管理定期定額計畫'));
    if (!el) return null;
    el.click();
    return { href: el.getAttribute('href') };
  });
  if (!found) return { clicked: false };
  await new Promise((r) => setTimeout(r, 1500));
  return {
    clicked: true,
    ...(await page.evaluate(() => ({
      hash: location.hash,
      title: document.getElementById('topTitle')?.textContent ?? '',
      text: document.querySelector('#view')?.textContent.replace(/\s+/g, ' ').slice(0, 300) ?? '',
      // 用專屬的 data 標記判斷，不要用文字比對 ——
      // 資料狀態列裡本來就有「每次開啟 App 更新一次」，拿「更新」去比對會誤判成「有解釋」。
      mismatchCard: !!document.querySelector('#view [data-card="versionMismatch"]'),
      updateButton: [...document.querySelectorAll('#view button')].some((b) => b.textContent.includes('更新到最新版')),
    }))),
  };
}

try {
  // =================================================================
  section('對照組：整組都是新版 —— 應該正常');
  state.oldFiles = new Set();
  {
    const { ctx, page } = await freshPage();
    const r = await clickManagePlans(page);
    ok(r.clicked, '按鈕在');
    eq(r.hash, '#/plans', '進到定期定額頁');
    eq(r.title, '定期定額', '標題正確');
    await ctx.close();
  }

  // =================================================================
  section('重現：舊版 app.js ＋ 新版 views/holdings.js');
  // 這就是使用者遇到的組合：畫面上有按鈕（新版 view），但路由表裡沒有那條路（舊版 app.js）。
  state.oldFiles = new Set(['js/app.js']);
  {
    const { ctx, page, logs } = await freshPage();
    const r = await clickManagePlans(page);
    ok(r.clicked, '按鈕還是在（因為 view 是新版）');
    ok(r.hash !== '#/plans',
      `**重現了**：按下去跑到 ${r.hash}（標題「${r.title}」）`);
    ok(/StockDiary|股息日記/.test(r.title), '確實是回到了主頁（舊版的 notFound 就是這樣做的）');
    // 用**專屬標記**判斷有沒有解釋，不要用「版本」「更新」這種字去比對 ——
    // 資料狀態列裡本來就有「每次開啟 App 更新一次」，會誤判成「有解釋」。
    eq(r.mismatchCard, false, '**畫面上沒有任何說明區塊**，使用者只看到「按了就跳回首頁」');
    eq(logs.filter((l) => /pageerror/.test(l)), [], '主控台也沒有錯誤 —— 完全靜默');
    await ctx.close();
  }

  // =================================================================
  section('檢查其他路由有沒有同樣風險');
  // 把每一條「新版有、舊版沒有」的路由都列出來，它們在混搭時全都會踢回首頁。
  const routeOf = (src) => [...src.matchAll(/route\('([^']+)'/g)].map((m) => m[1]);
  const oldRoutes = routeOf(oldApp);
  const newRoutes = routeOf(newApp);
  const onlyNew = newRoutes.filter((r) => !oldRoutes.includes(r));
  ok(onlyNew.length > 0, `新版多出來的路由：${onlyNew.join('、')}`);

  state.oldFiles = new Set(['js/app.js']);
  for (const pattern of onlyNew) {
    const { ctx, page } = await freshPage();
    await page.goto(`${BASE}#${pattern}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));
    const where = await page.evaluate(() => location.hash);
    ok(where !== `#${pattern}`, `${pattern} 在混搭時也會被踢走（跑到 ${where}）—— 不是只有 /plans`);
    await ctx.close();
  }

  // =================================================================
  section('修好之後：不認得的路由講清楚原因，不靜默跳回首頁');
  // 這是回歸斷言。舊版的 app.js 沒有修，所以這裡用**新版**的 app.js，
  // 走一條它也不認得的路 —— 那正是使用者在混搭狀態下會遇到的情況。
  state.oldFiles = new Set();
  {
    const { ctx, page } = await freshPage();
    await page.goto(`${BASE}#/plans`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#view .card');
    // 模擬「這一版還沒有這條路」：走一條確定不存在的路徑
    await page.evaluate(() => { location.hash = '#/這一版還沒有的頁'; });
    await page.waitForSelector('#view [data-card="versionMismatch"]', { timeout: 30000 });
    const r = await page.evaluate(() => ({
      hash: location.hash,
      text: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
      updateButton: [...document.querySelectorAll('#view button')].some((b) => b.textContent.includes('更新到最新版')),
      homeLink: [...document.querySelectorAll('#view a')].some((a) => a.getAttribute('href') === '#/'),
      tabs: document.querySelectorAll('#tabbar .tab').length,
    }));
    ok(r.updateButton, '有「更新到最新版」的按鈕');
    ok(r.homeLink, '也留了一條回總覽的路');
    ok(r.text.includes('這一版還沒有的頁'), '把打不開的那條路徑寫出來');
    ok(r.tabs >= 3, `底部分頁還在（${r.tabs} 個），沒有把使用者困住`);
    ok(!/^#\/$/.test(r.hash), `網址留在原地（${decodeURIComponent(r.hash)}），更新後重載就接得上`);
    await ctx.close();
  }

  section('Service Worker 換版是整組的，不會半路混檔');
  // STATUS 的慣例說 SHELL 是 cache-first、整組換版。這一段是實證，不是讀程式碼：
  // 先讓舊版的 SW 完整裝好並接手，再把伺服器換成新版，重載之後看拿到哪一版。
  state.oldFiles = new Set(['js/app.js', 'js/views/holdings.js', 'sw.js', 'index.html']);
  {
    const { ctx, page } = await freshPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#view .card');
    // 等 SW 真的接手
    const controlled = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return { scope: reg.scope, controlled: !!navigator.serviceWorker.controller };
    });
    ok(controlled.controlled, 'SW 已經接手這個頁面');

    const before = await page.evaluate(async () => {
      const r = await import('./js/router.js');
      return r.routePatterns();
    });
    ok(!before.includes('/plans'), `舊版 SW 之下看到的路由沒有 /plans：${before.join('、')}`);

    // 伺服器整個換成新版（模擬部署），重載一次 —— 舊版的 SW 還在管這個頁面
    state.oldFiles = new Set();
    await page.reload({ waitUntil: 'networkidle0' });
    // App 在「剛開啟、還沒動過任何東西」時會自動換版並重載一次（app.js 的 canAutoUpdate）。
    // 那正是它該做的事，但會把測試的執行環境砍掉 —— 先等它做完再操作。
    await new Promise((r) => setTimeout(r, 4000));
    await page.waitForSelector('#view .card');

    // 關鍵不變式，也是使用者真正感受得到的那一條：
    // **畫面上有那顆按鈕，按下去就一定要進得去。**
    // 不去比對「檔案是哪一版」—— 那沒有意義，因為 App 是帶著版本參數去載模組的，
    // 跟測試自己 fetch 一個不帶參數的網址拿到的東西本來就不是同一個東西。
    const r = await clickManagePlans(page);
    if (r.clicked) {
      eq(r.hash, '#/plans', '畫面上有按鈕，按下去就進得去 —— 沒有混搭');
      eq(r.mismatchCard, false, '不需要出現「需要更新」的說明');
    } else {
      // 沒有按鈕也是一致的狀態（整組都是舊版），同樣沒有混搭
      const routes = await page.evaluate(async () => (await import('./js/router.js')).routePatterns());
      ok(!routes.includes('/plans'), '沒有按鈕的話，路由表裡也不該有 /plans —— 兩者一致');
    }
    await ctx.close();
  }
  section('離線也要開得起來（版本參數不能把 SW 快取繞過去）');
  // 網址上的 ?v=<版本> 是給瀏覽器 HTTP 快取用的鍵。SW 的快取如果照字面比對，
  // 帶參數的請求就永遠命中不了預快取的檔案 —— 線上看不出來（會走網路），
  // **離線就整個打不開**。sw.js 用 ignoreSearch: true 就是為了這件事。
  state.oldFiles = new Set();
  {
    const { ctx, page } = await freshPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    // 再載一次，確保這個頁面從一開始就由 SW 管
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#view .card');
    ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'SW 正在管這個頁面');

    // 拔網路：瀏覽器端與伺服器端都要拔（理由見上面 closeServer 的註解）
    await page.setOfflineMode(true);
    closeServer();
    await new Promise((r) => setTimeout(r, 300));

    // 對照組：先證明「網路真的斷了」。少了這一條，底下所有離線斷言都可能是
    // 「其實還連得到伺服器」才綠的 —— 那就是假斷言。
    // 用一個不存在、也不在任何快取裡的網址：SW 會走到最後那條網路分支。
    const netDead = await page.evaluate(async (base) => {
      try { await fetch(`${base}no-such-file-${Date.now()}`); return false; } catch { return true; }
    }, BASE);
    ok(netDead, '（對照）網路真的斷了 —— 底下的離線斷言才算數');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const offline = await page.evaluate(async () => {
      for (let i = 0; i < 100; i += 1) {
        if (document.querySelector('#view .card')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        cards: document.querySelectorAll('#view .card').length,
        tabs: document.querySelectorAll('#tabbar .tab').length,
        text: document.querySelector('#view')?.textContent.replace(/\s+/g, ' ').slice(0, 120) ?? '',
      };
    });
    ok(offline.cards > 0, `離線重載之後畫面還在（${offline.cards} 張卡片）：「${offline.text}」`);
    ok(offline.tabs >= 3, `底部分頁也在（${offline.tabs} 個）`);

    // 離線時每一條路由也要進得去（view 是動態 import，一樣帶版本參數）
    await page.evaluate(() => { location.hash = '#/plans'; });
    const offlineRoute = await page.evaluate(async () => {
      for (let i = 0; i < 100; i += 1) {
        if (document.getElementById('topTitle')?.textContent === '定期定額') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        title: document.getElementById('topTitle')?.textContent,
        mismatch: !!document.querySelector('#view [data-card="versionMismatch"]'),
      };
    });
    eq(offlineRoute.title, '定期定額', '離線時動態載入的 view 也載得進來（帶版本參數也命中快取）');
    eq(offlineRoute.mismatch, false, '沒有誤判成版本不一致');

    await page.setOfflineMode(false);
    await ctx.close();
  }
} finally {
  await browser.close();
  closeServer();
}

done('versionmixtest');
