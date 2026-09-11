// 轉發來源的白名單與幾個常數。
//
// 單獨一個檔案的理由很具體：workerd 會把 worker.mjs 的**每一個具名匯出**當成
// 額外的進入點，匯出一個常數就會啟動失敗（"Incorrect type for map entry"）。
// 但測試又必須讀到同一份清單 —— 手抄一份就會漂移，而且漂了測不出來。

/**
 * 可以轉發的來源。每一條都在 FEASIBILITY §6 實測過（回應則數、robots 政策）。
 *
 * `aiInput` 記的是「這個來源的標題可不可以餵給 AI」——
 * 依各家 robots 的宣告，不是我們自己的判斷：
 *   · cna   robots 明示 `Content-signal: ai-input=yes` —— 最乾淨的主力
 *   · cnyes robots `User-agent: * Allow: /`，未對 AI 表態
 *   · ltn / yahoo 擋 AI 爬蟲的 UA（那是針對抓取頁面，RSS 本身開放），未明示允許 AI 輸入
 * 前端要拿標題去產生「今日觀察」時，只能用 aiInput 為 true 的來源。
 * （udn／經濟日報 robots 明文禁止 LLM 用途，所以整個不接，連轉發都沒有。）
 */
export const SOURCES = {
  cna: {
    name: '中央社財經',
    url: 'https://feeds.feedburner.com/rsscna/finance',
    aiInput: true,
  },
  cnyes: {
    name: '鉅亨網台股',
    url: 'https://news.cnyes.com/rss/v1/news/category/tw_stock',
    aiInput: true,
  },
  ltn: {
    name: '自由財經',
    url: 'https://news.ltn.com.tw/rss/business.xml',
    aiInput: false,
  },
  yahoo: {
    name: 'Yahoo 股市',
    url: 'https://tw.stock.yahoo.com/rss?category=tw-market',
    aiInput: false,
  },
};

export const CACHE_SECONDS = 600; // 10 分鐘（PLAN §3）
export const UPSTREAM_TIMEOUT_MS = 8000;

