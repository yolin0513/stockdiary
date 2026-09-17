// 進入點：路由表、Service Worker 換版流程。
//
// **這個檔案只能由 index.html 載入，不准被任何模組 import。**
// index.html 載入的網址帶版本參數（`./js/app.js?v=<版本>`）；只要有人用
// `'./app.js'`（沒帶參數）import 它，瀏覽器就會把它當成另一個網址再求值一次 ——
// boot() 跑兩次、路由註冊兩次、TWSE 被打兩輪。view 要用的東西在 js/shell.js。
// shelltest 有靜態稽核擋這件事。

import { route, setNotFound, setViewError, startRouter, navigate, currentRoute, setSlowIndicator, refresh } from './router.js';
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
route('/news', async () => (await import(`./views/news.js${V}`)).default());
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

/**
 * 認得的網址、但那個 view 自己炸了。
 *
 * 使用者回報過的症狀：「底部的設定按了沒反應」。實際上是 settings() 丟了例外，
 * 路由只印 console.error —— hash 換了、分頁亮了、#view 卻還是上一頁，
 * 而 iPhone 沒有 console。**不管根因是什麼，畫面上都要講出來**，
 * 而且要把例外訊息原樣放上去：使用者截圖回報，開發者才看得到根因。
 *
 * 跟 showVersionMismatch 一樣給「更新到最新版」—— view 炸掉最常見的原因
 * 仍然是版本混搭（新 view 用了舊模組沒有的東西）。
 */
setViewError(({ path, error }) => {
  const message = String(error?.message ?? error ?? '（沒有訊息）');
  setTop({ title: '這一頁打不開', back: true });
  const btn = h('button', { class: 'btn btn-primary' }, '更新到最新版');
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '更新中…';
    forceUpdate();
  });
  render(
    h('section', { class: 'card', dataset: { card: 'viewError' } },
      h('h2', { class: 'card-title' }, '這一頁打不開'),
      h('p', {}, `「${path}」畫到一半出了錯，所以沒有換頁。你的資料沒有被動到。`),
      h('p', { class: 'muted sm' }, '錯誤訊息（回報時請把這段一起截圖）：'),
      h('p', { class: 'mono sm', dataset: { field: 'viewErrorMessage' } }, message),
      h('p', { class: 'muted sm' }, `目前執行的版本：${APP_VERSION}`),
      btn,
      h('a', { class: 'btn', href: '#/' }, '先回總覽'),
      h('p', { class: 'muted sm' },
        '按了更新還是一樣的話：把 App 完全關掉（iPhone 從多工畫面上滑掉）再開一次。'),
    ),
  );
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
/**
 * 開機等 store.init() **最多**這麼久。
 *
 * 使用者回報（v0.7.18）：按下「更新」之後只剩標題列、下面整片空白，只能把 App 滑掉重開。
 * 連底部分頁都沒有 —— 分頁是 renderTabs() 畫的、標題列是 index.html 靜態的，
 * 所以那一刻 boot() 卡在 startRouter() 之前，也就是卡在 await store.init()。
 * iOS Safari 在 Service Worker 剛換手（reload 落在 activate 進行中）時，
 * 之後的 fetch／IndexedDB 有機會永遠不回來 —— AbortSignal.timeout 也救不了吊死的請求。
 *
 * 所以開機不能無條件等：時間到就先把路由與分頁畫出來（每一頁本來就會對
 * 「尚未取得代號表／開休市日」講清楚），資料晚到再 refresh()。
 */
const BOOT_DEADLINE_MS = 6000;

(async function boot() {
  setSlowIndicator(() => { if (viewIsEmpty()) renderLoading(); });
  renderLoading();

  let initDone = false;
  const initP = store.init()
    .catch((e) => { console.warn('store.init 失敗，先開畫面', e); })
    .then(() => { initDone = true; });
  await Promise.race([initP, new Promise((r) => setTimeout(r, BOOT_DEADLINE_MS))]);
  if (!initDone) {
    console.warn(`store.init 超過 ${BOOT_DEADLINE_MS}ms 還沒回來，先開畫面`);
    // 晚到的資料回來時重畫目前這一頁（走 router.refresh()，受同一套守門保護）
    initP.then(() => refresh());
  }

  prefs.applyFontScale();
  startRouter();
  renderTabs();
  // 告訴看門狗（js/bootguard.js）：module 圖跑起來了，不必補救援卡
  document.documentElement.setAttribute('data-booted', '1');
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

  // 不在 controllerchange 的當下同步 reload。
  // 那一刻新 SW 還在 activate（clients.claim() 是在 activate 的 waitUntil 裡呼叫的），
  // iOS Safari 在這個空窗 reload 有機會讓新文件的請求全部吊死 —— 畫面就停在空白。
  // 等 navigator.serviceWorker.ready（activate 完全結束）再多讓一個 tick，才重載。
  const reload = () => {
    if (reloading) return;
    reloading = true;
    const go = () => location.reload();
    const ready = navigator.serviceWorker?.ready ?? Promise.resolve();
    Promise.race([ready, new Promise((r) => setTimeout(r, 3000))])
      .then(() => setTimeout(go, 250), () => setTimeout(go, 250));
  };

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
      setTimeout(() => {
        if (reloading) return;
        // **這裡不再 unregister。** 以前會：解除註冊之後這一頁就沒有 Service Worker 了，
        // 重載時二十幾個檔只能走網路，任何一個在網路不穩的那幾秒拿不到，整張 module 圖就不執行，
        // 也沒有快取可退 —— 畫面停在「只有 HTML 預設標題、沒有分頁、連轉圈圈都沒有」。
        // navigator.onLine 擋不住：它只代表連上某個網路，不保證連得到伺服器。
        // 只 reload：新 SW 準備好就換過去；還沒接手的話舊 SW 仍供得出整組舊版，畫面至少完整可用。
        // unregister 只留在 forceUpdate()（「需要更新」那張卡）當逃生門。
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
