// IndexedDB 底層封裝。
//
// store 的切分照 PLAN §3。最重要的一條規則寫在這裡而不是註解裡：
// `secrets` 是獨立 object store，而且 EXPORTABLE_STORES **不包含它** ——
// 匯出／備份的程式碼一律只走 EXPORTABLE_STORES，結構上就讀不到金鑰。

const DB_NAME = 'stockdiary';
const DB_VERSION = 1;

// 會被匯出的 store。改這一行等於改匯出範圍 —— secret-leak-test 會盯著它。
export const EXPORTABLE_STORES = ['holdings', 'changes', 'plans', 'events', 'settings'];

// 所有 store 的定義（keyPath 與索引）。
const STORES = {
  holdings: { keyPath: 'code', indexes: [] },
  changes: { keyPath: 'id', indexes: [['byCode', 'code'], ['byDate', 'date'], ['byStatus', 'status']] },
  plans: { keyPath: 'id', indexes: [['byCode', 'code']] },
  events: { keyPath: 'id', indexes: [['byCode', 'code'], ['byExDate', 'exDate'], ['byStatus', 'status']] },
  closes: { keyPath: ['code', 'date'], indexes: [['byCode', 'code']] },
  settle: { keyPath: 'date', indexes: [] },
  news: { keyPath: 'date', indexes: [] },
  insights: { keyPath: 'date', indexes: [] },
  secrets: { keyPath: 'provider', indexes: [] },
  settings: { keyPath: 'key', indexes: [] },
  // 抓過的 STOCK_DAY 當月檔快取（同檔同月只抓一次，見 PLAN §2.3）
  monthcache: { keyPath: ['code', 'month'], indexes: [] },
};

export const STORE_NAMES = Object.keys(STORES);

let _db = null;
let _opening = null;

function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const s = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idx, path] of def.indexes) s.createIndex(idx, path, { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 手機把 App 切到背景、分頁凍結、記憶體不足時，瀏覽器會主動關掉閒置連線。
      // 不讓下一次 tx() 知道要重開，就會拿著關閉中的連線開交易（InvalidStateError）。
      const invalidate = () => { if (_db === db) _db = null; };
      db.onversionchange = () => { try { db.close(); } catch { /* noop */ } invalidate(); };
      db.onclose = invalidate;
      _db = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => { /* 交給呼叫端重試 */ };
  });
}

export function openDB() {
  if (_db) return Promise.resolve(_db);
  if (!_opening) _opening = openOnce().finally(() => { _opening = null; });
  return _opening;
}

async function tx(store, mode = 'readonly') {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const db = await openDB();
    try {
      return db.transaction(store, mode).objectStore(store);
    } catch (e) {
      _db = null;
      if (attempt === 1) throw e;
    }
  }
  throw new Error('開不了交易');
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key) { return wrap((await tx(store)).get(key)); }
export async function getAll(store) { return wrap((await tx(store)).getAll()); }
export async function put(store, value) { return wrap((await tx(store, 'readwrite')).put(value)); }
export async function del(store, key) { return wrap((await tx(store, 'readwrite')).delete(key)); }
export async function clear(store) { return wrap((await tx(store, 'readwrite')).clear()); }
export async function count(store) { return wrap((await tx(store)).count()); }

export async function putAll(store, values) {
  const s = await tx(store, 'readwrite');
  await Promise.all(values.map((v) => wrap(s.put(v))));
}

export async function getByIndex(store, index, key) {
  const s = await tx(store);
  return wrap(s.index(index).getAll(key));
}
