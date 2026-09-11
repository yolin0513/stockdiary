// 民國日期與西元日期的互換。
//
// TWSE 各端點的日期格式不只一種，這裡把它們全部收斂成 ISO 'YYYY-MM-DD'：
//   STOCK_DAY_ALL   "1150910"    民國年＋月＋日，無分隔（民國 99 年以前是 6 碼）
//   STOCK_DAY       "115/09/10"  民國年/月/日
//   TWT48U / TWT49U "115年09月10日" 或 "115/09/10"（各表不同，解析器各自處理）
//   查詢參數        "20260910"   西元 yyyymmdd
//
// 一律不做時區換算：TWSE 的日期就是台北當地日期，直接當字串處理，
// 不經過 Date 物件（經過 Date 就有機會被 UTC 差一天）。

const ROC_OFFSET = 1911;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** '1150910' / '990910' → '2026-09-10' / '2010-09-10'；格式不對回 null。 */
export function rocCompactToISO(s) {
  const t = String(s ?? '').trim();
  if (!/^\d{6,7}$/.test(t)) return null;
  const y = Number(t.slice(0, t.length - 4)) + ROC_OFFSET;
  const mm = t.slice(-4, -2);
  const dd = t.slice(-2);
  if (!validParts(y, mm, dd)) return null;
  return `${y}-${mm}-${dd}`;
}

/** '115/09/10' → '2026-09-10'；格式不對回 null。 */
export function rocSlashToISO(s) {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]) + ROC_OFFSET;
  const mm = pad2(Number(m[2]));
  const dd = pad2(Number(m[3]));
  if (!validParts(y, mm, dd)) return null;
  return `${y}-${mm}-${dd}`;
}

/** '115年09月10日' → '2026-09-10'；格式不對回 null。 */
export function rocCharsToISO(s) {
  const m = /^(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]) + ROC_OFFSET;
  const mm = pad2(Number(m[2]));
  const dd = pad2(Number(m[3]));
  if (!validParts(y, mm, dd)) return null;
  return `${y}-${mm}-${dd}`;
}

/** 三種民國格式都試一次，都不合就回 null。 */
export function anyRocToISO(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (t.includes('年')) return rocCharsToISO(t);
  if (t.includes('/')) return rocSlashToISO(t);
  return rocCompactToISO(t);
}

/** '2026-09-10' → '1150910'；不是合法 ISO 日期回 null。 */
export function isoToRocCompact(iso) {
  const p = splitISO(iso);
  return p ? `${p.y - ROC_OFFSET}${p.mm}${p.dd}` : null;
}

/** '2026-09-10' → '115/09/10'。 */
export function isoToRocSlash(iso) {
  const p = splitISO(iso);
  return p ? `${p.y - ROC_OFFSET}/${p.mm}/${p.dd}` : null;
}

/** '2026-09-10' → '20260910'（TWSE 查詢參數用）。 */
export function isoToYyyymmdd(iso) {
  const p = splitISO(iso);
  return p ? `${p.y}${p.mm}${p.dd}` : null;
}

/** Date 物件 → 當地時區的 'YYYY-MM-DD'（不經 toISOString，避免 UTC 差一天）。 */
export function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function splitISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (!validParts(y, m[2], m[3])) return null;
  return { y, mm: m[2], dd: m[3] };
}

// 不只檢查範圍，還要檢查這一天真的存在（2 月 30 日、11 月 31 日都要擋掉）。
function validParts(y, mm, dd) {
  const M = Number(mm);
  const D = Number(dd);
  if (!(y >= 1912 && y <= 2200)) return false;
  if (!(M >= 1 && M <= 12)) return false;
  if (!(D >= 1 && D <= 31)) return false;
  const d = new Date(Date.UTC(y, M - 1, D));
  return d.getUTCFullYear() === y && d.getUTCMonth() === M - 1 && d.getUTCDate() === D;
}
