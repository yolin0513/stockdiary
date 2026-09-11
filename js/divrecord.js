// 配息紀錄：**過去實際配發的事實**，不是未來的預測。
//
// 兩種來源，刻意分開、永遠不合併計算：
//
//   A. `data/dividends.json` —— 證交所公告的「股利分派情形」（t187ap45_L）
//      這是**公司宣布配多少**，全市場的事實。
//   B. 使用者自己的 `events` 紀錄 —— **他實際領到多少**
//      這是他自己的事實，比 A 更貼近他的實際情況（股數不同、有沒有參與除息都不同）。
//
// 為什麼不合併：兩者回答的是不同問題，單位也不同（A 是元/股，B 是他總共領到的元）。
// 加在一起會得到一個沒有意義、卻看起來很權威的數字。畫面上各自一個區塊、各自標來源。
//
// **這裡不做任何年化、不除以股價、不算平均。**
//   · 年化與除以股價都是「預期報酬」的語言
//   · 平均沒有意義：實測每檔中位數只有 1 筆紀錄，拿 1–3 筆算平均只會讓人誤以為
//     「大概就是這個數」
// 只做「過去 N 期合計實際配發 X 元」—— 加總是事實，平均是推論。

import { rocCompactToISO } from './roc.js';

let data = null;

export async function load(url = './data/dividends.json') {
  if (data) return data;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`讀不到配息資料（${res.status}）`);
  data = await res.json();
  return data;
}

export function isLoaded() { return data != null; }
export function __setDataForTest(j) { data = j; }

/** 資料的出表日期（ISO）。畫面一定要顯示這個 —— 使用者要看得出資料多舊。 */
export function reportDate() {
  const raw = data?.reportDate;
  if (!raw) return null;
  try { return rocCompactToISO(raw); } catch { return null; }
}

/**
 * 資料是不是可能已經過期了？
 *
 * 門檻用一季（92 天）：公司大多每季或每年公告一次，超過一季沒更新，
 * 很可能已經有新的決議沒收進來。**這不是「資料錯了」，是「可能不完整」** ——
 * 文案要照這個分寸寫。
 */
export const STALE_DAYS = 92;

export function staleness(now = new Date()) {
  const iso = reportDate();
  if (!iso) return { known: false, stale: false, days: null, iso: null };
  const days = Math.floor((now.getTime() - Date.parse(`${iso}T00:00:00`)) / 86400000);
  return { known: true, stale: days > STALE_DAYS, days, iso };
}

/**
 * 某一檔的公告配息紀錄。
 * 查不到就回 `{ found: false }` —— 不要回空陣列假裝「這檔沒配過息」，
 * 那兩件事完全不同（ETF 根本不在這份資料裡）。
 */
export function forCode(code) {
  const key = String(code ?? '').trim().toUpperCase();
  const list = data?.codes?.[key];
  if (!list) return { found: false, code: key, records: [] };
  return {
    found: true,
    code: key,
    records: list,
    // 合計：加總是事實。不年化、不除以股價、不算平均。
    totalCash: round8(list.reduce((a, r) => a + (r.cash ?? 0), 0)),
    totalStock: round8(list.reduce((a, r) => a + (r.stock ?? 0), 0)),
    periods: list.length,
  };
}

function round8(n) { return Math.round(n * 1e8) / 1e8; }

/**
 * 顯示用的每股金額。
 *
 * 來源有 7.00000137 這種浮點雜訊（總額除以股數來的），原樣顯示會很醜而且看起來
 * 像我們算錯了。取到小數第 4 位、去掉尾端的 0；真的配到小數第 4 位以上的公司
 * 也還看得見。**不要四捨五入到 2 位** —— 那會把 0.125 變成 0.13，是真的改了數字。
 */
export function fmtPerShare(n) {
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 1e4) / 1e4);
}

/**
 * 下一次除息（**已公告的預告**，來自 TWT48U 經 App 的 events）。
 *
 * 為什麼這一塊對 ETF 特別重要：證交所**沒有公開 ETF 的歷史收益分配**
 * （2026-09-11 實測，見 FEASIBILITY §11），所以「公司公告的股利分派」那份資料
 * 對 ETF 一筆都沒有。但 TWT48U 預告表**有 ETF** —— 下一次要配多少、哪天除息，
 * 是投信已經公告的事實。
 *
 * 界線（使用者確認過的三個條件）：
 *   · 金額未定就標「待公告」，**不猜**
 *   · **不拿它去除以股價**（那是殖利率）
 *   · **不年化**（「一年配四次所以一年配 X 元」就是推算未來，越界）
 */
export function upcomingFor(events, code, { now = new Date() } = {}) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const future = events
    .filter((e) => e.code === code && e.exDate >= today && e.status !== 'confirmed' && e.status !== 'dismissed')
    .sort((a, b) => String(a.exDate).localeCompare(String(b.exDate)));
  const next = future[0] ?? null;
  if (!next) return { found: false };
  return {
    found: true,
    exDate: next.exDate,
    // null 代表「還沒公告金額」，跟 0 完全不同 —— 畫面要分得開
    cashPerShare: Number.isFinite(next.cashPerShare) ? next.cashPerShare : null,
    stockRate: Number.isFinite(next.stockRate) && next.stockRate > 0 ? next.stockRate : null,
    kind: next.kind ?? null,
  };
}

/**
 * 使用者自己實際領到的（來自他的除權息紀錄）。
 *
 * 只算 `confirmed` 而且有金額的 —— 待確認的還不算數，沒填金額的算不出來但要講出來。
 * 回傳的是**微元**（跟 App 其他金額同一個刻度）。
 */
export function receivedFor(events, code) {
  const mine = events.filter((e) => e.code === code && e.status === 'confirmed');
  let totalMicro = 0n;
  let counted = 0;
  let unknown = 0;
  const rows = [];
  for (const e of mine) {
    const raw = e.amountActual ?? e.amountEst ?? null;
    if (raw == null) { unknown += 1; rows.push({ exDate: e.exDate, micro: null }); continue; }
    const micro = typeof raw === 'bigint' ? raw : BigInt(raw);
    totalMicro += micro;
    counted += 1;
    rows.push({ exDate: e.exDate, micro });
  }
  rows.sort((a, b) => String(b.exDate).localeCompare(String(a.exDate)));
  return { totalMicro: counted > 0 ? totalMicro : null, counted, unknown, rows };
}
