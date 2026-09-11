// 除權息：TWT48U（預告表）與 TWT49U（計算結果表）的解析，以及股利金額的計算。
// 純函式，不碰 DB、不發請求。
//
// 兩張表用途完全不同，欄位也不一樣，各寫一個解析器（STATUS「最容易做錯的事」第 4 條）：
//
//   TWT48U 除權除息**預告**表 —— 未來約七週要除權息的公司。日曆用這張。
//          給的是「每股現金股利」與「無償配股率」，**沒有參考價**（那時候還不知道前收）。
//
//   TWT49U 除權除息**計算結果**表 —— 已經發生的。除息當天的參考價用這張。
//          給的是「除權息前收盤價」「除權息參考價」「權值+息值」。
//
// ⚠ 實測（2026-09-11）：**TWT49U 的 strDate／endDate 參數沒有作用**。
//   分別要求 115/06、115/08、115/09 初三個區間，回的都是同一份「最新一次」的結果
//   （title 固定是「115年09月10日 至 115年09月11日」）。
//   所以參考價只能在除權息當天（或隔一天）開 App 時抓到並存起來，
//   事後回補的除權息日拿不到參考價 —— 那時候 settle.js 會標 exNoRef，不會硬算。

import { anyRocToISO } from './roc.js';
import { toMicro, toNano, mulSharesPrecise, sharesTimesRate, MICRO, NANO } from './money.js';

/** 去掉 HTML 標記、取出純文字。TWSE 會在數字欄位裡塞 <p>…</p>。 */
export function textOf(raw) {
  return String(raw ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/**
 * 把 "1,234.5" 轉成數字。**不是數字就回 null，絕不回 0。**
 *
 * 這一條是實測踩出來的：金額還沒公告時，TWSE 在「現金股利」欄位放的不是空字串，
 * 而是一段 HTML：
 *   "<p style= text-align:center;>待公告實際收益分配金額</p>"
 * （2026-09-11 那 72 筆裡有 35 筆這樣，多半是主動式 ETF），
 * 「現金增資認購價」欄位則可能是「尚未公告」。
 *
 * 把它們當成 0，日曆上就會出現「每股 0 元、預估 0 元」——
 * 那不是「不配息」，是「還不知道配多少」。
 */
function n(raw) {
  const t = textOf(raw).replace(/,/g, '');
  if (t === '' || t === '--') return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** TWSE 的「權/息」欄位 → 我們的 kind。 */
export function kindOf(raw) {
  const t = String(raw ?? '').trim();
  if (t === '息') return 'cash';
  if (t === '權') return 'stock';
  if (t === '權息' || t === '息權') return 'both';
  return null;
}

export const KIND_LABEL = { cash: '除息', stock: '除權', both: '除權息' };

// ---------- TWT48U：除權除息預告表 ----------

const TWT48U_FIELDS = ['除權除息日期', '股票代號', '名稱', '除權息', '無償配股率', '現金增資配股率', '現金增資認購價', '現金股利'];

/**
 * 回 { ok, message, rows }，rows =
 *   [{ exDate, code, name, kind, cashPerShare, stockRate, rightsRate, rightsPrice }]
 *
 * stockRate 是「每股配幾股」（實測 0.04999999 ＝ 每仟股配 50 股）。
 * rightsRate／rightsPrice 是現金增資 —— **不自動處理**，只拿來提示使用者去對券商通知。
 */
export function parseTwt48u(json) {
  const j = json || {};
  if (String(j.stat ?? '') !== 'OK') {
    return { ok: false, message: String(j.stat ?? '沒有回應內容'), rows: [] };
  }
  const fields = Array.isArray(j.fields) ? j.fields.map((f) => String(f).trim()) : [];
  for (let i = 0; i < TWT48U_FIELDS.length; i += 1) {
    if (fields[i] !== TWT48U_FIELDS[i]) {
      throw new Error(`TWT48U 欄位與預期不同：第 ${i + 1} 欄是「${fields[i] ?? '(缺)'}」，預期「${TWT48U_FIELDS[i]}」`);
    }
  }

  const rows = [];
  for (const r of (Array.isArray(j.data) ? j.data : [])) {
    const exDate = anyRocToISO(r[0]);
    const kind = kindOf(r[3]);
    if (!exDate || !kind) continue;
    const cashPerShare = n(r[7]);
    rows.push({
      exDate,
      code: String(r[1] ?? '').trim(),
      name: String(r[2] ?? '').trim(),
      kind,
      // null ＝ 還沒公告。**不要退成 0。**
      cashPerShare,
      cashNote: cashPerShare == null ? (textOf(r[7]) || '尚未公告') : null,
      stockRate: n(r[4]),
      rightsRate: n(r[5]),
      rightsPrice: n(r[6]),
    });
  }
  return { ok: true, message: '', rows };
}

// ---------- TWT49U：除權除息計算結果表 ----------

const TWT49U_FIELDS = ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息'];

/**
 * 回 { ok, message, rows }，rows =
 *   [{ date, code, name, prevClose, refPrice, exValue, kind, openBase }]
 */
export function parseTwt49u(json) {
  const j = json || {};
  if (String(j.stat ?? '') !== 'OK') {
    return { ok: false, message: String(j.stat ?? '沒有回應內容'), rows: [] };
  }
  const fields = Array.isArray(j.fields) ? j.fields.map((f) => String(f).trim()) : [];
  for (let i = 0; i < TWT49U_FIELDS.length; i += 1) {
    if (fields[i] !== TWT49U_FIELDS[i]) {
      throw new Error(`TWT49U 欄位與預期不同：第 ${i + 1} 欄是「${fields[i] ?? '(缺)'}」，預期「${TWT49U_FIELDS[i]}」`);
    }
  }

  const rows = [];
  for (const r of (Array.isArray(j.data) ? j.data : [])) {
    const date = anyRocToISO(r[0]);
    if (!date) continue;
    rows.push({
      date,
      code: String(r[1] ?? '').trim(),
      name: String(r[2] ?? '').trim(),
      prevClose: n(r[3]),
      refPrice: n(r[4]),
      exValue: n(r[5]),
      kind: kindOf(r[6]),
      openBase: n(r[9]),
    });
  }
  return { ok: true, message: '', rows };
}

/**
 * 除權息參考價 ＝ 除權息前收盤價 − (權值+息值)，**捨去**到小數兩位。
 *
 * 這不是我們發明的公式：拿 2026-09-10 那六筆（息 4、權 1、權息 1）驗證，
 * 六筆都跟證交所公布的參考價一模一樣（見 scripts/dividendtest.mjs）。
 * 只有在 TWT49U 已經給了「權值+息值」時才用得到 —— 它是核對用的，
 * 不是拿來在沒有資料時湊一個數字出來。
 */
export function refPriceFromExValue({ prevClose, exValue }) {
  if (prevClose == null || exValue == null) return null;
  const micro = toMicro(prevClose) - toMicro(exValue);
  if (micro == null) return null;
  // 捨去到小數兩位（不是四捨五入）
  const unit = MICRO / 100n;
  const floored = micro >= 0n ? (micro / unit) * unit : -(((-micro) + unit - 1n) / unit) * unit;
  return Number(floored) / 1e6;
}

// ---------- 股利金額 ----------

export const WIRE_FEE = 10;          // 匯費，每筆
export const NHI_RATE_BP = 211n;     // 二代健保補充保費 2.11%
export const NHI_THRESHOLD = 20000;  // 單筆達這個金額才扣

/**
 * 現金股利金額。
 *
 * autoFees 關閉（**預設**）時：金額就是「股數 × 每股配息」，一毛都不扣。
 * autoFees 開啟時：扣匯費 10 元；單筆達 20,000 元再扣 2.11% 補充保費。
 *
 * 不管開關如何，使用者確認時都可以直接改成券商實際入帳的金額 —— 這幾條規則
 * 只是預填值，真正算數的是對帳單。
 */
export function dividendAmount({ shares, cashPerShare, autoFees = false }) {
  if (shares == null || cashPerShare == null) {
    return { grossMicro: null, wireFeeMicro: 0n, nhiFeeMicro: 0n, netMicro: null };
  }
  // 每股配息可能有八位小數（實測 0.80047700），先用奈刻度乘再收斂成微元
  const grossMicro = mulSharesPrecise(shares, cashPerShare);
  if (!autoFees) {
    return { grossMicro, wireFeeMicro: 0n, nhiFeeMicro: 0n, netMicro: grossMicro };
  }
  const wireFeeMicro = toMicro(WIRE_FEE);
  const nhiFeeMicro = grossMicro >= toMicro(NHI_THRESHOLD)
    ? roundToYuanMicro((grossMicro * NHI_RATE_BP) / 10000n)
    : 0n;
  return { grossMicro, wireFeeMicro, nhiFeeMicro, netMicro: grossMicro - wireFeeMicro - nhiFeeMicro };
}

/** 四捨五入到元（回微元）。 */
function roundToYuanMicro(micro) {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const rem = abs % MICRO;
  let out = abs - rem;
  if (rem * 2n >= MICRO) out += MICRO;
  return neg ? -out : out;
}

/**
 * 股票股利（配股）。
 * stockRate 是「每股配幾股」。不足一股的部分以現金找零，這裡只回報餘數，不估金額
 * （找零金額依各公司公告，通常按面額，但不保證）。
 */
export function stockDividendShares({ shares, stockRate }) {
  if (shares == null || stockRate == null) return { wholeShares: null, fractionShares: null, perThousand: null };
  // 配股率有到小數第八位。用微元算的話 0.04999999 會被進位成 0.05，
  // 1000 股就從「49 股 ＋ 餘 0.99999 股」變成「50 股」—— 多給一股，餘數也不見了。
  const { whole, fraction } = sharesTimesRate(shares, stockRate);
  return {
    wholeShares: whole,
    fractionShares: fraction,
    perThousand: stockRate * 1000,
  };
}

// ---------- 已領股利的匯總 ----------

/**
 * 已確認事件的股利匯總。**只算 status === 'confirmed' 的**。
 * 金額取 amountActual（使用者改過的實收金額），沒有才用 amountEst。
 * 兩者都沒有 → 那筆不算，並計入 unknown，讓畫面說得出「有 N 筆還沒有金額」。
 */
export function dividendSummary(events, { year = null } = {}) {
  let totalMicro = 0n;
  const byYear = new Map();
  const byCode = new Map();
  let counted = 0;
  let unknown = 0;

  for (const e of events) {
    if (e.status !== 'confirmed') continue;
    const raw = e.amountActual ?? e.amountEst ?? null;
    if (raw == null) { unknown += 1; continue; }
    const micro = typeof raw === 'bigint' ? raw : BigInt(raw);
    totalMicro += micro;
    counted += 1;
    const y = String(e.exDate).slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0n) + micro);
    byCode.set(e.code, (byCode.get(e.code) ?? 0n) + micro);
  }

  return {
    totalMicro: counted > 0 ? totalMicro : null,
    yearMicro: year == null ? null : (byYear.get(String(year)) ?? null),
    byYear: [...byYear].sort((a, b) => b[0].localeCompare(a[0])),
    byCode: [...byCode].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)),
    counted,
    unknown,
  };
}

/**
 * 依證交所公式，從**預告表的資料**推算除權息參考價：
 *
 *   參考價 = (前收 − 現金股利 + 現金增資配股率 × 認購價) ÷ (1 + 無償配股率 + 現金增資配股率)
 *
 * 捨去到小數兩位。全程整數運算（奈刻度 BigInt）——浮點數在這裡會咬人：
 * 4.6 − 1.9 在 double 上可能是 2.6999999999999997，乘 100 捨去就變成 2.69 而不是 2.70。
 *
 * ⚠ **這個函式目前沒有被 App 呼叫。**
 *
 * 它存在的目的是驗證：`scripts/dividendtest.mjs` 拿 `scripts/fixtures/refprice-pairs.json`
 * 的配對樣本（同一檔同時出現在 TWT48U 預告表與 TWT49U 結果表）核對它算出來的數字
 * 跟證交所公布的參考價一不一樣。
 *
 * 要不要把它接成「拿不到 TWT49U 時的備援」是另一個決定（見 docs/STATUS.md 的待辦）：
 * 那會讓畫面上出現一個不是證交所直接給的數字，必須標示「依證交所公式試算」。
 * 在那個決定做出來之前，回補到的除權息日維持標 exNoRef，不算。
 */
export function refPriceFromForecast({ prevClose, cashPerShare, stockRate, rightsRate, rightsPrice }) {
  // null 代表「還沒公告」，**不是 0**。當成 0 的話，
  // 一檔配息金額未定的股票會算出一個「完全沒扣息」的參考價 —— 那比不算還糟。
  if (prevClose == null || cashPerShare == null || stockRate == null || rightsRate == null) return null;
  // 認購價只有在真的有現金增資時才需要；沒有增資時它常常是「尚未公告」。
  if (rightsRate > 0 && rightsPrice == null) return null;

  const prev = toNano(prevClose);
  const cash = toNano(cashPerShare);
  const sRate = toNano(stockRate);
  const rRate = toNano(rightsRate);
  const rPrice = toNano(rightsRate > 0 ? rightsPrice : 0);
  if (prev == null || cash == null || sRate == null || rRate == null || rPrice == null) return null;

  // 現金增資的認購款（奈 × 奈 → 奈，四捨五入）
  const rightsCash = divRound(rRate * rPrice, NANO);
  const numerator = prev - cash + rightsCash;          // 奈元
  const denominator = NANO + sRate + rRate;            // 奈（無單位）
  if (denominator <= 0n) return null;
  if (numerator < 0n) return null;

  // 捨去到小數兩位：先放大 100 倍再整數除（BigInt 除法對正數就是捨去）
  const hundredths = (numerator * 100n) / denominator;
  return Number(hundredths) / 100;
}

function divRound(a, b) {
  const neg = (a < 0n) !== (b < 0n);
  const A = a < 0n ? -a : a;
  const B = b < 0n ? -b : b;
  const q = A / B;
  const r = A % B;
  const out = r * 2n >= B ? q + 1n : q;
  return neg ? -out : out;
}
