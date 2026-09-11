// StockDiary 新聞轉發 Worker —— 無狀態，只做「轉發＋快取」。
//
// 為什麼需要它：國內四家 RSS 都沒有 ACAO 標頭，瀏覽器直打會被 CORS 擋下
// （FEASIBILITY §5）。國際的 CNBC／MarketWatch 有 ACAO，前端直打，不經這裡。
//
// 刻意**不做**的事（PLAN §3 N1 方案）：
//   · 沒有 KV、沒有 D1、沒有 R2、沒有 Cron —— 什麼都不存
//   · 不解析 XML（免費方案每次 10 ms CPU，解析交給前端）
//   · 不接使用者的任何資料、不碰金鑰（AI 是瀏覽器直連 api.anthropic.com）
//
// 端點：
//   GET /health            { ok, sources }
//   GET /rss?src=<代號>    轉發該來源的 RSS 原文
//
// 白名單是**代號**不是網址：開放任意網址等於做了一台開放代理，
// 會被拿去打別人，也會讓這個 Worker 變成別人眼中的攻擊來源。

import { SOURCES, CACHE_SECONDS, UPSTREAM_TIMEOUT_MS } from './sources.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
};

/** 錯誤一律講清楚。回空的 RSS 冒充成功，前端會以為「今天沒新聞」。 */
function fail(status, message, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error: message, ...extra }, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, '只接受 GET');
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        sources: Object.entries(SOURCES).map(([id, s]) => ({ id, name: s.name, aiInput: s.aiInput })),
        cacheSeconds: CACHE_SECONDS,
      }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
      });
    }

    if (url.pathname !== '/rss') return fail(404, `沒有這個端點：${url.pathname}`);

    const src = url.searchParams.get('src');
    if (!src) return fail(400, '缺少 src 參數', { sources: Object.keys(SOURCES) });
    const source = Object.prototype.hasOwnProperty.call(SOURCES, src) ? SOURCES[src] : null;
    if (!source) {
      // 不是開放代理：沒在白名單裡就是 400，而且把允許的清單講出來。
      return fail(400, `不支援的來源：${src}`, { sources: Object.keys(SOURCES) });
    }

    // 快取鍵用「正規化過的自家網址」，不要用使用者送來的原始請求 ——
    // 多帶一個無關的查詢參數就會繞過快取，等於誰都能逼我們去打上游。
    const cacheKey = new Request(`${url.origin}/rss?src=${src}`, { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-sd-cache', 'hit');
      return new Response(hit.body, { status: hit.status, headers });
    }

    let upstream;
    try {
      upstream = await fetch(source.url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          // 一般閱讀器的 UA。ltn／yahoo 擋的是 AI 爬蟲的 UA，不是 RSS 訂閱本身。
          'user-agent': 'Mozilla/5.0 (compatible; StockDiaryRSS/1.0; +https://yolin0513.github.io/stockdiary/)',
          accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        },
      });
    } catch (e) {
      return fail(502, `上游沒有回應（${source.name}）：${e?.name === 'TimeoutError' ? `超過 ${UPSTREAM_TIMEOUT_MS} ms` : String(e)}`);
    }

    if (!upstream.ok) {
      // 上游壞掉不快取 —— 不然要等十分鐘才會再試一次。
      return fail(502, `上游回 ${upstream.status}（${source.name}）`);
    }

    const body = await upstream.arrayBuffer();
    const res = new Response(body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/xml; charset=utf-8',
        'cache-control': `public, max-age=${CACHE_SECONDS}`,
        'x-sd-source': src,
        'x-sd-cache': 'miss',
        ...CORS,
      },
    });
    await cache.put(cacheKey, res.clone());
    return res;
  },
};
