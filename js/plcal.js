// 每日損益日曆的純邏輯（畫面在 views/plcal.js）。
//
// **只讀已經存下來的結算紀錄（settle store），不回推、不估算。**
// 回推等於在凍結區（settle.js）之外再做一套損益計算，兩邊可能對不上；
// 當時缺價的日子照樣算不出來。所以每一格的數字都有來源：就是那一天結算時寫下的那一筆，
// 跟那一天首頁顯示的當日損益是同一筆。
//
// 每一格只會是下面其中一種狀態。**沒有一種會顯示 0 或留白讓人誤以為那天損益是 0**：
//   value         那天有結算、算得出來 → 顯示那筆當日損益
//   uncomputable  那天有結算，但一檔都算不出來（dayPL 是 null）→「算不出」，點開看原因
//   noData        交易日，但沒有結算紀錄（還沒開始用、或那天之前還沒在這支手機記錄）→「無資料」
//   pending       交易日、在最後一筆結算之後、今天或更早 → 「未結算」（打開 App 更新就會補上）
//   closed        休市（週末、國定假日、只辦交割日）→「休市」；名稱取自 data/calendar.json
//   uncovered     開休市日沒涵蓋這一天（data/calendar.json 只到某一年）→「日曆未涵蓋」，不猜它是不是交易日
//   future        今天以後 → 只顯示日期
// 「有紀錄」一律優先：只要那一天有一筆結算，就照那一筆顯示，不管日曆怎麼說。

import { covers } from './market.js';

export const CELL = Object.freeze({
  VALUE: 'value',
  UNCOMPUTABLE: 'uncomputable',
  NO_DATA: 'noData',
  PENDING: 'pending',
  CLOSED: 'closed',
  UNCOVERED: 'uncovered',
  FUTURE: 'future',
});

/** 每一種狀態在格子裡的字（value 顯示金額，future 不顯示字）。 */
export const CELL_TEXT = Object.freeze({
  uncomputable: '算不出',
  noData: '無資料',
  pending: '未結算',
  closed: '休市',
  uncovered: '未涵蓋',
  future: '',
});

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' 這個月有幾天（閏年二月是 29）。 */
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 前一個月／下一個月（跨年要進位）。 */
export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** 這個月第一天是星期幾（0＝週日）。 */
export function firstWeekday(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

/**
 * 算出一個月每一天的格子。
 *
 * ym        'YYYY-MM'
 * rows      settle store 的紀錄（整張表或至少這個月的；只看 date 與 dayPL）
 * calendar  market.makeCalendar() 的結果
 * today     'YYYY-MM-DD'（本地日期）
 * 回傳 [{ date, day, state, dayPL(字串或 null), row, closedName }]，依日期排好、一天一格。
 */
export function buildMonth({ ym, rows, calendar, today }) {
  const byDate = new Map((rows ?? []).map((r) => [r.date, r]));
  const recorded = [...byDate.keys()].sort();
  const lastRecorded = recorded.at(-1) ?? null;
  const closedName = new Map((calendar?.closed ?? []).map((c) => [c.date, c.name]));
  const cells = [];
  const n = daysInMonth(ym);
  for (let d = 1; d <= n; d += 1) {
    const date = `${ym}-${pad2(d)}`;
    const row = byDate.get(date) ?? null;
    let state;
    if (row) state = row.dayPL == null ? CELL.UNCOMPUTABLE : CELL.VALUE;
    else if (date > today) state = CELL.FUTURE;
    else if (!covers(calendar, date)) state = CELL.UNCOVERED;
    else if (!calendar.set.has(date)) state = CELL.CLOSED;
    else if (lastRecorded != null && date > lastRecorded) state = CELL.PENDING;
    else state = CELL.NO_DATA;
    cells.push({
      date,
      day: d,
      state,
      dayPL: row?.dayPL ?? null,
      row,
      closedName: state === CELL.CLOSED ? (closedName.get(date) ?? weekendName(date)) : null,
    });
  }
  return cells;
}

function weekendName(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd === 0 ? '週日' : wd === 6 ? '週六' : '休市';
}

/**
 * 母體檢查：這個月畫出來「有資料」（value 或 uncomputable）的天數，必須等於資料來源這個月實際有的紀錄數。
 * 不相等就是有天數被漏畫或多畫。回 { shown, source, ok }。
 */
export function monthCoverage(cells, rows, ym) {
  const shown = cells.filter((c) => c.state === CELL.VALUE || c.state === CELL.UNCOMPUTABLE).length;
  const source = (rows ?? []).filter((r) => typeof r.date === 'string' && r.date.slice(0, 7) === ym).length;
  return { shown, source, ok: shown === source };
}

/** 最早一筆結算的日期（歷史的起點）；沒有紀錄回 null。 */
export function firstRecordDate(rows) {
  return (rows ?? []).map((r) => r.date).filter(Boolean).sort()[0] ?? null;
}

/**
 * 格子裡放得下的金額寫法（完整金額在點開的明細裡）。
 * 萬元以上寫成「+1.2萬」，以下寫整數元；正數帶 +。0 就寫 0（那是真的算出來的 0，不是沒資料）。
 * dayPL 是結算紀錄裡的字串（微元）。
 */
export function compactMoney(dayPL) {
  if (dayPL == null) return null;
  const yuan = Number(BigInt(dayPL)) / 1e6;
  const sign = yuan > 0 ? '+' : yuan < 0 ? '-' : '';
  const abs = Math.abs(yuan);
  if (abs >= 10000) {
    const wan = Math.round(abs / 1000) / 10;
    return `${sign}${wan.toFixed(1)}萬`;
  }
  return `${sign}${Math.round(abs).toLocaleString('zh-Hant-TW')}`;
}

/** 格子裡顯示的字：有數字的顯示金額，其餘顯示狀態字（future 是空字串，只顯示日期）。畫面與測試共用這一個。 */
export function cellText(cell) {
  return cell.state === CELL.VALUE ? compactMoney(cell.dayPL) : CELL_TEXT[cell.state];
}

/** 金額的正負 → 顏色 class（跟首頁的 moneyNode 一樣：v-up 紅、v-down 綠、v-flat 不上色）。 */
export function signClass(dayPL) {
  if (dayPL == null) return 'v-none';
  const v = BigInt(dayPL);
  return v > 0n ? 'v-up' : v < 0n ? 'v-down' : 'v-flat';
}

/**
 * 「算不出」的原因，寫成一句話（點開明細時顯示）。依結算紀錄裡記下的排除數與每一檔的狀態。
 */
export function uncomputableReason(row) {
  if (!row) return null;
  const parts = [];
  const byCode = row.byCode ?? [];
  const exNoRef = byCode.filter((r) => r.status === 'exNoRef').map((r) => r.code);
  if (exNoRef.length) parts.push(`${exNoRef.join('、')} 這天除權息，參考價查不到也算不出來`);
  if (row.excludedMissing) parts.push(`${row.excludedMissing} 檔沒有取得收盤價`);
  if (row.excludedUnsupported) parts.push(`${row.excludedUnsupported} 檔不支援報價`);
  return parts.length ? parts.join('；') : '這天的持股都沒有算得出來的價格';
}
