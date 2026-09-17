/* StockDiary Service Worker
 * - SHELL（HTML/CSS/JS/data JSON）：install 時整組預快取，之後只從本版快取拿（cache-first）
 * - 導覽請求：network-first，離線時回退 index.html
 * - TWSE / RSS / Anthropic 等跨網域請求：一律不快取
 *   （拿舊的收盤價冒充今天，比拿不到還糟）
 *
 * 每次改動任何 SHELL 檔案都要 bump VERSION，否則使用者拿到的還是舊程式。
 */
const VERSION = 'stockdiary-v0.7.22';
const SHELL = `${VERSION}-shell`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/bootguard.js',
  './js/app.js',
  './js/router.js',
  './js/store.js',
  './js/db.js',
  './js/ui.js',
  './js/shell.js',
  './js/prefs.js',
  './js/roc.js',
  './js/twse.js',
  './js/market.js',
  './js/catalog.js',
  './js/version.js',
  './js/money.js',
  './js/settle.js',
  './js/holdings.js',
  './js/prices.js',
  './js/twseclient.js',
  './js/update.js',
  './js/dividend.js',
  './js/events.js',
  './js/news.js',
  './js/rss.js',
  './js/secrets.js',
  './js/insight.js',
  './js/backup.js',
  './js/concentration.js',
  './js/divrecord.js',
  './js/plans.js',
  './js/avgcost.js',
  './js/calc.js',
  './js/views/home.js',
  './js/views/holdings.js',
  './js/views/holding.js',
  './js/views/dividends.js',
  './js/views/news.js',
  './js/views/plans.js',
  './js/views/calc.js',
  './js/views/settings.js',
  './data/stocks.json',
  './data/calendar.json',
  './data/dividends.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const SHELL_SET = new Set(SHELL_ASSETS.map((u) => new URL(u, self.location.href).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(
    // cache:'reload' 一定要加：GitHub Pages 對每個檔案送 Cache-Control: max-age=600，
    // 普通的 addAll 會走瀏覽器 HTTP 快取，新版 SW 有機會把舊的 JS 存進新快取
    // —— 那就是「要重開兩次才生效」的元凶。
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    // 這裡刻意不自動 skipWaiting：由畫面決定何時換版。
  );
});

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d === 'SKIP_WAITING' || (d && d.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NAV_TIMEOUT_MS = 3000;

function navigateWithTimeout(request) {
  const fromCache = () => caches.match('./index.html');
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  return Promise.race([fetch(request).catch(() => null), timer])
    .then((res) => res || fromCache().then((hit) => hit || fetch(request)));
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // 跨網域（TWSE 收盤、RSS、Anthropic）：直接走網路，永遠不快取。
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // network-first，但**最多等 3 秒**。GitHub Pages 慢或行動網路訊號差的時候，
    // 以前要等到 fetch 自己失敗（可能幾十秒）才退回快取 —— 而 index.html 本來就在 SHELL 裡。
    // 換版仍然靠 registration.update()（那條路不經過這裡），所以逾時退回舊 index.html 不會卡在舊版。
    e.respondWith(navigateWithTimeout(request));
    return;
  }

  // SHELL：只從「這個版本的快取」拿，不背景覆寫。
  // 背景覆寫會造成「舊 app.js 還在跑、動態載入卻拿到新的 view」：
  // 畫面有新按鈕、路由表沒那條路，一點就被踢回首頁。
  if (SHELL_SET.has(url.pathname)) {
    // ignoreSearch：網址上的 ?v=<版本> 只是給瀏覽器 HTTP 快取用的鍵，
    // 對 SW 的快取來說同一個檔案就是同一個檔案。不忽略的話，帶版本參數的請求
    // 會在快取裡找不到、只能走網路 —— 離線就打不開了。
    e.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
    return;
  }

  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(SHELL).then((c) => c.put(request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
