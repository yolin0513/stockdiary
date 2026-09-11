// 首頁。M0 只有空狀態與資料狀態列 —— 持股與當日損益在 M1 接上。

import { h, mount, fmtDate, NO_VALUE } from '../ui.js';
import * as store from '../store.js';
import { setTop } from '../app.js';

export default async function home() {
  setTop({ title: 'StockDiary 股息日記', back: false });

  const hold = await store.holdings();
  const lastSettled = await store.lastSettledDate();

  mount(document.getElementById('view'),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '當日損益'),
      // 還沒有持股、也還沒結算過 —— 這裡不能顯示 0，0 會被當成「今天沒賺沒賠」。
      h('p', { class: 'big-number muted' }, NO_VALUE),
      h('p', { class: 'muted sm' }, hold.length === 0 ? '還沒有持股' : '尚未結算'),
    ),
    dataStatus(lastSettled),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '持股'),
      hold.length === 0
        ? h('p', { class: 'muted' }, '還沒有持股。新增持股的功能在下一個版本。')
        : h('p', { class: 'muted' }, `${hold.length} 檔`),
    ),
  );
}

function dataStatus(lastSettled) {
  const cal = store.calendar();
  const calErr = store.calendarError();
  const catErr = store.catalogError();
  const expected = store.expectedSettleDate();
  const pending = store.isTodayPending();

  const lines = [];
  if (calErr) lines.push('開休市日尚未取得，無法判斷交易日');
  else if (!cal) lines.push('開休市日尚未取得');
  else if (expected == null) lines.push(`開休市日只涵蓋 ${cal.year} 年，今天不在範圍內`);
  else if (pending) lines.push(`今日收盤尚未公布（應公布的最新交易日：${fmtDate(expected)}）`);
  else lines.push(`最新應有收盤：${fmtDate(expected)}`);

  lines.push(lastSettled ? `最後結算：${fmtDate(lastSettled)}` : '尚未結算過');
  if (catErr) lines.push('代號表尚未取得');

  return h('section', { class: 'card status-card' },
    h('h2', { class: 'card-title' }, '資料狀態'),
    ...lines.map((t) => h('p', { class: 'muted sm' }, t)),
  );
}
