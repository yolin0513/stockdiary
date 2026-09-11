var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// sources.mjs
var SOURCES = {
  cna: {
    name: "\u4E2D\u592E\u793E\u8CA1\u7D93",
    url: "https://feeds.feedburner.com/rsscna/finance",
    aiInput: true
  },
  cnyes: {
    name: "\u9245\u4EA8\u7DB2\u53F0\u80A1",
    url: "https://news.cnyes.com/rss/v1/news/category/tw_stock",
    aiInput: true
  },
  ltn: {
    name: "\u81EA\u7531\u8CA1\u7D93",
    url: "https://news.ltn.com.tw/rss/business.xml",
    aiInput: false
  },
  yahoo: {
    name: "Yahoo \u80A1\u5E02",
    url: "https://tw.stock.yahoo.com/rss?category=tw-market",
    aiInput: false
  }
};
var CACHE_SECONDS = 600;
var UPSTREAM_TIMEOUT_MS = 8e3;

// worker.mjs
var CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-max-age": "86400"
};
function fail(status, message, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error: message, ...extra }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS }
  });
}
__name(fail, "fail");
var worker_default = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(405, "\u53EA\u63A5\u53D7 GET");
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        sources: Object.entries(SOURCES).map(([id, s]) => ({ id, name: s.name, aiInput: s.aiInput })),
        cacheSeconds: CACHE_SECONDS
      }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS }
      });
    }
    if (url.pathname !== "/rss") return fail(404, `\u6C92\u6709\u9019\u500B\u7AEF\u9EDE\uFF1A${url.pathname}`);
    const src = url.searchParams.get("src");
    if (!src) return fail(400, "\u7F3A\u5C11 src \u53C3\u6578", { sources: Object.keys(SOURCES) });
    const source = Object.prototype.hasOwnProperty.call(SOURCES, src) ? SOURCES[src] : null;
    if (!source) {
      return fail(400, `\u4E0D\u652F\u63F4\u7684\u4F86\u6E90\uFF1A${src}`, { sources: Object.keys(SOURCES) });
    }
    const cacheKey = new Request(`${url.origin}/rss?src=${src}`, { method: "GET" });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-sd-cache", "hit");
      return new Response(hit.body, { status: hit.status, headers });
    }
    let upstream;
    try {
      upstream = await fetch(source.url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          // 一般閱讀器的 UA。ltn／yahoo 擋的是 AI 爬蟲的 UA，不是 RSS 訂閱本身。
          "user-agent": "Mozilla/5.0 (compatible; StockDiaryRSS/1.0; +https://yolin0513.github.io/stockdiary/)",
          accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        }
      });
    } catch (e) {
      return fail(502, `\u4E0A\u6E38\u6C92\u6709\u56DE\u61C9\uFF08${source.name}\uFF09\uFF1A${e?.name === "TimeoutError" ? `\u8D85\u904E ${UPSTREAM_TIMEOUT_MS} ms` : String(e)}`);
    }
    if (!upstream.ok) {
      return fail(502, `\u4E0A\u6E38\u56DE ${upstream.status}\uFF08${source.name}\uFF09`);
    }
    const body = await upstream.arrayBuffer();
    const res = new Response(body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/xml; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
        "x-sd-source": src,
        "x-sd-cache": "miss",
        ...CORS
      }
    });
    await cache.put(cacheKey, res.clone());
    return res;
  }
};

// ../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-eix3US/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-eix3US/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
