// 要逐頁開起來看的路由（登記制），給 sweep（線上巡檢）與 upgradecheck（換版實測）共用；外加孤兒檢查。
//
// 為什麼（2026-09-24，範圍外發現第 3、4 件）：兩支各自寫死自己的清單——
//   · sweep 寫死 7 條：新註冊的路由不會被巡檢，也不會被報出來（S9 實測：多註冊 /zzq，20 項照樣全過）
//   · upgradecheck 只開主畫面、持股頁 → 定期定額：新版「股利」頁一開就拋錯，它照樣 17 項通過（S9 實測）
// 現在兩支都讀這一份，而且 js/app.js 註冊的每一條路由，都要在 ROUTES 裡、或在 ROUTE_SKIP 寫明不巡的理由；
// 對不上就報（controltest 每版靜態比對 js/app.js；sweep 與 upgradecheck 跑的時候再比一次瀏覽器裡真的註冊的）。

/** [路由, 那一頁的標題]。 */
export const ROUTES = [
  ['/', 'StockDiary 股息日記'],
  ['/holdings', '持股'],
  ['/plans', '定期定額'],
  ['/dividends', '股利'],
  ['/news', '新聞'],
  ['/calc', '定期定額試算'],
  ['/settings', '設定'],
];

/** 註冊了、但不逐頁開的路由：路由 → 理由。 */
export const ROUTE_SKIP = {
  '/holdings/:code': '帶參數的路由：要有真的持股代號才進得去（沒有會導回持股頁）；holdingtest 從 #/holdings/<代號> 驗它',
};

/** 從 js/app.js 的原文取出註冊的路由（route('…', …)）。 */
export function registeredRoutes(appJsText) {
  return [...String(appJsText).matchAll(/^\s*route\('([^']+)'/gm)].map((m) => m[1]);
}

/** 孤兒檢查：註冊了卻沒登記也沒理由的（missing）、登記了卻沒註冊的（stale）、理由過期的（skipStale）。 */
export function routeOrphans(registered, routes = ROUTES, skip = ROUTE_SKIP) {
  const listed = routes.map(([r]) => r);
  return {
    missing: registered.filter((r) => !listed.includes(r) && !(r in skip)),
    stale: listed.filter((r) => !registered.includes(r)),
    skipStale: Object.keys(skip).filter((r) => !registered.includes(r)),
  };
}

/** 對照組（合成的 app.js 原文，跑的是跟真實檢查同一段 registeredRoutes／routeOrphans）。 */
export function controls() {
  const app = (extra = '') => [
    "import { route } from './router.js';",
    "route('/', async () => 0);",
    "route('/a', async () => 0);",
    "route('/a/:id', async () => 0);",
    "// route('/commented', …) 註解裡的不算",
    extra,
  ].join('\n');
  const R = [['/', 'H'], ['/a', 'A']];
  const S = { '/a/:id': '理由' };
  const res = [];
  const clean = routeOrphans(registeredRoutes(app()), R, S);
  const n = clean.missing.length + clean.stale.length + clean.skipStale.length;
  res.push({ key: 'clean', name: '（必過）註冊的全部登記或寫了理由 → 不報；註解裡的 route 不算', ok: registeredRoutes(app()).join() === '/,/a,/a/:id' && n === 0, detail: `取到 ${registeredRoutes(app()).join('、')}；報了 ${n}` });
  const extra = routeOrphans(registeredRoutes(app("route('/zzq', async () => 0);")), R, S);
  res.push({ key: 'missing', name: '多註冊一條 /zzq、沒登記 → 報出它', ok: extra.missing.join() === '/zzq', detail: `報了：${extra.missing.join('、') || '（沒有）'}` });
  const stale = routeOrphans(registeredRoutes(app()), [...R, ['/gone', 'G']], S);
  res.push({ key: 'stale', name: '清單裡有一條沒註冊的 /gone → 報出它', ok: stale.stale.join() === '/gone', detail: `報了：${stale.stale.join('、') || '（沒有）'}` });
  const skipStale = routeOrphans(registeredRoutes(app()), R, { ...S, '/old/:x': '理由' });
  res.push({ key: 'skip-stale', name: '不巡的理由寫給一條沒註冊的 → 報出它', ok: skipStale.skipStale.join() === '/old/:x', detail: `報了：${skipStale.skipStale.join('、') || '（沒有）'}` });
  return res;
}
