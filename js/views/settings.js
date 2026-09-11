// 設定頁。M0：字級、今日資料公布門檻、資料來源與限制說明。

import { h, mount, toast } from '../ui.js';
import * as prefs from '../prefs.js';
import * as catalog from '../catalog.js';
import * as store from '../store.js';
import { setTop } from '../app.js';

export default async function settings() {
  setTop({ title: '設定' });

  mount(document.getElementById('view'),
    fontSection(),
    thresholdSection(),
    dataSection(),
    aboutSection(),
  );
}

function fontSection() {
  const cur = prefs.get('fontScale');
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '字級'),
    h('div', { class: 'chip-row' },
      ...Object.entries(prefs.FONT_SCALE_LABELS).map(([k, label]) =>
        h('button', {
          class: 'chip' + (k === cur ? ' on' : ''),
          onclick: async () => { await prefs.set('fontScale', k); prefs.applyFontScale(k); settings(); },
        }, label)
      )
    ),
  );
}

function thresholdSection() {
  const input = h('input', { class: 'field', type: 'time', value: prefs.get('todayDataThreshold') });
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '今日資料公布門檻'),
    h('p', { class: 'muted sm' },
      '證交所每個交易日收盤後才會公布當天的收盤價。這個時間之前開 App，會顯示「今日收盤尚未公布」，不會拿昨天的數字冒充今天。'),
    input,
    h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const v = input.value;
        if (!/^\d{2}:\d{2}$/.test(v)) { toast('時間格式不對'); return; }
        await prefs.set('todayDataThreshold', v);
        toast(`已改為 ${v}`);
      },
    }, '儲存'),
  );
}

function dataSection() {
  const catDate = catalog.catalogDate();
  const cal = store.calendar();
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '資料來源'),
    h('p', { class: 'muted sm' }, `代號表：${catDate ? `${catDate} 產生` : '尚未取得'}`),
    h('p', { class: 'muted sm' }, `開休市日：${cal?.year ? `${cal.year} 年，${cal.days.length} 個交易日` : '尚未取得'}`),
    h('p', { class: 'muted sm' }, '收盤價來自臺灣證券交易所（www.twse.com.tw），只在開啟 App 時抓一次，沒有盤中即時報價。'),
  );
}

function aboutSection() {
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '關於'),
    h('p', { class: 'muted sm' }, '這個版本只支援上市股票。上櫃與興櫃代號可以記錄股數，但不會顯示價格與損益。'),
    h('p', { class: 'muted sm' }, '所有資料只存在這台裝置上，沒有帳號、沒有雲端。換手機請用匯出／匯入。'),
    h('p', { class: 'muted sm' }, '本 App 不提供投資建議，不顯示目標價，也不做任何買賣提示。'),
  );
}
