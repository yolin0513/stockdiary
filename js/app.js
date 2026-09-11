// 進入點：路由表、底部分頁列、Service Worker 換版流程。

import { route, setNotFound, startRouter, navigate, currentRoute, back, canGoBack, setSlowIndicator } from './router.js';
import * as store from './store.js';
import * as prefs from './prefs.js';
import { mount, h, spinnerBox } from './ui.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');

export function setTop({ title, back: showBack = true, action = null }) {
  document.getElementById('topTitle').textContent = title || 'StockDiary';
  const backBtn = document.getElementById('backBtn');
  backBtn.hidden = !showBack || !canGoBack();
  const actionBtn = document.getElementById('topActionBtn');
  if (action) {
    actionBtn.hidden = false;
    actionBtn.textContent = action.label;
    actionBtn.setAttribute('aria-label', action.aria || action.label);
    actionBtn.onclick = action.onclick;
  } else {
    actionBtn.hidden = true;
    actionBtn.onclick = null;
  }
  void topbar;
}

export function render(node) { mount(view, node); renderTabs(); }
export function renderLoading(text = '載入中…') { mount(view, spinnerBox(text)); }

document.getElementById('backBtn').addEventListener('click', () => back('/'));

// ---------- 底部分頁 ----------
const TABS = [
  { icon: '📈', label: '總覽', path: '/' },
  { icon: '⚙️', label: '設定', path: '/settings' },
];

function currentPath() { return (location.hash.replace(/^#/, '') || '/').split('?')[0]; }

function renderTabs() {
  const bar = document.getElementById('tabbar');
  const here = currentPath();
  mount(bar, ...TABS.map((t) => {
    const on = here === t.path;
    return h('a', {
      class: 'tab' + (on ? ' on' : ''),
      href: `#${t.path}`,
      'aria-current': on ? 'page' : null,
    }, h('span', { class: 'tab-icon' }, t.icon), h('span', { class: 'tab-label' }, t.label));
  }));
}
window.addEventListener('hashchange', renderTabs);

// ---------- 路由 ----------
route('/', async () => (await import('./views/home.js')).default());
route('/settings', async () => (await import('./views/settings.js')).default());
setNotFound(() => navigate('/', { replace: true }));

// ---------- 啟動 ----------
(async function boot() {
  setSlowIndicator(() => { if (!view.firstChild) renderLoading(); });
  renderLoading();
  await store.init();
  prefs.applyFontScale();
  startRouter();
  renderTabs();
  void currentRoute;

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
