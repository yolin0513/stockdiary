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
    dividendSection(),
    thresholdSection(),
    dataSection(),
    aboutSection(),
  );
}

/** 除權息相關的兩個開關（PLAN §1：含應收股利預設開、自動扣費預設關）。 */
function dividendSection() {
  return h('section', { class: 'card', dataset: { card: 'dividendSettings' } },
    h('h2', { class: 'card-title' }, '股利'),
    toggleRow({
      key: 'dayPLIncludeDividend',
      label: '當日損益含當日除息的應收股利',
      hint: '除息當天股價會扣掉息值，如果不把應收股利加回來，那天的當日損益看起來就像平白虧了一筆。',
    }),
    toggleRow({
      key: 'dividendAutoFees',
      label: '自動扣匯費與補充保費',
      hint: '開啟後，確認股利時會預填「扣匯費 10 元；單筆達 20,000 元再扣 2.11% 二代健保補充保費」。' +
        '各家券商與股務代理的作法不同，預設關閉；不管開或關，確認時都可以直接改成實際入帳金額。',
    }),
  );
}

function toggleRow({ key, label, hint }) {
  const on = prefs.get(key) === true;
  const btn = h('button', {
    class: 'chip' + (on ? ' on' : ''),
    role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    dataset: { pref: key },
    onclick: async () => { await prefs.set(key, !on); settings(); },
  }, on ? '開啟' : '關閉');
  return h('div', { class: 'pref-row' },
    h('div', { class: 'pref-main' },
      h('p', { class: 'pref-label' }, label),
      h('p', { class: 'muted sm' }, hint),
    ),
    btn,
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
