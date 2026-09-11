// 非同步畫面競態（npm run racetest）。
//
// 使用者回報的症狀是「點『管理定期定額計畫』會直接跳回主頁」。除了版本混搭
// （見 versionmixtest.mjs）之外，還有一個完全不需要版本混搭就會發生的原因：
//
//   **畫面是 async 的，但沒有人檢查「畫到一半使用者已經走掉了」。**
//
// 每個 view 都長這樣：`await import(...)` → `await 讀資料` → `render(...)`。
// 中間兩個 await 加起來在手機上輕易就是幾百毫秒到幾秒。這段時間裡使用者
// 只要換了頁，舊的 view 醒來之後還是會把自己畫上去 —— 而且**是最後畫的那個贏**，
// 網址停在新的那一頁，畫面卻是舊的那一頁。看起來就是「按了沒反應／跳回別頁」。
//
// 最會咬人的一條是 app.js 開機時的自動更新：
//   store.update().then(() => { if (here === '/') import('./views/home.js').then(m => m.default()); })
// `here` 只在 update 回來的那一瞬間檢查一次，之後 import + default() 那整段時間
// 完全沒有再確認。使用者在這段時間裡點任何一顆按鈕，都會被首頁蓋掉 ——
// 症狀跟使用者回報的一字不差。
//
// 這支測試用「可以指定某個檔案慢幾毫秒回應」的伺服器，把那段空窗撐開到穩定可測。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
};

/**
 * 靜態檔伺服器，另外接受「哪個請求要慢幾毫秒」的規則。
 * seen 記下每個請求的網址，測試才能等到「那個請求真的發出來了」再動作。
 */
function delayServer(delayFor) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(ROOT, '.' + rel);
    const send = () => {
      if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
        res.writeHead(200, {
          'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(buf);
      });
    };
    const ms = delayFor(req.url) || 0;
    if (ms > 0) setTimeout(send, ms); else send();
  });
  return new Promise((resolve) => {
    srv.listen(0, () => resolve({ srv, port: srv.address().port, seen }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 目前畫面是哪一頁？用每一頁獨一無二的標記判斷。
 * 這段字串會注入到瀏覽器裡變成 window.__which()。
 */
const WHICH_SRC = `window.__which = function () {
  const v = document.getElementById('view');
  if (!v) return 'none';
  if (v.querySelector('[data-card="calcInputs"]')) return 'calc';
  if (v.querySelector('[data-card="dividendSettings"]')) return 'settings';
  if (v.querySelector('[data-card="plansList"]')) return 'plans';
  // 總覽有兩種樣子：有資料時有大數字，全新裝置時只有「開始使用」那張卡片。
  // 只認 .big-number 的話，沒有持股的情況下總覽會被判成 'empty'，
  // 下面每一條「畫面是 home」就永遠不成立，而否定斷言會永遠過 —— 假斷言。
  if (v.querySelector('.big-number') || v.querySelector('[data-card="start"]')) return 'home';
  return v.textContent.trim().slice(0, 40) || 'empty';
};`;

async function openPage(browser, port, { goto = true } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(WHICH_SRC);
  if (goto) {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view .card', { timeout: 60000 });
  }
  return page;
}

const snapshot = (page) => page.evaluate(() => ({
  hash: location.hash,
  which: window.__which(),
  title: document.getElementById('topTitle').textContent,
}));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  // -------------------------------------------------------------------------
  section('前提：四頁各自認得出來');
  // 少了這一條，標記一改名，下面所有「畫面是 X」就會一起變成永遠不成立，
  // 而「畫面不是首頁」那種否定斷言會永遠過 —— 假斷言。
  {
    const { srv, port } = await delayServer(() => 0);
    const page = await openPage(browser, port);
    const got = {};
    for (const [hash, name] of [['#/', 'home'], ['#/settings', 'settings'], ['#/calc', 'calc'], ['#/plans', 'plans']]) {
      await page.evaluate((x) => { location.hash = x; }, hash);
      await sleep(700);
      got[name] = await page.evaluate(() => window.__which());
    }
    eq(got, { home: 'home', settings: 'settings', calc: 'calc', plans: 'plans' },
      '四頁各自畫出自己的標記 —— 下面的斷言才分得出誰蓋掉誰');
    await page.close();
    srv.close();
  }

  // -------------------------------------------------------------------------
  section('慢的舊畫面不准蓋掉使用者現在這一頁');
  {
    // settings.js 慢 1.5 秒：使用者點了設定、還沒畫出來就改點別的。
    const { srv, port } = await delayServer((u) => (u.startsWith('/js/views/settings.js') ? 1500 : 0));
    const page = await openPage(browser, port);

    await page.evaluate(() => { location.hash = '#/settings'; });
    await sleep(200);
    await page.evaluate(() => { location.hash = '#/calc'; });
    await sleep(3000); // 遠超過那 1.5 秒，慢的那個一定已經回來了

    const after = await snapshot(page);
    eq(after.hash, '#/calc', '網址停在使用者最後選的那一頁');
    ok(after.which === 'calc', '畫面也是那一頁 —— 慢吞吞的設定頁醒來之後不准畫上去',
      `實際畫面是「${after.which}」`);
    ok(!after.title.includes('設定'), '連頂列標題都不該被舊畫面改掉',
      `實際標題是「${after.title}」`);
    await page.close();
    srv.close();
  }

  // -------------------------------------------------------------------------
  section('開機自動更新回來時，不准把使用者點開的畫面蓋掉');
  {
    // 壞掉的寫法是 `import('./views/home.js')` —— **沒帶版本參數**，
    // 跟路由用的 './js/views/home.js?v=...' 是兩個不同的網址，會真的再連一次網路。
    // 只延遲沒帶參數的那一個，就能把那段空窗撐到 2.5 秒，開機本身完全不受影響。
    //
    // 修好之後這個網址根本不會被請求（重畫走 router.refresh()，用的是同一份已載入的
    // 模組），所以這一節平常是綠的。它會不會紅由突變測試證明：把 app.js 改回
    // 「自己 import 首頁來畫」，這一節就會紅。
    const { srv, port } = await delayServer((u) => (u === '/js/views/home.js' ? 2500 : 0));
    const page = await openPage(browser, port);

    // 開機更新（store.update）回來、開始重畫首頁 —— 空窗從這裡開始。
    await sleep(800);

    // 使用者就在這時候點「管理定期定額計畫」。
    await page.evaluate(() => { location.hash = '#/plans'; });
    await sleep(4500); // 撐過那 2.5 秒，被延遲的首頁一定已經回來了

    const after = await snapshot(page);
    eq(after.hash, '#/plans', '網址是定期定額');
    ok(after.which === 'plans',
      '畫面也是定期定額 —— 這就是使用者回報的「點了就跳回主頁」',
      `實際畫面是「${after.which}」`);
    await page.close();
    srv.close();
  }

  // -------------------------------------------------------------------------
  section('等待新畫面的期間，不准先閃出使用者沒選的那一頁');
  {
    // 上面那兩節看的是「塵埃落定之後停在哪一頁」。但只看結果的話，
    // 一個「先畫錯的、再畫對的」的實作也會過 —— 使用者眼前還是會閃出別頁。
    // 這一節故意讓兩頁都慢，而且慢得不一樣，在中間那段時間直接看畫面：
    //   0.0s 使用者在首頁，點「設定」
    //   0.2s 還沒畫出來，改點「試算」
    //   1.5s 設定頁載完了 —— 這一刻不准畫上去（使用者要的是試算）
    //   3.5s 試算頁載完，畫出來
    // 取樣點放在 2.2s：設定頁早就回來了，試算頁還沒到。
    const { srv, port } = await delayServer((u) => {
      if (u.startsWith('/js/views/settings.js')) return 1500;
      if (u.startsWith('/js/views/calc.js')) return 3500;
      return 0;
    });
    const page = await openPage(browser, port);

    await page.evaluate(() => { location.hash = '#/settings'; });
    await sleep(200);
    await page.evaluate(() => { location.hash = '#/calc'; });
    await sleep(2000); // 取樣點：距離設定頁回來已經 0.7 秒，距離試算頁還有 1.3 秒

    const mid = await snapshot(page);
    ok(mid.which !== 'settings',
      '空窗期間畫面沒有變成設定頁 —— 使用者沒有選它',
      `實際畫面是「${mid.which}」`);
    ok(!mid.title.includes('設定'),
      '頂列標題也沒有變成設定頁',
      `實際標題是「${mid.title}」`);

    // 對照組：不是「乾脆整個空白」，等下去要等得到使用者真正選的那一頁。
    await page.waitForSelector('#view [data-card="calcInputs"]', { timeout: 60000 });
    const end = await snapshot(page);
    eq(end.which, 'calc', '再等一下，使用者選的試算頁就出來了');
    await page.close();
    srv.close();
  }

  // -------------------------------------------------------------------------
  section('慢的畫面回來要求轉頁時，不准把使用者從他選的那頁拉走');
  {
    // holding.js 查不到代號時會 navigate('/holdings')，但那個判斷在 await 之後。
    // 使用者在那段時間點去別頁的話，location.replace 會硬把人扯回持股頁 ——
    // 跟使用者回報的「按了就跳到別頁」是同一件事。
    const { srv, port } = await delayServer((u) => (u.startsWith('/js/views/holding.js') ? 1500 : 0));
    const page = await openPage(browser, port);

    await page.evaluate(() => { location.hash = '#/holdings/沒有這一檔'; });
    await sleep(200);
    await page.evaluate(() => { location.hash = '#/plans'; });
    await sleep(3000); // 撐過那 1.5 秒，慢的那一頁一定已經回來並做完它的判斷

    const after = await snapshot(page);
    eq(after.hash, '#/plans', '網址還在使用者選的那一頁 —— 沒有被 location.replace 扯走');
    ok(after.which === 'plans', '畫面也是那一頁', `實際畫面是「${after.which}」`);
    await page.close();
    srv.close();
  }

  // -------------------------------------------------------------------------
  section('查不到的代號，該退回持股頁的時候還是要退');
  {
    // 對照組：上面那條不是「乾脆不轉頁」。使用者停在那一頁不動時，
    // 查不到代號還是要把他帶回持股頁，不能卡在空白畫面。
    const { srv, port } = await delayServer(() => 0);
    const page = await openPage(browser, port);
    await page.evaluate(() => { location.hash = '#/holdings/沒有這一檔'; });
    await sleep(1500);
    const after = await snapshot(page);
    eq(after.hash, '#/holdings', '退回持股頁了');
    eq(after.title, '持股', '標題也對得上');
    await page.close();
    srv.close();
  }

  // -------------------------------------------------------------------------
  section('慢歸慢，最後一定要停在對的那一頁');
  {
    // 上面兩條都是「不准畫錯的」。這一條是對照組：確認修法不是
    // 「乾脆什麼都不畫」—— 慢的那一頁自己被選中時，還是要畫出來。
    const { srv, port } = await delayServer((u) => (u.startsWith('/js/views/settings.js') ? 1200 : 0));
    const page = await openPage(browser, port);
    await page.evaluate(() => { location.hash = '#/calc'; });
    await sleep(300);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('#view [data-card="dividendSettings"]', { timeout: 60000 });
    const after = await snapshot(page);
    eq(after.which, 'settings', '慢的畫面最後還是畫出來了');
    eq(after.hash, '#/settings', '網址也對得上');
    await page.close();
    srv.close();
  }
} finally {
  await browser.close();
}

done('racetest');
