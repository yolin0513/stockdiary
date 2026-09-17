// 換版實測（npm run upgradecheck）。
//
// 回答一個很具體的問題：**已經裝著舊版的使用者，要做什麼才吃得到新版？**
//
// 不能用猜的，也不能只讀 app.js 的換版邏輯 —— 要把使用者的處境重建出來：
//
//   · 伺服器回應帶 `cache-control: max-age=600`，跟 GitHub Pages 一模一樣
//     （這是關鍵變因：瀏覽器對每個檔案各自計時十分鐘，而且期間不會回頭問）
//   · 先讓瀏覽器裝上**舊版**（上一個 commit）並確認 SW 真的接手了
//   · 把伺服器換成**新版**（工作目錄）
//   · 然後模擬「把 App 關掉再開一次」：關掉分頁，在同一個瀏覽器情境開新分頁
//     （SW 註冊、Cache Storage、HTTP 快取全部留著 —— 就是使用者手機上的狀態）
//
// 量的是：開第幾次會跑到新版、中間有沒有自動重載、需不需要使用者做額外動作。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, note } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// 預設拿**上一個 commit**當舊版。以前這裡寫死一個 commit id（8968518，v0.5.0），
// 於是每發一版，這支測的都還是「從 v0.5.0 升上來」—— 真正要驗的那一跳從來沒測到。
// 跟突變寫死版本號是同一種過期。要測特定版本就用 npm run upgradecheck -- <rev>。
const OLD_REV = process.argv[2] || 'HEAD~1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
};

function fromRev(rev, rel) {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`], {
      cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return null; }
}

/**
 * 模仿 GitHub Pages 的靜態伺服器。
 * state.serveOld 為真時整站都吐舊版，否則吐工作目錄的新版。
 */
function makeServer(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    let body = null;
    if (state.serveOld) {
      // 舊版沒有的檔案就是 404 —— 不可以掉回去拿新版的。
      // （js/version.js 是 v0.5.1 才有的；掉回去拿新版會讓「舊版」其實混著新檔案，
      //   整個實測就失去意義。第一次寫就是栽在這裡。）
      body = fromRev(OLD_REV, rel);
    } else {
      const full = path.resolve(ROOT, rel);
      if (full.startsWith(ROOT) && fs.existsSync(full)) body = fs.readFileSync(full);
    }
    if (!body) { res.writeHead(404); res.end('not found'); return; }

    res.writeHead(200, {
      'content-type': TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream',
      // GitHub Pages 就是這樣：十分鐘內不回頭問，而且每個檔案各自計時。
      'cache-control': 'max-age=600',
    });
    res.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { serveOld: true };
const srv = makeServer(state);
await new Promise((r) => srv.listen(0, r));
const BASE = `http://localhost:${srv.address().port}/`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
// 一個情境從頭用到尾：SW 註冊、Cache Storage、HTTP 快取都留著，就像使用者的手機。
let ctx = await browser.createBrowserContext();

/**
 * 開一個分頁、等畫面出來，回報現在跑的是哪一版。
 * touchFirst：模擬「一開 App 就馬上點東西」—— app.js 的 canAutoUpdate 會因此
 * 拒絕自動重載（那是對的，不然會在使用者手上把畫面抽掉），改成跳出更新提示列。
 */
async function openApp({ settleMs = 6000, touchFirst = false } = {}) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  let reloads = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloads += 1; });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  if (touchFirst) {
    await page.evaluate(() => window.dispatchEvent(new Event('pointerdown')));
  }
  await page.waitForSelector('#view .card', { timeout: 60000 }).catch(() => {});
  await sleep(settleMs); // 讓自動換版（app.js 的 canAutoUpdate）有時間做完
  const info = await page.evaluate(async () => {
    // 版本要問**實際裝上去的那個 SW**，不能問伺服器現在吐什麼。
    // Cache Storage 的名字裡就帶著當初裝進去的那個 VERSION。
    const names = await caches.keys();
    const reg = await navigator.serviceWorker?.getRegistration();
    return {
      caches: names,
      running: names.map((n) => (/stockdiary-v[\d.]+/.exec(n) || [])[0]).filter(Boolean)[0] ?? null,
      controlled: !!navigator.serviceWorker?.controller,
      hasWaiting: !!reg?.waiting,
      updateBar: !!document.getElementById('updateBar'),
      cards: document.querySelectorAll('#view .card').length,
    };
  });
  return { page, info, reloads };
}

/** 走到定期定額頁，回報實際到了哪裡 —— 使用者回報的那個操作。 */
async function tapManagePlans(page) {
  await page.goto(`${BASE}#/holdings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card', { timeout: 60000 });
  await sleep(1200);
  const btn = await page.evaluateHandle(() =>
    [...document.querySelectorAll('#view button, #view a')].find((b) => b.textContent.includes('管理定期定額計畫')) || null);
  const el = btn.asElement();
  if (!el) return { clicked: false };
  await el.click();
  await sleep(2500);
  return {
    clicked: true,
    hash: await page.evaluate(() => location.hash),
    title: await page.evaluate(() => document.getElementById('topTitle').textContent),
  };
}

const NEW_VERSION = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];

try {
  // -------------------------------------------------------------------------
  section('前提：先把使用者的處境重建出來（裝著舊版、SW 已接手）');
  const oldSw = fromRev(OLD_REV, 'sw.js')?.toString('utf8') ?? '';
  const oldVersion = /const VERSION = '([^']+)';/.exec(oldSw)?.[1];
  ok(oldVersion && oldVersion !== NEW_VERSION,
    `舊版 ${oldVersion}、新版 ${NEW_VERSION}，確實不同版`);

  const first = await openApp();
  eq(first.info.running, oldVersion, `第一次開：跑的是舊版 ${oldVersion}`);
  ok(first.info.controlled, '舊版的 Service Worker 已經接手這個頁面');
  ok(first.info.cards > 0, `畫面正常（${first.info.cards} 張卡片）`);
  await first.page.close();

  // -------------------------------------------------------------------------
  section('伺服器換成新版（＝我剛剛 push 上去）');
  state.serveOld = false;
  note(`伺服器現在吐 ${NEW_VERSION}，瀏覽器手上還留著舊版的 SW 與十分鐘內的檔案`);

  // -------------------------------------------------------------------------
  section('使用者把 App 關掉再開一次 —— 第 1 次');
  const second = await openApp();
  const gotNewOnFirstReopen = second.info.running === NEW_VERSION;
  note(`跑的是 ${second.info.running}；期間自動重載 ${Math.max(0, second.reloads - 1)} 次；` +
    `有沒有跳出「有新版本」提示：${second.info.updateBar ? '有' : '沒有'}`);

  if (gotNewOnFirstReopen) {
    eq(second.info.running, NEW_VERSION, '**開一次就換到新版了**（App 自己換版並重載，使用者不必做任何事）');
    const tapped = await tapManagePlans(second.page);
    ok(tapped.clicked, '持股頁上找得到「管理定期定額計畫」');
    eq(tapped.hash, '#/plans', '按下去進得到定期定額頁 —— 沒有跳回主頁');
    eq(tapped.title, '定期定額', '標題也對');
    await second.page.close();
  } else {
    await second.page.close();
    section('第 1 次沒換到，再開第 2 次');
    const third = await openApp();
    eq(third.info.running, NEW_VERSION, '第 2 次開就換到新版了');
    const tapped = await tapManagePlans(third.page);
    ok(tapped.clicked, '持股頁上找得到「管理定期定額計畫」');
    eq(tapped.hash, '#/plans', '按下去進得到定期定額頁 —— 沒有跳回主頁');
    await third.page.close();
  }

  // -------------------------------------------------------------------------
  section('另一種常見情況：一開 App 就馬上動手（自動換版會讓路）');
  // app.js 只在「剛打開、還沒動過任何東西」時才自動重載 —— 這是刻意的，
  // 不然會在使用者正在操作時把畫面抽掉。那這種人要怎麼吃到新版？實測。
  {
    await ctx.close();
    ctx = await browser.createBrowserContext();
    state.serveOld = true;
    const a = await openApp();
    eq(a.info.running, oldVersion, `重新佈置：又是一台裝著舊版 ${oldVersion} 的機器`);
    await a.page.close();

    state.serveOld = false;
    const b = await openApp({ touchFirst: true });
    ok(b.info.updateBar || b.info.running === NEW_VERSION,
      b.info.updateBar
        ? '畫面下方跳出「有新版本 / 點一下更新」的提示列'
        : `沒跳提示列，但已經換到 ${b.info.running}`,
      `實際：版本 ${b.info.running}、提示列 ${b.info.updateBar ? '有' : '沒有'}`);

    if (b.info.updateBar) {
      await b.page.evaluate(() => document.querySelector('#updateBar .update-go').click());
      await sleep(8000);
      const after = await b.page.evaluate(async () => {
        const names = await caches.keys();
        return (names.map((n) => (/stockdiary-v[\d.]+/.exec(n) || [])[0]).filter(Boolean)[0]) ?? null;
      });
      eq(after, NEW_VERSION, '點下「點一下更新」之後就換到新版了');

      // **更新之後畫面不能是空的。** 使用者回報（v0.7.18）：按下更新只剩標題列、
      // 下面整片空白，只能把 App 滑掉重開。以前這裡只驗「快取名稱換了」——
      // SW 換好了、畫面卻沒畫出來，這條斷言看不見。
      await b.page.waitForSelector('#view .card', { timeout: 15000 }).catch(() => {});
      const screen = await b.page.evaluate(async () => {
        const running = (await import('./js/version.js')).APP_VERSION;
        const tabs = document.querySelectorAll('#tabbar .tab').length;
        const cards = document.querySelectorAll('#view .card').length;
        const text = document.querySelector('#view').textContent.replace(/\s+/g, ' ');
        const spinner = !!document.querySelector('#view .wait-box');
        // 可互動：點一個分頁要換得了頁
        document.querySelector('#tabbar .tab[href="#/settings"]')?.click();
        await new Promise((r) => setTimeout(r, 800));
        return { running, tabs, cards, text, spinner, titleAfterTap: document.getElementById('topTitle').textContent };
      });
      eq(screen.running, NEW_VERSION, '重載之後真的在跑新版');
      ok(screen.tabs >= 4, `底部分頁在（${screen.tabs} 格）—— 不是只剩標題列`);
      ok(screen.cards >= 1, `畫面畫出來了（${screen.cards} 張卡），不是一片空白`);
      ok(!screen.spinner, '也不是卡在「載入中…」的轉圈圈');
      eq(screen.titleAfterTap, '設定', '而且點得動：點底部「設定」真的換頁');
    }
    await b.page.close();
  }

  // -------------------------------------------------------------------------
  section('對照組：確認上面不是「本來就已經是新版」才綠的');
  // 少了這一條，萬一伺服器從頭到尾都吐新版，上面每一條也會全過。
  ok(oldVersion !== NEW_VERSION && first.info.running === oldVersion,
    `第一次開的確實是舊版（${first.info.running}），所以「換到新版」是真的換過去的`);
} finally {
  await browser.close();
  srv.close();
}

done('upgradecheck');
