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

/**
 * view 丟例外時要畫什麼。
 *
 * 以前這裡只有 console.error —— hash 換了、分頁亮了、#view 卻還是上一頁，
 * 而 iPhone 上沒有 console。使用者回報過這個症狀：「底部的設定按了沒反應」。
 * 不管 view 是為什麼炸的，畫面上都要講出來，而且要把例外訊息原樣放上去，
 * 使用者才有東西可以截圖回報。
 */
let viewError = null;
export function setViewError(fn) { viewError = fn; }

/** 這個 App 註冊過的所有路由樣式（給稽核測試用）。 */
export function routePatterns() { return routes.map((r) => r.pattern); }

export function navigate(path, { replace = false } = {}) {
  // 已經過期的 view 不准把使用者拉走。
  // 例如 holding.js 查不到代號時會 navigate('/holdings')，但那個判斷在 await 之後 ——
  // 使用者早就點去別頁了，這時候 location.replace 會硬把人從他選的那一頁扯回去。
  // 症狀跟「按了按鈕跳回別頁」一模一樣。不做事才是對的：runLatest 會把使用者
  // 真正要的那一頁畫出來（racetest.mjs 有一節在守這件事）。
  if (renderIsStale()) return;
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

// ---------- 誰有資格畫面上那塊畫布 ----------
//
// 每個 view 都是 async 的：`await import(...)` → `await 讀資料` → `render(...)`。
// 這中間使用者隨時可能換頁。沒有守門的話，**最後畫完的那個贏** —— 網址是新的、
// 畫面是舊的，看起來就是「按了按鈕跳到別頁」。使用者回報過這個症狀。
//
// 守門分兩層：
//   gen      每導覽一次 +1
//   paintGen 目前正在跑的那個 view 是哪一代
// 兩者不相等，就代表正在跑的那個 view 已經過期了，它畫的東西一律不算數
// （render() 會問 renderIsStale()）。
//
// 而且同一時間只跑一個 view（runLatest 的迴圈）。這樣 paintGen 在一個 view
// 從頭跑到尾的期間不會被別人改掉，「有沒有人在我背後換過頁」才問得準。
// 跑完發現又有人換頁了就再跑一次最新的，所以最後一定會停在對的那一頁。
let gen = 0;
let paintGen = 0;
let running = false;

/** 正在跑的這個 view 是不是已經被更新的導覽取代了？（給 render() 當守門用） */
export function renderIsStale() { return paintGen !== gen; }

function resolve() {
  const my = ++gen;
  // view 是 async 的。慢到 250ms 還沒換畫面才補轉圈圈 —— 無條件先畫會變成閃一下。
  // 計時從「使用者按下去」開始算，不是從輪到它跑才算。
  setTimeout(() => { if (slowIndicator && my === gen && paintGen !== my) slowIndicator(); }, 250);
  if (running) return; // 現在這一輪跑完會自己接著跑最新的
  runLatest();
}

async function runLatest() {
  running = true;
  try {
    while (paintGen !== gen) await renderOnce();
  } finally {
    running = false;
  }
}

async function renderOnce() {
  paintGen = gen;
  const my = paintGen;
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
    try { await r.handler({ params, query, path, fresh: true }); }
    catch (e) {
      console.error(e);
      // 這個 view 已經被更新的導覽取代了 → 不要畫；最新那一頁會由 runLatest 接手
      if (my !== gen) return;
      if (viewError) {
        try { await viewError({ path, error: e }); }
        catch (e2) { console.error('連錯誤畫面都畫不出來', e2); }
      }
    }
    if (my !== gen) return; // 畫到一半使用者就走了，捲動位置也不要動
    if (restore != null) {
      window.scrollTo(0, restore);
      requestAnimationFrame(() => { if (my === gen) window.scrollTo(0, restore); });
    }
    return;
  }
  if (notFound) await notFound({ path });
}

/**
 * 重畫目前這一頁（資料更新回來時用）。
 * 走的是跟一般導覽同一條路，所以同樣受上面那套守門保護 ——
 * 資料慢慢回來的期間使用者換了頁，就不會被舊資料的畫面蓋掉。
 */
export function refresh() { resolve(); }

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
