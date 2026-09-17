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

/**
 * 代號表幾天算「可能過期」。
 *
 * 60 天：新上市與新 ETF 大約每一兩個月會有一批。超過這個天數還沒重跑 build-stocks，
 * 使用者想加的新代號就會查不到 —— 而畫面上只會說「找不到代號」，
 * 那句話會讓人以為自己打錯了。
 *
 * 這是 SPEC §4 B3 的決定：**不打 STOCK_DAY 試查**未在清單的代號
 * （那會多出一種「未在清單」的持股，每一個畫面都要處理它），
 * 改成過期時提醒更新 App。
 */
export const CATALOG_STALE_DAYS = 60;

/**
 * 代號表有多舊。比照 divrecord.staleness 的形狀。
 *
 * now 是參數而不是直接 new Date() —— 不然「59 天不提醒、61 天提醒」這種邊界
 * 要等兩個月才測得到。
 */
export function staleness(now = new Date()) {
  const iso = catalogDate();
  if (!iso) return { known: false, stale: false, days: null, iso: null };
  const days = Math.floor((now.getTime() - Date.parse(`${iso}T00:00:00`)) / 86400000);
  return { known: true, stale: days > CATALOG_STALE_DAYS, days, iso };
}

/** 過期時要對使用者說的那一句。沒過期回 null —— 不要回空字串讓呼叫端去判斷。 */
export function stalenessNote(now = new Date()) {
  const st = staleness(now);
  if (!st.known || !st.stale) return null;
  return `代號表是 ${st.iso} 產生的（距今 ${st.days} 天），可能已經有新上市的代號沒收進來，請更新 App。`;
}

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
