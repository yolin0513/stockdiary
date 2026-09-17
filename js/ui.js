// DOM / UI 小工具（沿用 TripQuest 的作法）。
//
// 兩條不可退讓的規則：
//   1. h() 的 children 一律走 document.createTextNode —— 沒有任何路徑會把字串當 HTML 解析。
//      h() 沒有、也不會有 `html:` prop。要顯示什麼就傳字串，它就只是字。
//   2. 網址屬性走白名單，javascript: / data:text 之類進不來。

import { toYuan } from './money.js';

const SAFE_URL = /^(https?:|blob:|mailto:|tel:|#|\.?\/|data:image\/)/i;
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction', 'action', 'poster']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') {
      // CSP 的 style-src 沒有 'unsafe-inline'：style="…" 屬性會被**靜默**忽略
      // （長條圖寬度全變 0，畫面看起來很正常）。CSSOM（el.style.setProperty）不受限，
      // 所以這裡只吃物件；字串一律丟錯，讓回頭路在測試裡就炸。
      if (typeof v !== 'object') throw new TypeError(`h(): style 只接受物件（{ '--w': '40%' }），不接受字串「${v}」`);
      for (const [prop, val] of Object.entries(v)) if (val != null) el.style.setProperty(prop, String(val));
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (URL_ATTRS.has(k)) {
      if (SAFE_URL.test(String(v).trim())) el.setAttribute(k, v);
    } else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
export function mount(node, ...children) { clear(node); node.append(...children.flat().filter(Boolean)); }

let toastTimer = null;
export function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, ms);
}

let modalSeq = 0;

/**
 * 對話框的可及性（A3）：
 *   · 開啟時記住是誰打開的，關閉後焦點回到那顆按鈕 —— 不然讀屏會掉回頁面頂端
 *   · #app 加 inert：對話框開著的時候，後面的東西鍵盤走不到、讀屏唸不到、也點不到
 *   · Tab／Shift+Tab 在卡片內循環（focus trap）
 *   · aria-labelledby 指向標題，讀屏開啟時會唸出「這是什麼對話框」
 * 沒有這四件事的話，鍵盤與讀屏使用者按 Tab 會跑到對話框後面那一頁，
 * 而畫面上什麼都看不出來 —— 只有他們知道自己迷路了。
 */
export function modal({ title, body, actions, closeX = false }) {
  const root = document.getElementById('modalRoot');
  const app = document.getElementById('app');
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const titleId = title ? `modalTitle${++modalSeq}` : null;
    const close = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (app) app.inert = false;
      // 焦點還原：打開對話框的那顆按鈕還在畫面上才還給它
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        try { opener.focus(); } catch { /* noop */ }
      }
      resolve(val);
    };
    const focusables = () => [...card.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const onKey = (e) => {
      if (e.key === 'Escape') { close(null); return; }
      if (e.key !== 'Tab') return;
      // focus trap：走到最後一個再按 Tab 回到第一個；Shift+Tab 反過來
      const list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !card.contains(active))) { e.preventDefault(); first.focus(); }
    };
    const card = h('div', {
      class: 'modal-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
      closeX ? h('button', { class: 'modal-x', 'aria-label': '關閉', onclick: () => close(null) }, '✕') : null,
      title ? h('h2', { class: 'modal-title', id: titleId }, title) : null,
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' },
        ...(actions || [{ label: '好', value: true, primary: true }]).map((a) =>
          h('button', {
            class: 'btn' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' btn-danger' : ''),
            onclick: () => close(a.value),
          }, a.label)
        )
      )
    );
    const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(null); } }, card);
    root.append(overlay);
    if (app) app.inert = true;
    document.addEventListener('keydown', onKey);
    const focusable = card.querySelector('input, textarea, button.btn-primary, button');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  });
}

export async function confirmDialog(message, { danger = false, okLabel = '確定', cancelLabel = '取消' } = {}) {
  return modal({
    body: h('p', { class: 'pre-line' }, message),
    actions: [
      { label: cancelLabel, value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
  });
}

// 等待中的畫面一定要有字。只有一顆轉圈圈，使用者會以為當掉了。
export function spinnerBox(text, sub = '') {
  return h('div', { class: 'wait-box' },
    h('div', { class: 'spinner' }),
    h('p', { class: 'wait-text' }, text),
    sub ? h('p', { class: 'muted sm' }, sub) : null,
  );
}

// ---------- 數字與金額 ----------
//
// 拿不到的數字一律顯示「—」，永遠不顯示 0 冒充。
// fmtMoney(null) === '—' 這條有測試盯著，因為「未公布時顯示 0」是這個 App 最容易犯的錯。

/**
 * 切換開關（軌道＋滑塊）。
 *
 * 為什麼要有這個元件：原本各處都是「一顆膠囊按鈕，上面寫『開啟』或『關閉』」。
 * 使用者實機回報那個**很不直覺** —— 看起來像兩顆按鈕，而且看不出現在是哪一邊：
 * 寫「開啟」到底是「目前開著」還是「按了會開」？軌道＋滑塊沒有這個歧義。
 *
 * 可及性：真的用 role="switch" ＋ aria-checked，並且整塊（含左邊的標籤）都可按。
 * 觸控區用 .switch 的 min-height 44px 保證。
 *
 * @param onChange 收到新的布林值。回傳 Promise 也可以，切換時會先鎖住避免連點。
 */
export function switchRow({ label, hint, checked, onChange, key = null }) {
  const knob = h('span', { class: 'switch-knob' });
  const track = h('span', { class: 'switch-track' }, knob);
  const sw = h('button', {
    class: 'switch' + (checked ? ' on' : ''),
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
    dataset: key ? { pref: key } : {},
  // 「開／關」這兩個字是給眼睛看的；讀屏靠 aria-checked，再唸一次是重複
  }, track, h('span', { class: 'switch-state', 'aria-hidden': 'true' }, checked ? '開' : '關'));

  let busy = false;
  const toggle = async () => {
    if (busy) return;
    busy = true;
    try { await onChange(!checked); } finally { busy = false; }
  };
  sw.addEventListener('click', toggle);

  const row = h('div', { class: 'pref-row' },
    h('div', { class: 'pref-main' },
      h('p', { class: 'pref-label' }, label),
      hint ? h('p', { class: 'muted sm' }, hint) : null),
    sw);
  return row;
}

/**
 * 時／分下拉。**不要用 `<input type="time">`** ——
 * iOS 的原生控制項會被拉滿整個卡片寬度、文字置中，跟其他元件的視覺語言對不上
 * （使用者實機回報這個「跑版」）；而且它空值時會顯示當下時間，看起來像已經設好了。
 * TripQuest 踩過同一個坑，那邊也是改成時／分下拉。
 */
export function timeSelect({ value = '15:00', minuteStep = 5 } = {}) {
  const [hh, mm] = String(value).split(':');
  const pad = (n) => String(n).padStart(2, '0');
  const mk = (opts, cur) => h('select', { class: 'field field-inline' },
    ...opts.map((o) => h('option', { value: o, selected: o === cur ? 'selected' : null }, o)));

  const hours = Array.from({ length: 24 }, (_, i) => pad(i));
  const minutes = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => pad(i * minuteStep));
  const hSel = mk(hours, pad(Number(hh)));
  const mSel = mk(minutes, pad(Number(mm)));
  const wrap = h('div', { class: 'time-select' }, hSel, h('span', { class: 'time-colon' }, '：'), mSel);
  return { node: wrap, get value() { return `${hSel.value}:${mSel.value}`; } };
}

export const NO_VALUE = '—';

export function fmtMoney(n, { sign = false } = {}) {
  if (n == null || !Number.isFinite(n)) return NO_VALUE;
  const rounded = Math.round(n);
  const s = Math.abs(rounded).toLocaleString('zh-Hant-TW');
  if (rounded < 0) return `-${s}`;
  return sign && rounded > 0 ? `+${s}` : s;
}

export function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return NO_VALUE;
  return n.toLocaleString('zh-Hant-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPct(n, { sign = false } = {}) {
  if (n == null || !Number.isFinite(n)) return NO_VALUE;
  const s = `${Math.abs(n).toFixed(2)}%`;
  if (n < 0) return `-${s}`;
  return sign && n > 0 ? `+${s}` : s;
}

export function fmtShares(n) {
  if (n == null || !Number.isFinite(n)) return NO_VALUE;
  return Math.round(n).toLocaleString('zh-Hant-TW');
}

/** '2026-09-10' → '9/10'；拿不到日期回 '—'。 */
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return NO_VALUE;
  return `${Number(m[2])}/${Number(m[3])}`;
}

// ---------- 微元（BigInt）的顯示 ----------
//
// 金額在程式裡一律是 BigInt 微元（見 money.js）。畫面上每一個金額、價格、
// 報酬率都包在 <span class="num"> 裡 —— 測試靠這個 class 斷言
// 「不支援報價的持股，那一列連一個數字都沒有」。

export function num(text, extraClass = '') {
  return h('span', { class: 'num' + (extraClass ? ' ' + extraClass : '') }, text);
}

export function fmtMoneyMicro(micro, opts) {
  return fmtMoney(micro == null ? null : toYuan(micro), opts);
}

/** 金額節點。正負會帶上對應的 class（顏色由 CSS 決定，AI 文字區塊不用這個）。 */
export function moneyNode(micro, { sign = true } = {}) {
  const v = micro == null ? null : toYuan(micro);
  const cls = v == null ? 'v-none' : v > 0 ? 'v-up' : v < 0 ? 'v-down' : 'v-flat';
  return num(fmtMoney(v, { sign }), cls);
}

/**
 * 「回補中 3/12：回補 0050 2026-08」那一行。
 *
 * PLAN §2.2 說長假回補時要顯示進度，但 `onProgress` 一直沒有人接 ——
 * 使用者看到的是一個不動的畫面，分不出它在做事還是當掉了。
 *
 * **只在 total > 1 時顯示**：單一請求（最常見的情況）一閃而過，畫出來只會讓畫面抖一下。
 *
 * 訂閱會自己退掉。`render()` 是整個換掉 `#view`，沒有 cleanup 的鉤子，
 * 所以這裡用「節點還在不在畫面上」當作存活判斷 —— 換過頁之後就不再重畫了。
 * （mounted 這個旗標是必要的：第一次訂閱時節點還沒 mount，
 * 少了它會在第一次回呼就把自己退掉。）
 */
export function progressLine(getProgress, subscribe) {
  const line = h('p', { class: 'muted sm', dataset: { note: 'updateProgress' } }, '');
  const paint = () => {
    const pr = getProgress();
    const show = !!pr && pr.total > 1 && pr.done < pr.total;
    line.textContent = show ? `回補中 ${pr.done}/${pr.total}：${pr.label}` : '';
    line.hidden = !show;
  };
  paint();
  let mounted = false;
  const off = subscribe(() => {
    if (line.isConnected) mounted = true;
    else if (mounted) { off(); return; }
    paint();
  });
  return line;
}
