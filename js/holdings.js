// 持股與持股變動。
//
// 核心不變式：**holdings.shares 永遠等於該代號所有「已確認」變動的 deltaShares 總和。**
// 沒有任何地方可以直接改 shares —— 要改股數就是新增一筆變動。
// 這樣才能事後回推「那一天我手上有幾股」，除權息與缺漏日的損益才補得回來。
// （PLAN 附錄 A：「只存目前股數一個數字」被否決，因為不可逆。）

import * as db from './db.js';
import * as catalog from './catalog.js';
import { localISODate } from './roc.js';

export const KINDS = ['opening', 'manual', 'dca', 'dividendReinvest', 'stockDividend'];
export const STATUSES = ['pending', 'confirmed'];

// ---------- 純函式（可以在 Node 裡直接測）----------

/** 已確認變動的股數總和。未確認的不算 —— 使用者還沒對過券商通知。 */
export function sharesFromChanges(changes) {
  let total = 0;
  for (const c of changes) {
    if (c.status !== 'confirmed') continue;
    total += Number(c.deltaShares) || 0;
  }
  return total;
}

/** 某一天收盤時的股數（含當天生效的變動）。回補缺漏日要用。 */
export function sharesOn(changes, date) {
  let total = 0;
  for (const c of changes) {
    if (c.status !== 'confirmed') continue;
    if (c.date > date) continue;
    total += Number(c.deltaShares) || 0;
  }
  return total;
}

/** 待確認的變動（依日期排序）。 */
export function pendingOf(changes) {
  return changes.filter((c) => c.status === 'pending').sort((a, b) => a.date.localeCompare(b.date));
}

/** 新增一筆變動之前的檢查。回錯誤字串，沒問題回 null。 */
export function validateChange({ code, date, deltaShares, kind, status }) {
  if (!code) return '沒有代號';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return '日期格式不對';
  if (!Number.isFinite(Number(deltaShares)) || Number(deltaShares) === 0) return '股數要是不為零的數字';
  if (!Number.isInteger(Number(deltaShares))) return '股數要是整數';
  if (!KINDS.includes(kind)) return `不認得的變動類型「${kind}」`;
  if (!STATUSES.includes(status)) return `不認得的狀態「${status}」`;
  return null;
}

/** 新增持股之前的檢查（回 { error } 或 { info }）。 */
export function checkCode(code) {
  const key = String(code ?? '').trim().toUpperCase();
  if (!key) return { error: '請輸入股票代號' };
  if (!catalog.isLoaded()) return { error: '代號表尚未取得，請連上網路後再試' };
  const info = catalog.lookup(key);
  if (!info.found) {
    const d = catalog.catalogDate();
    return { error: `找不到代號 ${key}${d ? `（代號表產生於 ${d}）` : ''}`, notFound: true, code: key };
  }
  return { info };
}

// ---------- 讀取 ----------

/** 所有持股，補上代號表的名稱／市場／產業／是否支援報價。 */
export async function list() {
  const rows = await db.getAll('holdings');
  return rows
    .map((h) => {
      const info = catalog.lookup(h.code);
      return {
        ...h,
        name: info.found ? info.name : h.name,
        market: info.found ? info.market : h.market,
        industry: info.found ? info.industry : null,
        // 代號表查不到的（例如使用者用「試著查一次」加進來的）一律當成不支援，
        // 寧可少顯示一個數字，也不要顯示一個來源不明的數字。
        supported: info.found ? info.supported : false,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function changesOf(code) {
  const rows = await db.getByIndex('changes', 'byCode', code);
  return rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
}

export async function allChanges() {
  return db.getAll('changes');
}

export async function allPending() {
  return pendingOf(await db.getAll('changes'));
}

// ---------- 寫入 ----------

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把 holdings.shares 重算成「已確認變動的總和」。唯一會寫 shares 的地方。 */
export async function recomputeShares(code) {
  const changes = await changesOf(code);
  const shares = sharesFromChanges(changes);
  const existing = await db.get('holdings', code);
  if (!existing) return shares;
  if (shares === 0 && changes.length === 0) {
    await db.del('holdings', code);
    return 0;
  }
  await db.put('holdings', { ...existing, shares });
  return shares;
}

/**
 * 快速設定持股：建立持股 ＋ 一筆 opening 變動。
 * 已經有這一檔就丟錯 —— 要加碼請用 addChange，不要覆蓋掉既有的變動紀錄。
 */
export async function addOpening({ code, shares, avgCost = null, date = localISODate(), note = '' }) {
  const checked = checkCode(code);
  if (checked.error) throw new Error(checked.error);
  const info = checked.info;

  if (await db.get('holdings', info.code)) {
    throw new Error(`${info.code} ${info.name} 已經在持股裡了`);
  }
  const err = validateChange({ code: info.code, date, deltaShares: shares, kind: 'opening', status: 'confirmed' });
  if (err) throw new Error(err);
  if (Number(shares) < 0) throw new Error('起始股數不能是負的');

  await db.put('holdings', {
    code: info.code,
    name: info.name,
    market: info.market,
    supported: info.supported,
    shares: 0,
    avgCost: avgCost == null || avgCost === '' ? null : Number(avgCost),
    costNote: null,
  });
  await db.put('changes', {
    id: newId(),
    code: info.code,
    date,
    deltaShares: Number(shares),
    price: null,
    kind: 'opening',
    note: note || '快速設定持股',
    status: 'confirmed',
  });
  await recomputeShares(info.code);
  return info.code;
}

/** 新增一筆持股變動（買進為正、賣出為負）。 */
export async function addChange({ code, date = localISODate(), deltaShares, price = null, kind = 'manual', note = '', status = 'confirmed' }) {
  const key = String(code).trim().toUpperCase();
  const err = validateChange({ code: key, date, deltaShares, kind, status });
  if (err) throw new Error(err);
  if (!await db.get('holdings', key)) throw new Error(`${key} 不在持股裡`);

  const current = sharesFromChanges(await changesOf(key));
  if (status === 'confirmed' && current + Number(deltaShares) < 0) {
    throw new Error(`賣出 ${Math.abs(deltaShares)} 股會讓庫存變成負的（目前 ${current} 股）`);
  }

  const id = newId();
  await db.put('changes', {
    id, code: key, date, deltaShares: Number(deltaShares),
    price: price == null || price === '' ? null : Number(price),
    kind, note, status,
  });
  await recomputeShares(key);
  return id;
}

/** 確認一筆待確認的變動，可同時改成券商實際的股數與成交價。 */
export async function confirmChange(id, { deltaShares, price } = {}) {
  const row = await db.get('changes', id);
  if (!row) throw new Error('找不到這筆變動');
  const next = {
    ...row,
    deltaShares: deltaShares == null ? row.deltaShares : Number(deltaShares),
    price: price == null ? row.price : Number(price),
    status: 'confirmed',
  };
  const err = validateChange(next);
  if (err) throw new Error(err);
  await db.put('changes', next);
  await recomputeShares(row.code);
  return next;
}

export async function deleteChange(id) {
  const row = await db.get('changes', id);
  if (!row) return;
  await db.del('changes', id);
  await recomputeShares(row.code);
}

export async function setAvgCost(code, avgCost) {
  const h = await db.get('holdings', code);
  if (!h) throw new Error(`${code} 不在持股裡`);
  const v = avgCost == null || avgCost === '' ? null : Number(avgCost);
  if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error('平均成本要是不小於零的數字');
  await db.put('holdings', { ...h, avgCost: v });
}

/** 刪掉一檔持股與它所有的變動紀錄。 */
export async function removeHolding(code) {
  for (const c of await changesOf(code)) await db.del('changes', c.id);
  await db.del('holdings', code);
}
