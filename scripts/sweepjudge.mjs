// sweep（線上巡檢）的判斷邏輯與對照組（SPEC_檢查器修補 S4，F1）。
//
// 為什麼抽出來：sweep 打的是正式環境，平常線上版本剛好一致，判斷邏輯壞掉也看不出來——
// v9 盤點實測：版本比對改成永遠成立，20 項照樣全過，沒有東西報。
// 抽成模組之後：sweep 開頭先用錄好的合成回應跑對照組（不打網路）、沒過就停；
// scripts/controltest.mjs 每版在 npm test 裡跑同一組。sweep 本體用的是同一段程式。
//
// 對照組（合成樣本，版本號都是造的）：
//   · 線上 sw.js 是舊版            → 版本比對要報 sw.js
//   · 線上 index.html 載入的是舊版 → 版本比對要報 index.html
//   · sw.js 讀不到版本（例如 404 頁）→ 要報，不能當成一致
//   · 還留著舊版的快取              → 要挑出那一個
//   · 一個不是新聞上游的主控台錯誤   → 要算進「真的錯誤」，不能被當成新聞上游的雜訊丟掉
//   · （必過）全部一致、只有新聞上游 502 → 什麼都不報

/** 從線上 sw.js 與 index.html 的原文取出版本號；取不到就是 undefined。 */
export function parseLive(swText, htmlText) {
  return {
    sw: /const VERSION = '([^']+)';/.exec(swText)?.[1],
    html: /app\.js\?v=([^"]+)"/.exec(htmlText)?.[1],
  };
}

/** 版本問題清單：[{ where: 'sw.js'｜'index.html'｜'格式', got }]；空的＝一致。 */
export function versionProblems({ sw, html, local }) {
  const out = [];
  if (sw !== local) out.push({ where: 'sw.js', got: sw });
  if (html !== local) out.push({ where: 'index.html', got: html });
  if (!/^stockdiary-v\d+\.\d+\.\d+$/.test(String(sw))) out.push({ where: '格式', got: sw });
  return out;
}

/** 快取：有沒有這一版的、留下了哪些別版的。 */
export function cacheProblems(caches, local) {
  return { hasCurrent: caches.some((c) => c.includes(local)), stale: caches.filter((c) => !c.includes(local)) };
}

// 新聞上游（經 Worker 的那四家）偶爾限速回 502、換頁時請求被中止——那不是部署壞掉，分開數、分開報。
const isNewsUpstream = (t) => t.includes('stockdiary-news.') || /rss\?src=/.test(t);
const isNoise = (t) => /favicon/.test(t);

/** 把主控台錯誤與失敗的請求分成「真的」與「新聞上游」兩堆。 */
export function splitErrors(errors, failed) {
  return {
    realErrors: errors.filter((e) => !isNoise(e) && !(isNewsUpstream(e) || /502/.test(e))),
    newsErrors: errors.filter((e) => !isNoise(e) && (isNewsUpstream(e) || /502/.test(e))),
    realFailed: failed.filter((f) => !isNoise(f) && !isNewsUpstream(f)),
    newsFailed: failed.filter((f) => !isNoise(f) && isNewsUpstream(f)),
  };
}

/** 對照組。回傳 [{ key, name, ok, detail }]；呼叫端決定怎麼印、失敗時停下。 */
export function controls() {
  const L = 'stockdiary-v9.9.9';   // 合成的「工作目錄版本」
  const OLD = 'stockdiary-v9.9.8';
  const sw = (v) => `const VERSION = '${v}';\nself.addEventListener('install', () => {});\n`;
  const html = (v) => `<script type="module" src="./js/app.js?v=${v}"></script>`;
  const where = (p) => p.map((x) => x.where).join('、') || '（沒有）';
  const res = [];

  const swOld = versionProblems({ ...parseLive(sw(OLD), html(L)), local: L });
  res.push({ key: 'sw-old', name: '線上 sw.js 是舊版 → 版本比對報 sw.js', ok: swOld.some((p) => p.where === 'sw.js' && p.got === OLD), detail: `報了：${where(swOld)}` });

  const htmlOld = versionProblems({ ...parseLive(sw(L), html(OLD)), local: L });
  res.push({ key: 'html-old', name: '線上 index.html 載入舊版 → 版本比對報 index.html', ok: htmlOld.some((p) => p.where === 'index.html' && p.got === OLD), detail: `報了：${where(htmlOld)}` });

  const swGone = versionProblems({ ...parseLive('<html>404 Not Found</html>', html(L)), local: L });
  res.push({ key: 'sw-missing', name: 'sw.js 讀不到版本（404 頁）→ 要報，不能當成一致', ok: swGone.some((p) => p.where === 'sw.js' && p.got === undefined), detail: `報了：${where(swGone)}` });

  const cache = cacheProblems([`${L}-shell`, `${OLD}-shell`], L);
  res.push({ key: 'cache-stale', name: '還留著舊版的快取 → 挑出那一個', ok: cache.hasCurrent && cache.stale.length === 1 && cache.stale[0] === `${OLD}-shell`, detail: `挑出 ${cache.stale.length} 個` });

  const errs = splitErrors(['pageerror: Cannot read properties of undefined', 'console: https://stockdiary-news.example/rss?src=cnyes 502'], []);
  res.push({ key: 'real-error', name: '不是新聞上游的錯誤 → 算進真的錯誤', ok: errs.realErrors.length === 1 && errs.realErrors[0].startsWith('pageerror') && errs.newsErrors.length === 1, detail: `真的 ${errs.realErrors.length}、新聞上游 ${errs.newsErrors.length}` });

  const cleanV = versionProblems({ ...parseLive(sw(L), html(L)), local: L });
  const cleanC = cacheProblems([`${L}-shell`], L);
  const cleanE = splitErrors(['console: Failed to load resource: 502'], ['https://stockdiary-news.example/rss?src=cnyes net::ERR_ABORTED']);
  res.push({ key: 'clean', name: '（必過）全部一致、只有新聞上游 502 → 什麼都不報', ok: cleanV.length === 0 && cleanC.hasCurrent && cleanC.stale.length === 0 && cleanE.realErrors.length === 0 && cleanE.realFailed.length === 0, detail: `版本 ${where(cleanV)}、舊快取 ${cleanC.stale.length}、真的錯誤 ${cleanE.realErrors.length + cleanE.realFailed.length}` });
  return res;
}
