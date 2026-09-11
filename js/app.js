// 進入點：路由表、Service Worker 換版流程。
//
// **這個檔案只能由 index.html 載入，不准被任何模組 import。**
// index.html 載入的網址帶版本參數（`./js/app.js?v=<版本>`）；只要有人用
// `'./app.js'`（沒帶參數）import 它，瀏覽器就會把它當成另一個網址再求值一次 ——
// boot() 跑兩次、路由註冊兩次、TWSE 被打兩輪。view 要用的東西在 js/shell.js。
// shelltest 有靜態稽核擋這件事。

import { route, setNotFound, startRouter, navigate, currentRoute, setSlowIndicator, refresh } from './router.js';
import * as store from './store.js';
import * as prefs from './prefs.js';
import { h } from './ui.js';
import { setTop, render, renderLoading, renderTabs, currentPath, viewIsEmpty } from './shell.js';
import { APP_VERSION, V } from './version.js';

// ---------- 路由 ----------
route('/', async () => (await import(`./views/home.js${V}`)).default());
route('/holdings', async () => (await import(`./views/holdings.js${V}`)).default());
route('/holdings/:code', async ({ params }) => (await import(`./views/holding.js${V}`)).default(params.code));
route('/plans', async () => (await import(`./views/plans.js${V}`)).default());
route('/dividends', async () => (await import(`./views/dividends.js${V}`)).default());
route('/calc', async () => (await import(`./views/calc.js${V}`)).default());
route('/settings', async () => (await import(`./views/settings.js${V}`)).default());
/**
 * 走到一條不認得的路。
 *
 * **絕對不要靜默導回首頁。** 使用者回報過這個症狀：按「管理定期定額計畫」直接跳回主頁，
 * 沒有任何訊息，完全不知道發生什麼事。
 *
 * 根因幾乎一定是**版本混搭**：畫面是新版的（所以有那顆按鈕），但正在跑的 app.js 是舊版的
 * （所以路由表裡沒有那條路）。GitHub Pages 對每個檔案送 max-age=600 而且不 revalidate，
 * 瀏覽器的 HTTP 快取逐檔計時，在 Service Worker 還沒接手的空窗期就會湊出這種組合。
 *
 * 所以這裡做三件事：
 *   1. 畫面上講清楚發生什麼事，並給一顆「更新到最新版」的按鈕
 *   2. 背景主動去問 Service Worker 有沒有新版，有就裝起來
 *   3. 網址留在原地不動 —— 使用者按下更新重載之後，新版的路由表就接得到這條路
 */
setNotFound(({ path }) => {
  showVersionMismatch(path);
});

function showVersionMismatch(rawPath) {
  // location.hash 是百分號編碼的，直接顯示會變成一串 %E6%B2%92…
  let path = rawPath;
  try { path = decodeURIComponent(rawPath); } catch { /* 編碼壞掉就顯示原樣 */ }
  setTop({ title: '需要更新', back: true });
  const btn = h('button', { class: 'btn btn-primary' }, '更新到最新版');
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '更新中…';
    forceUpdate();
  });

  render(
    h('section', { class: 'card', dataset: { card: 'versionMismatch' } },
      h('h2', { class: 'card-title' }, '這個畫面在你目前的版本裡還沒有'),
      h('p', {}, `「${path}」這一頁需要比較新的版本才打得開。`),
      h('p', { class: 'muted sm' },
        '你看到的按鈕來自新版的畫面，但正在執行的程式還是舊的 —— ' +
        '通常是剛更新過、瀏覽器手上還留著一份十分鐘內的舊檔案造成的。'),
      h('p', { class: 'muted sm' }, `目前執行的版本：${APP_VERSION}`),
      btn,
      h('a', { class: 'btn', href: '#/' }, '先回總覽'),
      h('p', { class: 'muted sm' },
        '按了更新還是一樣的話：把 App 完全關掉（iPhone 從多工畫面上滑掉）再開一次。'),
    ),
  );

  // 使用者還在看說明的時候，背景先去把新版抓下來
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  }
}

/**
 * 強制換到最新版。順序是「先禮後兵」：
 * 有等待中的 SW 就叫它接手；沒有的話直接解除註冊再重載，一定拿得到新版。
 * 只在有網路時解除註冊 —— 沒網路又沒 SW 的話 App 會整個打不開。
 */
async function forceUpdate() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update().catch(() => {});
      if (reg.waiting) {
        reg.waiting.postMessage('SKIP_WAITING');
        await new Promise((r) => setTimeout(r, 1200));
      } else if (navigator.onLine) {
        await reg.unregister().catch(() => {});
      }
    }
  } catch { /* noop */ }
  // 帶一個用過即丟的參數，確保連 index.html 都不會從 HTTP 快取拿
  location.replace(`./?fresh=${Date.now()}#/`);
}

// ---------- 啟動 ----------
(async function boot() {
  setSlowIndicator(() => { if (viewIsEmpty()) renderLoading(); });
  renderLoading();
  await store.init();
  prefs.applyFontScale();
  startRouter();
  renderTabs();
  void currentRoute;

  // 開頁自動更新一次。不 await —— 畫面先出來，資料回來再重畫。
  //
  // 重畫一定要走 router.refresh()，不可以自己 import 首頁來畫：資料回來的
  // 那一瞬間檢查一次「還在首頁嗎」是不夠的，import 加上首頁自己讀資料
  // 還要再花一段時間，使用者在那段時間點任何按鈕都會被首頁蓋掉。
  // 走 refresh() 就跟一般導覽受同一套守門保護。
  store.update().then(() => {
    if (currentPath() === '/') refresh();
  });

  if ('serviceWorker' in navigator) {
    // boot() 前面有 await，load 事件很可能早就發生過了 —— 只掛 listener 會永遠不註冊。
    const register = () => navigator.serviceWorker.register('./sw.js').then(setupUpdates).catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
})();

// ---------- 換版 ----------
const bootAt = Date.now();
const AUTO_KEY = 'stockdiary.autoUpdated';
let interacted = false;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => { interacted = true; }, { once: true, passive: true });
}

function appBusy() {
  return !!document.getElementById('modalRoot')?.childElementCount;
}

// 只有「剛打開、還沒動任何東西」才自動換版：這時候重載使用者感覺不到。
function canAutoUpdate() {
  try { if (sessionStorage.getItem(AUTO_KEY)) return false; } catch { return false; }
  return !interacted && !appBusy() && Date.now() - bootAt < 12000;
}

function setupUpdates(reg) {
  let applying = false;
  let reloading = false;
  let firstControl = !navigator.serviceWorker.controller;

  const reload = () => { if (!reloading) { reloading = true; location.reload(); } };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (firstControl) { firstControl = false; return; }
    if (applying || canAutoUpdate()) { reload(); return; }
    showUpdateBar(() => applyNow(null));
  });

  function applyNow(worker) {
    applying = true;
    const w = worker && worker.state === 'installed' ? worker : reg.waiting;
    if (!w) { reload(); return; }
    try { w.postMessage('SKIP_WAITING'); } catch { /* noop */ }
    setTimeout(async () => {
      if (reloading) return;
      try {
        const r = await navigator.serviceWorker.getRegistration();
        if (r && r.waiting) r.waiting.postMessage('SKIP_WAITING');
      } catch { /* noop */ }
      setTimeout(async () => {
        if (reloading) return;
        // 沒網路又解除註冊的話 App 會整個打不開，所以只在有網路時才走這條最後手段
        if (navigator.onLine) {
          try {
            const r = await navigator.serviceWorker.getRegistration();
            if (r) await r.unregister();
          } catch { /* noop */ }
        }
        reload();
      }, 1500);
    }, 2500);
  }

  const ready = (worker) => {
    if (canAutoUpdate()) {
      try { sessionStorage.setItem(AUTO_KEY, '1'); } catch { /* noop */ }
      applying = true;
      applyNow(worker);
      return;
    }
    showUpdateBar(() => applyNow(worker));
  };

  if (reg.waiting) ready(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener('statechange', () => {
      if (nw.state === 'installed' && navigator.serviceWorker.controller) ready(nw);
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
}

function showUpdateBar(onApply) {
  if (document.getElementById('updateBar')) return;
  const text = h('span', { class: 'update-text' }, '有新版本');
  const go = h('button', { class: 'update-go' }, '點一下更新');
  const later = h('button', { class: 'update-later', 'aria-label': '稍後再說', onclick: () => bar.remove() }, '✕');
  const bar = h('div', { id: 'updateBar', class: 'update-bar' }, text, go, later);
  go.addEventListener('click', () => {
    if (bar.dataset.busy) return;
    bar.dataset.busy = '1';
    text.textContent = '更新中…';
    go.textContent = '請稍候';
    go.disabled = true;
    later.remove();
    onApply();
  });
  document.body.append(bar);
}
