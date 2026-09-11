// TWSE 端點的解析器（純函式，不碰 DOM、不發請求 —— 才能用固定樣本測）。
//
// 這裡每一個「回 null 而不是回 0」的地方都是刻意的：
// 沒成交、沒公布、沒資料一律 null，讓上層有機會顯示「尚未取得」。
// 只要有一處把空值當 0，畫面上就會出現一個看起來很正常、其實是假的數字。

import { rocCompactToISO, rocSlashToISO } from './roc.js';

/** 把 "28,931,697" / " 0.00" / "+25.00" 轉成數字；空字串、"--"、非數字一律 null。 */
export function num(raw) {
  const t = String(raw ?? '').trim();
  if (t === '' || t === '--' || t === '---') return null;
  const cleaned = t.replace(/,/g, '').replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---------- STOCK_DAY_ALL（全市場當日收盤，實際回 CSV）----------

/**
 * 逐字元解析 CSV（欄位有引號、名稱裡可能有逗號／加減號）。
 * 標題列沒有引號，資料列每一欄都有引號 —— 但不要靠這個特性去切，
 * 一旦 TWSE 改格式就會整批錯位。
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const SDA_HEADER = ['日期', '證券代號', '證券名稱', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數'];

/**
 * 解析 rwd/zh/afterTrading/STOCK_DAY_ALL 的 CSV。
 * 回 { date, rows, untraded }：
 *   date     這份表的資料日期（ISO），取第一筆資料列
 *   rows     [{ code, name, close, change, open, high, low, shares, turnover, trades, traded }]
 *   untraded 當日沒有成交的檔數（價格欄是空字串）
 *
 * 沒成交的列，TWSE 的價格欄是空字串、漲跌價差卻寫 "0.0000"。
 * 那個 0 不是「沒漲沒跌」，是「沒有這個數字」—— close 與 change 都給 null。
 */
export function parseStockDayAll(csvText) {
  const rows = parseCsv(csvText);
  const out = [];
  let date = null;
  let untraded = 0;
  let headerSeen = false;

  for (const r of rows) {
    if (r.length < SDA_HEADER.length) continue;
    // 標題列只認第一欄「日期」——認得越多欄，欄位一對調就變成「找不到標題列」，
    // 錯誤訊息會指不出到底哪一欄變了。資料列的第一欄永遠是民國日期，不會誤判。
    if (!headerSeen && r[0].trim() === SDA_HEADER[0]) {
      // 確認欄位順序真的沒變；變了就整份拒收，不要硬解出錯位的數字
      for (let i = 0; i < SDA_HEADER.length; i += 1) {
        if (r[i].trim() !== SDA_HEADER[i]) {
          throw new Error(`STOCK_DAY_ALL 欄位與預期不同：第 ${i + 1} 欄是「${r[i].trim()}」，預期「${SDA_HEADER[i]}」`);
        }
      }
      headerSeen = true;
      continue;
    }
    const iso = rocCompactToISO(r[0]);
    if (!iso) continue;                       // 不是資料列
    if (!date) date = iso;

    const code = r[1].trim();
    const close = num(r[8]);
    const traded = close != null;
    if (!traded) untraded += 1;

    out.push({
      code,
      name: r[2].trim(),
      date: iso,
      open: num(r[5]),
      high: num(r[6]),
      low: num(r[7]),
      close,
      // 沒成交就沒有漲跌可言。傳 0 出去會在當日損益裡變成一筆「正常的持平」。
      change: traded ? num(r[9]) : null,
      shares: num(r[3]),
      turnover: num(r[4]),
      trades: num(r[10]),
      traded,
    });
  }

  if (!headerSeen) throw new Error('STOCK_DAY_ALL 找不到標題列');
  return { date, rows: out, untraded };
}

// ---------- STOCK_DAY（個股當月逐日）----------

const SD_FIELDS = ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數', '註記'];

/**
 * 解析 exchangeReport/STOCK_DAY 的 JSON。
 * 回 { ok, message, rows }，rows = [{ date, open, high, low, close, change, exMark, shares, turnover, trades, note }]
 *
 * 漲跌價差有四種樣態，實測（2330，115/06）：
 *   " 0.00"  持平
 *   "+25.00" 上漲
 *   "-50.00" 下跌
 *   "X0.00"  **除權息日**，TWSE 不計算漲跌 —— 這個 0 不是持平
 *
 * "X0.00" 解成 0 就是「除息日生出等於息值的假虧損」那個經典錯誤的上游。
 * 這裡 change 給 null、exMark 給 true，強迫上層去拿除權息參考價。
 */
export function parseStockDay(json) {
  const j = json || {};
  const stat = String(j.stat ?? '');
  if (stat !== 'OK') {
    return { ok: false, message: stat || '沒有回應內容', rows: [] };
  }
  const fields = Array.isArray(j.fields) ? j.fields.map((f) => String(f).trim()) : [];
  for (let i = 0; i < SD_FIELDS.length; i += 1) {
    if (fields[i] !== SD_FIELDS[i]) {
      throw new Error(`STOCK_DAY 欄位與預期不同：第 ${i + 1} 欄是「${fields[i] ?? '(缺)'}」，預期「${SD_FIELDS[i]}」`);
    }
  }

  const rows = [];
  for (const r of (Array.isArray(j.data) ? j.data : [])) {
    const iso = rocSlashToISO(r[0]);
    if (!iso) continue;
    const rawChange = String(r[7] ?? '');
    const exMark = /X/i.test(rawChange);
    const close = num(r[6]);
    rows.push({
      date: iso,
      open: num(r[3]),
      high: num(r[4]),
      low: num(r[5]),
      close,
      change: exMark || close == null ? null : num(rawChange),
      exMark,
      shares: num(r[1]),
      turnover: num(r[2]),
      trades: num(r[8]),
      note: String(r[9] ?? '').trim(),
    });
  }
  return { ok: true, message: '', rows };
}

/** 這份 STOCK_DAY 回應對應的股票代號（從 title 取，例："115年06月 2330 台積電  各日成交資訊"）。 */
export function stockNoOfStockDay(json) {
  const m = /^\s*\d{2,3}年\d{2}月\s+(\S+)\s/.exec(String(json?.title ?? ''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------

const FMTQIK_FIELDS = ['日期', '成交股數', '成交金額', '成交筆數', '發行量加權股價指數', '漲跌點數'];

/**
 * 解析 afterTrading/FMTQIK（整月的市場成交資訊）。
 * 回 { ok, message, rows }，rows = [{ date, index, changePoints, changePct }]
 *
 * 為什麼用這支而不是 MI_INDEX：
 *   · FMTQIK 的「漲跌點數」**自己帶正負號**（"-784.00"），一個數字就講完了。
 *     MI_INDEX 的點數是無號的，正負藏在 `<p style='color:green'>-</p>` 這段 HTML 裡 ——
 *     要靠顏色去判斷漲跌，上游改個樣式就整片反過來。
 *   · FMTQIK 一個請求回一整個月，回補不用再多打。
 *   · 兩邊實測對得起來：115/09/11 收 46,184.85、點數 -755.64，
 *     算出 -1.61%，與 MI_INDEX 自己給的漲跌百分比 -1.61 相同。
 *
 * changePct 是**算出來的**（點數 ÷ 前一日指數），不是上游給的，所以：
 *   · 前一日指數（index − changePoints）算出來是 0 或非有限數 → changePct 給 null
 *   · 拿不到 index 或 changePoints → 兩個都 null，不要用 0 代替
 */
export function parseFmtqik(json) {
  const j = json || {};
  const stat = String(j.stat ?? '');
  if (stat !== 'OK') {
    return { ok: false, message: stat || '沒有回應內容', rows: [] };
  }
  const fields = Array.isArray(j.fields) ? j.fields.map((f) => String(f).trim()) : [];
  for (let i = 0; i < FMTQIK_FIELDS.length; i += 1) {
    if (fields[i] !== FMTQIK_FIELDS[i]) {
      throw new Error(`FMTQIK 欄位與預期不同：第 ${i + 1} 欄是「${fields[i] ?? '(缺)'}」，預期「${FMTQIK_FIELDS[i]}」`);
    }
  }

  const rows = [];
  for (const r of (Array.isArray(j.data) ? j.data : [])) {
    const iso = rocSlashToISO(r[0]);
    if (!iso) continue;
    const index = num(r[4]);
    const changePoints = num(r[5]);
    let changePct = null;
    if (index != null && changePoints != null) {
      const prev = index - changePoints;
      if (Number.isFinite(prev) && prev !== 0) {
        changePct = Math.round((changePoints / prev) * 10000) / 100;
      }
    }
    rows.push({ date: iso, index, changePoints, changePct });
  }
  return { ok: true, message: '', rows };
}
