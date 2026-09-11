// 代號表（data/stocks.json）。
//
// 這個 App 只支援**上市**。上櫃／興櫃代號要明確講「不支援、不會顯示價格」，
// 而不是靜默地顯示一個空的或錯的數字 —— TWSE 的 STOCK_DAY 對上櫃代號和
// 不存在的代號回一模一樣的錯誤訊息，分不出來，所以只能靠這張表。

let data = null;
let loading = null;

export async function load(url = './data/stocks.json') {
  if (data) return data;
  if (!loading) {
    loading = fetch(url, { signal: AbortSignal.timeout(15000) })
      .then((r) => {
        if (!r.ok) throw new Error(`stocks.json HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { data = j; return j; })
      .finally(() => { loading = null; });
  }
  return loading;
}

export function isLoaded() { return data != null; }
export function generatedAt() { return data?.generatedAt ?? null; }
export function industries() { return data?.industries ?? {}; }

/** 這張表是哪一天產的（畫面上「找不到代號」時要一起說出來）。 */
export function catalogDate() {
  const t = data?.generatedAt;
  return t ? String(t).slice(0, 10) : null;
}

/**
 * 查一個代號。回：
 *   { found: false }                         代號表裡沒有
 *   { found: true, supported: true,  ... }   上市，可以抓價
 *   { found: true, supported: false, ... }   上櫃／興櫃，不支援報價
 */
export function lookup(code) {
  const key = String(code ?? '').trim().toUpperCase();
  if (!data || !key) return { found: false, code: key };
  const s = data.stocks?.[key];
  if (!s) return { found: false, code: key };
  return {
    found: true,
    code: key,
    name: s.name,
    market: s.market,
    industry: s.industry ?? null,
    type: s.type ?? null,
    supported: s.market === '上市',
  };
}

/** 代號長得像不像台股代號（4–6 碼數字或數字加英文）。 */
export function looksLikeCode(code) {
  return /^[0-9]{4}[0-9A-Z]{0,2}$/.test(String(code ?? '').trim().toUpperCase());
}

/** 給不支援的代號用的固定文案。絕不在同一句裡出現任何價格。 */
export function unsupportedMessage(info) {
  if (!info?.found) return '找不到這個代號';
  return `${info.code} ${info.name} 是${info.market}股票，這個版本只支援上市，不會顯示價格與損益`;
}

/** 前綴／名稱搜尋，給代號輸入框用。最多回 limit 筆。 */
export function search(term, limit = 20) {
  const t = String(term ?? '').trim().toUpperCase();
  if (!t || !data) return [];
  const out = [];
  for (const [code, s] of Object.entries(data.stocks)) {
    if (code.startsWith(t) || s.name.includes(term)) {
      out.push({ code, name: s.name, market: s.market, industry: s.industry ?? null, supported: s.market === '上市' });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 只給測試用：直接塞一份代號表，免得每個測試都要起 HTTP 伺服器。 */
export function __setDataForTest(j) { data = j; }
