// 每日損益日曆：一個月一頁，左右切月，點一天看明細。
//
// 每一格的判斷都在 ../plcal.js（純函式，plcaltest 逐一驗）；這裡只負責畫。
// **只讀結算紀錄，不回推、不估算**；沒有紀錄的日子標「無資料」，算不出來的標「算不出」——兩種都不是 0。

import { h, num, moneyNode, fmtDate } from '../ui.js';
import * as store from '../store.js';
import { setTop, render } from '../shell.js';
import { localISODate } from '../roc.js';
import {
  CELL, CELL_TEXT, buildMonth, monthCoverage, firstRecordDate, shiftMonth, firstWeekday,
  compactMoney, signClass, uncomputableReason, cellText,
} from '../plcal.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export default async function plcalView(monthParam) {
  setTop({ title: '每日損益' });
  const today = localISODate();
  const thisMonth = today.slice(0, 7);
  const rows = await store.allSettleRows();
  const first = firstRecordDate(rows);
  const firstMonth = first ? first.slice(0, 7) : thisMonth;
  const ym = /^\d{4}-\d{2}$/.test(monthParam ?? '') && monthParam >= firstMonth && monthParam <= thisMonth
    ? monthParam : thisMonth;
  const calendar = store.calendar();
  const cells = buildMonth({ ym, rows, calendar, today });
  const cov = monthCoverage(cells, rows, ym);

  const detail = h('div', { class: 'plcal-detail', 'aria-live': 'polite', dataset: { field: 'plcalDetail' } },
    h('p', { class: 'muted sm' }, '點一天看明細'));
  const showDetail = (cell) => fillDetail(detail, cell);

  render([
    h('section', { class: 'card', dataset: { card: 'plcal' } },
      monthNav(ym, firstMonth, thisMonth),
      grid(cells, today, (cell) => showDetail(cell)),
      detail,
      h('p', { class: 'muted sm', dataset: { note: 'plcalStart' } },
        first
          ? `從 ${fmtDate(first)} 開始記錄（這支手機第一次結算的那天），更早的日子沒有資料。換手機或從備份還原後，會從那天重新開始記錄。`
          : '還沒有任何一天的結算紀錄。打開首頁更新一次之後，就會從那天開始記錄。'),
      // 母體檢查不過就講出來——不要默默畫一個少了幾天的月曆
      cov.ok ? null : h('p', { class: 'warn sm', dataset: { note: 'plcalCoverage' } },
        `這個月有 ${cov.source} 天的紀錄，卻只畫出 ${cov.shown} 天，請回報這個問題。`),
      legend(),
    ),
  ]);
}

function monthNav(ym, firstMonth, thisMonth) {
  const [y, m] = ym.split('-');
  const prev = shiftMonth(ym, -1);
  const next = shiftMonth(ym, 1);
  const link = (target, label, aria, enabled) => (enabled
    ? h('a', { class: 'btn plcal-nav', href: `#/pl-calendar?m=${target}`, 'aria-label': aria }, label)
    : h('span', { class: 'btn plcal-nav', 'aria-disabled': 'true', 'aria-label': aria }, label));
  return h('div', { class: 'plcal-head' },
    link(prev, '‹', '上個月', prev >= firstMonth),
    h('h2', { class: 'card-title plcal-title', dataset: { field: 'plcalMonth' } }, `${y} 年 ${Number(m)} 月`),
    link(next, '›', '下個月', next <= thisMonth),
  );
}

function grid(cells, today, onPick) {
  const lead = firstWeekday(cells[0].date.slice(0, 7));
  const heads = WEEKDAYS.map((w) => h('div', { class: 'plcal-wd' }, w));
  const blanks = Array.from({ length: lead }, () => h('div', { class: 'plcal-blank', 'aria-hidden': 'true' }));
  const days = cells.map((c) => {
    const isToday = c.date === today;
    const text = cellText(c);
    const props = {
      class: `plcal-cell plcal-${c.state}${isToday ? ' plcal-today' : ''}`,
      dataset: { date: c.date, state: c.state },
      'aria-label': `${fmtDate(c.date)} ${c.state === CELL.VALUE ? `當日損益 ${compactMoney(c.dayPL)} 元` : CELL_TEXT[c.state] || '尚未到'}`,
    };
    if (isToday) props['aria-current'] = 'date';
    const body = [
      h('span', { class: 'plcal-day' }, String(c.day)),
      text ? h('span', { class: `plcal-v ${c.state === CELL.VALUE ? signClass(c.dayPL) : 'v-none'}` }, text) : null,
    ];
    if (c.state === CELL.FUTURE) return h('div', props, ...body);
    const btn = h('button', { ...props, type: 'button' }, ...body);
    btn.addEventListener('click', () => onPick(c));
    return btn;
  });
  return h('div', { class: 'plcal-grid', role: 'grid' }, ...heads, ...blanks, ...days);
}

function fillDetail(node, c) {
  const lines = [h('p', { class: 'plcal-detail-date' }, fmtDate(c.date))];
  if (c.state === CELL.VALUE) {
    lines.push(h('p', { class: 'mid-number' }, moneyNode(BigInt(c.dayPL))));
    const r = c.row;
    const ex = [];
    if (r?.excludedUnsupported) ex.push(`${r.excludedUnsupported} 檔不支援報價`);
    if (r?.excludedMissing) ex.push(`${r.excludedMissing} 檔缺收盤價`);
    lines.push(h('p', { class: 'muted sm' }, `算進 ${r?.counted ?? 0} 檔${ex.length ? `；未計入：${ex.join('、')}` : ''}`));
  } else if (c.state === CELL.UNCOMPUTABLE) {
    lines.push(h('p', {}, num('算不出', 'v-none')), h('p', { class: 'muted sm' }, `這天有結算，但沒有算得出來的持股：${uncomputableReason(c.row)}`));
  } else if (c.state === CELL.NO_DATA) {
    lines.push(h('p', {}, num('無資料', 'v-none')), h('p', { class: 'muted sm' }, '這天沒有結算紀錄（還沒開始在這支手機記錄）。不是 0。'));
  } else if (c.state === CELL.PENDING) {
    lines.push(h('p', {}, num('未結算', 'v-none')), h('p', { class: 'muted sm' }, '收盤公布後打開首頁更新，就會補上這一天。'));
  } else if (c.state === CELL.CLOSED) {
    lines.push(h('p', {}, num('休市', 'v-none')), h('p', { class: 'muted sm' }, c.closedName ?? '休市'));
  } else if (c.state === CELL.UNCOVERED) {
    lines.push(h('p', {}, num('日曆未涵蓋', 'v-none')), h('p', { class: 'muted sm' }, '開休市日還沒涵蓋這一年，分不出這天是不是交易日。更新 App 之後就會有。'));
  }
  node.replaceChildren(...lines);
}

function legend() {
  return h('p', { class: 'muted sm plcal-legend' },
    '紅＝賺、綠＝賠；「算不出」＝那天有結算但價格不齊，「無資料」＝那天沒有紀錄，兩種都不是 0。');
}
