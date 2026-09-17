// 新聞：抓、存、標記「跟我的持股有關」。
//
// 邊界（PLAN §7.1，也是法務上的分寸）：
//   · **只存標題、連結、來源、時間。** 不抓文章頁、不存摘要、不重製全文。
//     解析器（js/rss.js）結構上就不取 description，不是「取了再刪」。
//   · 點擊一律開原站。
//   · 保留 14 天，過期清掉。
//
// `aiInput` 決定這個來源的標題可不可以進 AI 的 prompt，依據是各家 robots 的宣告，
// 不是我們自己的判斷。**未明示允許的來源，連標題都不進 prompt** —— 照常顯示、
// 照常可以點，只是不餵模型。這條由 forAI() 一個出口把關。

import * as db from './db.js';
import { parseFeed } from './rss.js';
import { localISODate } from './roc.js';

const WORKER = 'https://stockdiary-news.yolin0513.workers.dev';

/**
 * 六個來源。國內四家沒有 ACAO 標頭，經 Worker 轉發；國際兩家有，瀏覽器直打。
 * aiInput 與 workers/sources.mjs 一致（那邊是轉發白名單，這邊是顯示與 AI 用）。
 */
export const SOURCES = [
  { id: 'cna', name: '中央社財經', via: 'worker', region: 'tw', aiInput: true },
  { id: 'cnyes', name: '鉅亨網台股', via: 'worker', region: 'tw', aiInput: true },
  { id: 'ltn', name: '自由財經', via: 'worker', region: 'tw', aiInput: false },
  { id: 'yahoo', name: 'Yahoo 股市', via: 'worker', region: 'tw', aiInput: false },
  { id: 'cnbc', name: 'CNBC', via: 'direct', region: 'intl', aiInput: true,
    url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { id: 'marketwatch', name: 'MarketWatch', via: 'direct', region: 'intl', aiInput: true,
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
];

export const KEEP_DAYS = 14;
const REFETCH_MS = 30 * 60 * 1000; // 同一來源 30 分鐘內不重抓（PLAN §3）
const TIMEOUT_MS = 8000;

export function sourceById(id) { return SOURCES.find((s) => s.id === id) ?? null; }

export function urlOf(source) {
  return source.via === 'worker' ? `${WORKER}/rss?src=${source.id}` : source.url;
}

/**
 * 一則新聞的識別碼：連結的短雜湊。
 *
 * 用連結而不是流水號，因為同一則會在多次抓取、甚至多個來源之間重複出現，
 * 流水號會讓同一則變成好幾筆。這不是密碼學用途，碰撞了頂多少一則。
 */
export function newsId(link) {
  let h = 2166136261;
  for (let i = 0; i < link.length; i += 1) {
    h ^= link.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'n' + (h >>> 0).toString(36);
}

/** 抓一個來源並解析。失敗回 `{ok:false, error}` —— 不要用空陣列冒充「今天沒新聞」。 */
export async function fetchSource(source, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(urlOf(source), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `${source.name} 回 ${res.status}` };
    const xml = await res.text();
    const items = parseFeed(xml).map((it) => ({
      id: newsId(it.link),
      title: it.title,
      link: it.link,
      source: source.id,
      publishedAt: it.publishedAt,
    }));
    if (items.length === 0) return { ok: false, error: `${source.name} 解析不出任何一則` };
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: `${source.name} 連不上：${e?.name === 'TimeoutError' ? '逾時' : String(e?.message || e)}` };
  }
}

/** 同一天的清單：後來抓到的覆蓋先前同 id 的，其餘照發布時間新到舊。 */
export function mergeItems(oldItems, newItems) {
  const byId = new Map();
  for (const it of [...(oldItems ?? []), ...(newItems ?? [])]) byId.set(it.id, it);
  return [...byId.values()].sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    if (a.publishedAt) return -1;   // 有時間的排前面
    if (b.publishedAt) return 1;
    return a.title.localeCompare(b.title);
  });
}

/** 超過保留天數的那幾天，整筆刪掉。 */
export async function prune({ now = new Date(), keepDays = KEEP_DAYS } = {}) {
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  const cutoffDate = localISODate(cutoff);
  const all = await db.getAll('news');
  const stale = all.filter((r) => r.date < cutoffDate);
  for (const r of stale) await db.del('news', r.date);
  return stale.map((r) => r.date);
}

/**
 * 抓所有來源、併進今天這筆、清掉過期的。
 * 回傳每個來源的結果，失敗的也列出來 —— 畫面要講得出「哪一家沒抓到」。
 */
export async function refresh({ now = new Date(), force = false, fetchImpl = fetch } = {}) {
  const date = localISODate(now);
  const record = (await db.get('news', date)) ?? { date, items: [], fetchedAt: {} };
  // **六個來源同時抓**，不是一個等一個。
  //
  // 循序的時候最壞會是 6 × 8 秒逾時 ＝ 48 秒 —— 使用者按下「看新聞」之後
  // 盯著一片空白將近一分鐘，而且第一家掛掉就會拖垮後面全部。
  // 並行之後最壞就是單一來源的逾時（8 秒）。
  //
  // ⚠ **合併順序不能跟著「誰先回來」跑。** 用 allSettled 之後回應的先後是隨機的，
  // 照那個順序合併的話，同一批新聞每次開啟的排序都不一樣 —— 看起來像資料在跳。
  // 所以下面先等全部結束，再**照 SOURCES 的固定順序**合併。
  const settled = await Promise.allSettled(SOURCES.map(async (source) => {
    const last = record.fetchedAt?.[source.id];
    const fresh = last && now.getTime() - Date.parse(last) < REFETCH_MS;
    if (fresh && !force) {
      return { source: source.id, ok: true, skipped: true, reason: '30 分鐘內抓過了' };
    }
    const r = await fetchSource(source, { fetchImpl });
    return r.ok
      ? { source: source.id, ok: true, count: r.items.length, items: r.items }
      : { source: source.id, ok: false, error: r.error };
  }));

  // 照 SOURCES 的順序收，不是照回來的順序
  const results = [];
  for (let i = 0; i < SOURCES.length; i += 1) {
    const source = SOURCES[i];
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      // fetchSource 自己會把錯誤包成 { ok: false }，所以走到這裡代表它自己爆了。
      // 一家爆掉不能讓整批沒有結果 —— 這正是並行要守住的事。
      results.push({ source: source.id, ok: false, error: String(outcome.reason?.message ?? outcome.reason) });
      continue;
    }
    const r = outcome.value;
    if (r.ok && !r.skipped) {
      record.items = mergeItems(record.items, r.items);
      record.fetchedAt = { ...record.fetchedAt, [source.id]: now.toISOString() };
    }
    const { items, ...rest } = r;
    results.push(rest);
  }

  await db.put('news', record);
  const pruned = await prune({ now });
  return { date, total: record.items.length, results, pruned };
}

export async function forDate(date) {
  const r = await db.get('news', date);
  return r?.items ?? [];
}

/**
 * 可以餵給模型的那些。**唯一的出口** —— 產生 prompt 的程式只能拿這個函式的結果。
 * 未明示允許 AI 輸入的來源（robots 沒說可以），連標題都不給。
 */
export function forAI(items) {
  const allowed = new Set(SOURCES.filter((s) => s.aiInput).map((s) => s.id));
  return items.filter((it) => allowed.has(it.source));
}

/**
 * 「跟我的持股有關」標記。
 *
 * 三種命中方式：代號（2330）、公司名（台積電，含去掉「股份有限公司」等尾綴的簡稱）、
 * 產業關鍵字。命中就把持股代號記在 relatedCodes 裡。
 *
 * 刻意保守：寧可少標也不要亂標。標錯一則，使用者就會對整個標記失去信任。
 */
export function markRelated(items, holdings) {
  const rules = holdings.map((h) => ({
    code: h.code,
    needles: [h.code, ...nameNeedles(h.name), ...(h.industry ? [h.industry] : [])].filter(Boolean),
  }));
  return items.map((it) => {
    const hit = new Set();
    for (const r of rules) {
      if (r.needles.some((n) => it.title.includes(n))) hit.add(r.code);
    }
    return hit.size ? { ...it, relatedCodes: [...hit] } : it;
  });
}

/** 公司名可用來比對的幾種寫法。太短的（少於兩個字）不用，會亂命中。 */
export function nameNeedles(name) {
  if (!name) return [];
  const base = String(name).trim();
  const trimmed = base
    .replace(/股份有限公司|有限公司|控股公司|公司$/g, '')
    .replace(/-KY$|－KY$/i, '')
    .trim();
  return [...new Set([base, trimmed])].filter((n) => n.length >= 2);
}
