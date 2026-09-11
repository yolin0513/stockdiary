// hash 路由 + 真實導覽歷史堆疊（沿用 TripQuest 的作法）。
//
// 「返回」＝回到使用者上一個實際造訪的畫面，不是硬寫的父層。

const routes = [];
let notFound = null;
let current = null;

let slowIndicator = null;
export function setSlowIndicator(fn) { slowIndicator = fn; }

let depth = 0;
const trail = [];
const scrollMemory = new Map();
let curRaw = '/';
let restoredScroll = false;

function rememberScroll() { scrollMemory.set(curRaw, window.scrollY); }
export function navRestoredScroll() { return restoredScroll; }

export function route(pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ rx, keys, handler, pattern });
}
export function setNotFound(fn) { notFound = fn; }

/** 這個 App 註冊過的所有路由樣式（給稽核測試用）。 */
export function routePatterns() { return routes.map((r) => r.pattern); }

export function navigate(path, { replace = false } = {}) {
  const target = '#' + path;
  const cur = location.hash || '#/';
  if (target === cur) { resolve(); return; }
  if (replace) {
    location.replace(target);
    if (trail.length) trail[trail.length - 1] = path;
  } else {
    location.hash = target;
  }
}

export function back(fallback = '/') {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}
export function canGoBack() { return depth > 0; }

export function resetHistory(path = '/') {
  trail.length = 0;
  trail.push(path);
  depth = 0;
  const target = '#' + path;
  if ((location.hash || '#/') === target) resolve();
  else location.replace(target);
}

function parse(hash) {
  const raw = (hash ?? location.hash).replace(/^#/, '') || '/';
  const path = raw.split('?')[0];
  const query = Object.fromEntries(new URLSearchParams(raw.split('?')[1] || ''));
  return { raw, path, query };
}

let gen = 0;
async function resolve() {
  const my = ++gen;
  const { raw, path, query } = parse();
  const restore = scrollMemory.has(raw) ? scrollMemory.get(raw) : null;
  restoredScroll = restore != null;
  curRaw = raw;

  for (const r of routes) {
    const m = path.match(r.rx);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    current = { path, params, query, pattern: r.pattern };
    if (restore == null) window.scrollTo(0, 0);
    // view 是 async 的。慢到 250ms 還沒畫東西才補轉圈圈 —— 無條件先畫會變成閃一下。
    let slow = setTimeout(() => { if (slowIndicator && my === gen) slowIndicator(); }, 250);
    try { await r.handler({ params, query, path, fresh: true }); }
    catch (e) { console.error(e); }
    finally { clearTimeout(slow); slow = null; }
    if (restore != null) {
      window.scrollTo(0, restore);
      requestAnimationFrame(() => { if (my === gen) window.scrollTo(0, restore); });
    }
    return;
  }
  if (notFound) await notFound({ path });
}

export function currentRoute() { return current; }

function onHashChange() {
  const { raw } = parse();
  if (trail.length >= 2 && trail[trail.length - 2] === raw) {
    trail.pop();
    depth = Math.max(0, depth - 1);
  } else if (trail[trail.length - 1] !== raw) {
    trail.push(raw);
    depth += 1;
  }
  resolve();
}

export function startRouter() {
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('scroll', rememberScroll, { passive: true });
  const { raw } = parse();
  if (!location.hash) { location.replace('#/'); trail.push('/'); }
  else trail.push(raw);
  resolve();
}
