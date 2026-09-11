// 匯出／匯入備份檔。
//
// 最重要的一條寫在最前面：**匯出只走 `db.EXPORTABLE_STORES`。**
// 那份清單裡沒有 `secrets`，所以備份檔結構上不可能夾帶 API 金鑰 ——
// 不是「記得排除」，是根本讀不到（見 js/db.js 與 secret-leak-test）。
//
// 匯入是**取代**，不是合併。理由：`changes` 這種「一筆一筆的異動紀錄」合併起來
// 語意不明（同一天同一檔的兩筆到底是重複還是真的兩筆？），猜錯會讓股數默默算錯。
// 取代很粗暴但可預測，而且畫面會先要使用者確認。
//
// 匯入**永遠不碰 `secrets`**：換手機還原備份之後，這台裝置上原本的金鑰不受影響。

import * as db from './db.js';
import { APP_VERSION } from './version.js';

export const FORMAT = 'stockdiary-backup';
export const FORMAT_VERSION = 1;

/** 備份檔內容。只包含 EXPORTABLE_STORES。 */
export async function buildExport({ now = new Date() } = {}) {
  const data = {};
  const counts = {};
  for (const store of db.EXPORTABLE_STORES) {
    const rows = await db.getAll(store);
    data[store] = rows;
    counts[store] = rows.length;
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: now.toISOString(),
    counts,
    data,
  };
}

/** 檔名帶日期，使用者一眼看得出是哪天的備份。 */
export function filenameFor(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `stockdiary-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/**
 * 檢查一份檔案能不能匯入。
 *
 * 每一種拒絕都要講得出**為什麼**與**看到了什麼** —— 使用者匯入失敗時，
 * 「格式錯誤」這四個字幫不了他任何忙。
 */
export function validateImport(parsed) {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '這不是一個備份檔（最外層不是物件）' };
  }
  if (parsed.format !== FORMAT) {
    return {
      ok: false,
      error: parsed.format
        ? `這是「${String(parsed.format).slice(0, 40)}」的檔案，不是 StockDiary 的備份`
        : '這個檔案沒有註明格式，不像 StockDiary 的備份',
    };
  }
  if (!Number.isInteger(parsed.formatVersion)) {
    return { ok: false, error: '備份檔沒有版本號' };
  }
  if (parsed.formatVersion > FORMAT_VERSION) {
    return {
      ok: false,
      error: `這份備份是較新版本（格式 v${parsed.formatVersion}）做的，這個版本的 App 看不懂。請先更新 App。`,
    };
  }
  if (parsed.data == null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { ok: false, error: '備份檔裡沒有 data' };
  }

  // 認不得的 store 一律拒絕。**這是擋下「夾帶 secrets 的檔案」的地方** ——
  // 就算它寫了 secrets，也不會有任何程式去讀它，但拒絕比忽略誠實。
  const known = new Set(db.EXPORTABLE_STORES);
  const unknown = Object.keys(parsed.data).filter((k) => !known.has(k));
  if (unknown.length) {
    return { ok: false, error: `備份檔裡有這個版本不認得的資料：${unknown.join('、')}` };
  }

  const notArray = Object.entries(parsed.data).filter(([, v]) => !Array.isArray(v)).map(([k]) => k);
  if (notArray.length) {
    return { ok: false, error: `這幾項的內容不是清單：${notArray.join('、')}` };
  }

  // 缺的 store 當成空的，但要講出來 —— 匯入之後那部分會是空的，使用者要先知道。
  const missing = db.EXPORTABLE_STORES.filter((s) => !(s in parsed.data));
  const counts = Object.fromEntries(db.EXPORTABLE_STORES.map((s) => [s, parsed.data[s]?.length ?? 0]));
  return { ok: true, data: parsed.data, missing, counts, appVersion: parsed.appVersion ?? null, exportedAt: parsed.exportedAt ?? null };
}

/** 解析文字並檢查。JSON 壞掉也要講清楚是壞在哪。 */
export function parseBackup(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: `檔案不是有效的 JSON：${e.message}` }; }
  return validateImport(parsed);
}

/**
 * 真的寫進去。**取代**語意：先清空再寫。
 * 只碰 EXPORTABLE_STORES —— `secrets` 與 `news`／`insights`／價格快取都不動。
 */
export async function applyImport(data) {
  const wrote = {};
  for (const store of db.EXPORTABLE_STORES) {
    const rows = Array.isArray(data[store]) ? data[store] : [];
    await db.clear(store);
    for (const row of rows) await db.put(store, row);
    wrote[store] = rows.length;
  }
  return wrote;
}
