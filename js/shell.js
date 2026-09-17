// 畫面外殼：頂列、底部分頁、把一個畫面放上去。
//
// 為什麼這些不放在 app.js：
//
// `index.html` 載入的是 `./js/app.js?v=<版本>`（版本參數是 HTTP 快取鍵）。
// 如果 view 再 `import { render } from '../app.js'`（沒帶參數），對瀏覽器來說那是
// **另一個網址**，整個 app.js 會被重新求值一次 —— boot() 跑兩次、路由註冊兩次、
// TWSE 也會被打兩輪。實測確認過：`performance` 裡真的有兩筆 app.js。
//
// 所以 app.js 是**只有 index.html 會載入的進入點，不准被任何人 import**，
// view 要的東西一律放這裡。shelltest 有靜態稽核擋著。

import { mount, h, spinnerBox } from './ui.js';
import { back, canGoBack, renderIsStale } from './router.js';

const view = document.getElementById('view');

export function setTop({ title, back: showBack = true, action = null }) {
  // 跟 render() 同一道守門：過期的 view 不准改頂列，不然會出現
  // 「內容是新的那一頁、標題還是舊的那一頁」。
  if (renderIsStale()) return;
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
}

/**
 * 把一個畫面放上去 —— 除非它已經過期了。
 *
 * view 是 async 的，`await import()` 加上讀資料，在手機上輕易就是好幾百毫秒。
 * 這段時間使用者換了頁，這個 view 醒來還是會走到這裡。放它畫上去的話，
 * 網址是新的、畫面是舊的 —— 使用者看到的就是「按了按鈕跳到別頁」。
 *
 * 這裡不畫不是把錯誤吞掉：router 的 runLatest 迴圈接著就會把使用者真正
 * 要的那一頁畫出來（racetest.mjs 的最後一節就是在守這件事）。
 */
export function render(node) {
  if (renderIsStale()) return;
  mount(view, node);
  renderTabs();
}

export function renderLoading(text = '載入中…') { mount(view, spinnerBox(text)); }

/** #view 目前是不是空的（給慢速指示器判斷用）。 */
export function viewIsEmpty() { return !view.firstChild; }

// ---------- 底部分頁 ----------
const TABS = [
  { icon: '📈', label: '總覽', path: '/' },
  { icon: '📋', label: '持股', path: '/holdings' },
  { icon: '💰', label: '股利', path: '/dividends' },
  { icon: '🧮', label: '試算', path: '/calc' },
  { icon: '⚙️', label: '設定', path: '/settings' },
];

export function currentPath() { return (location.hash.replace(/^#/, '') || '/').split('?')[0]; }

export function renderTabs() {
  const bar = document.getElementById('tabbar');
  const here = currentPath();
  mount(bar, ...TABS.map((t) => {
    const on = here === t.path;
    return h('a', {
      class: 'tab' + (on ? ' on' : ''),
      href: `#${t.path}`,
      'aria-current': on ? 'page' : null,
    // emoji 對讀屏是「圖形」不是字。藏起來，連結的名稱就只剩「總覽」「設定」——
    // 實測過：沒藏的時候無障礙樹裡這條連結**沒有名字**。
    }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, t.icon), h('span', { class: 'tab-label' }, t.label));
  }));
}

window.addEventListener('hashchange', renderTabs);
document.getElementById('backBtn').addEventListener('click', () => back('/'));
