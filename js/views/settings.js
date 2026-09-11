// 設定頁。M0：字級、今日資料公布門檻、資料來源與限制說明。

import { h, toast, switchRow, timeSelect } from '../ui.js';
import * as prefs from '../prefs.js';
import * as catalog from '../catalog.js';
import * as store from '../store.js';
import { setTop, render } from '../shell.js';
import * as secrets from '../secrets.js';
import * as backup from '../backup.js';

export default async function settings() {
  setTop({ title: '設定' });
  const key = await secrets.status();

  // 走 render()（不要自己 mount #view）：那裡有「這個畫面是不是已經過期」的守門。
  render([
    fontSection(),
    dividendSection(),
    thresholdSection(),
    aiSection(key),
    backupSection(),
    dataSection(),
    aboutSection(),
  ]);
}

/**
 * AI 金鑰。
 *
 * 畫面上的三條硬規則：
 *   · 存進去之後只顯示遮罩，沒有「再看一次完整金鑰」這個功能
 *   · 清除本機金鑰**不等於**停用它 —— 必須寫出「要到 Anthropic 後台 Delete」
 *   · 用量是**估算**，真正的硬上限是後台的 Billing 上限，要講明白
 */
function aiSection(st) {
  return st.configured ? configuredCard(st) : setupCard(st);
}

function setupCard(st) {
  const input = h('input', {
    class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: secrets.KEY_PREFIX + '…', dataset: { field: 'apiKey' },
  });
  const msg = h('p', { class: 'muted sm' }, '');
  const saveBtn = h('button', { class: 'btn btn-primary' }, '驗證並儲存');

  const paste = h('button', { class: 'btn' }, '貼上');
  paste.addEventListener('click', async () => {
    try {
      input.value = (await navigator.clipboard.readText()).trim();
      msg.textContent = '已貼上，按「驗證並儲存」。';
    } catch {
      // 剪貼簿權限被拒不是錯誤，講清楚替代做法就好
      msg.textContent = '這個瀏覽器不讓程式讀剪貼簿，請直接長按欄位貼上。';
    }
  });

  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const fmt = secrets.checkFormat(input.value);
    if (!fmt.ok) { msg.textContent = fmt.error; return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '驗證中…';
    msg.textContent = '正在對 Anthropic 送一次最小呼叫，確認這把金鑰是活的…';
    const r = await secrets.testKey({ key: fmt.key });
    if (!r.ok) {
      saveBtn.disabled = false;
      saveBtn.textContent = '驗證並儲存';
      // r.error 已經 scrub 過（secrets.testKey 保證），這裡再過一次不會錯
      msg.textContent = secrets.scrub(`驗不過，沒有存下來：${r.error}`);
      return;
    }
    await secrets.save({ key: fmt.key });
    input.value = '';
    toast('金鑰已儲存在這台裝置上');
    await settings();
  });

  return h('section', { class: 'card', dataset: { card: 'aiKeySetup' } },
    h('h2', { class: 'card-title' }, 'AI 金鑰（選用）'),
    h('p', { class: 'muted sm' },
      '「今日觀察」需要你自己的 Anthropic 金鑰。費用由你直接付給 Anthropic，這個 App 不經手。'),
    h('p', { class: 'muted sm' },
      '金鑰只存在這台裝置的瀏覽器裡，不會上傳到任何伺服器，也不會出現在匯出的備份檔裡。'),
    h('div', { class: 'row-actions' }, input, paste),
    msg,
    saveBtn,
    h('p', { class: 'muted sm' }, '不填也可以用 —— 除了「今日觀察」之外的功能都不需要金鑰。'));
}

function configuredCard(st) {
  const model = h('div', { class: 'chip-row' }, ...secrets.MODELS.map((m) => {
    const chip = h('button', {
      class: 'chip' + (m.id === st.model ? ' on' : ''),
      dataset: { model: m.id },
    }, m.name);
    chip.addEventListener('click', async () => { await secrets.setModel(m.id); await settings(); });
    return chip;
  }));

  const clearBtn = h('button', { class: 'btn' }, '清除這台裝置上的金鑰');
  clearBtn.addEventListener('click', async () => {
    await secrets.clear();
    toast('已清除。記得到 Anthropic 後台 Delete 才是真的停用。');
    await settings();
  });

  const m = secrets.modelById(st.model);
  return h('section', { class: 'card', dataset: { card: 'aiKeyConfigured' } },
    h('h2', { class: 'card-title' }, 'AI 金鑰'),
    h('p', {}, `已設定：${st.masked}`),
    h('p', { class: 'muted sm' }, '基於安全，存進去之後就只顯示遮罩，沒有辦法再看一次完整金鑰。'),

    h('h3', { class: 'sub-title' }, '模型'),
    model,
    m ? h('p', { class: 'muted sm' }, `${m.name}：輸入 $${m.inRate}／輸出 $${m.outRate}（每百萬 token）。${m.note}`) : null,

    h('h3', { class: 'sub-title' }, '用量'),
    h('p', {}, `${st.month} 約 ${secrets.fmtUsd(st.usedMicroUsd)}`),
    h('p', { class: 'muted sm' }, `本機上限 ${secrets.fmtUsd(st.capMicroUsd)}，超過就停用「今日觀察」。`),
    st.overCap
      ? h('p', { class: 'warn' }, '已達本機上限，「今日觀察」暫停。下個月自動歸零，或調高上限。')
      : null,
    h('p', { class: 'muted sm' },
      '這是**估算**：用回應裡的 token 數乘上公開費率累加，可能與帳單有出入。'
      + '真正會擋下花費的是 Anthropic 後台的 Billing 上限，建議去那裡也設一個。'),

    h('h3', { class: 'sub-title' }, '清除'),
    clearBtn,
    h('p', { class: 'muted sm' },
      '清除只會刪掉這台裝置上的這一份。**這不等於停用這把金鑰** —— '
      + '要真的讓它失效，必須到 Anthropic 後台把這把 key 刪掉（Delete）。'));
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
  // 共用的切換開關（js/ui.js）。全 App 同一套 —— 以前這裡、定期定額、試算器
  // 各自寫了一份「膠囊按鈕上寫開啟／關閉」，三處長得一樣但都不像開關。
  return switchRow({
    key,
    label,
    hint,
    checked: prefs.get(key) === true,
    onChange: async (next) => { await prefs.set(key, next); await settings(); },
  });
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
  // 用時／分下拉，不用 <input type="time">：原生控制項在 iOS 會被拉滿整個卡片、
  // 文字置中，跟其他元件對不上（使用者實機回報「跑版」）。理由詳見 ui.timeSelect。
  const t = timeSelect({ value: prefs.get('todayDataThreshold'), minuteStep: 5 });
  return h('section', { class: 'card', dataset: { card: 'threshold' } },
    h('h2', { class: 'card-title' }, '今日資料公布門檻'),
    h('p', { class: 'muted sm' },
      '證交所每個交易日收盤後才會公布當天的收盤價。這個時間之前開 App，會顯示「今日收盤尚未公布」，不會拿昨天的數字冒充今天。'),
    t.node,
    h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const v = t.value;
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


/**
 * 備份：匯出／匯入。
 *
 * 畫面上要講清楚兩件事：
 *   · 備份檔**不含** API 金鑰（結構上讀不到，見 js/backup.js）
 *   · 匯入是**取代**不是合併，而且不可復原 —— 所以先要使用者打勾確認
 */
function backupSection() {
  const status = h('p', { class: 'muted sm' }, '');

  const exportBtn = h('button', { class: 'btn' }, '匯出備份檔');
  exportBtn.addEventListener('click', async () => {
    try {
      const payload = await backup.buildExport();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: backup.filenameFor() });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const total = Object.values(payload.counts).reduce((x, y) => x + y, 0);
      status.textContent = `已匯出 ${total} 筆（${Object.entries(payload.counts).map(([k, v]) => `${k} ${v}`).join('、')}）。`;
    } catch (e) {
      status.textContent = `匯出失敗：${e?.message || e}`;
    }
  });

  const confirm = h('input', { type: 'checkbox', dataset: { field: 'importConfirm' } });
  const file = h('input', { type: 'file', accept: 'application/json,.json', dataset: { field: 'importFile' } });
  const importBtn = h('button', { class: 'btn' }, '匯入並取代');

  importBtn.addEventListener('click', async () => {
    if (!confirm.checked) { status.textContent = '匯入會蓋掉現在的資料，要先打勾確認。'; return; }
    const f = file.files?.[0];
    if (!f) { status.textContent = '還沒有選擇檔案。'; return; }
    importBtn.disabled = true;
    try {
      const parsed = backup.parseBackup(await f.text());
      if (!parsed.ok) { status.textContent = `沒有匯入：${parsed.error}`; return; }
      const wrote = await backup.applyImport(parsed.data);
      const total = Object.values(wrote).reduce((x, y) => x + y, 0);
      const note = parsed.missing.length ? `（備份檔裡沒有 ${parsed.missing.join('、')}，那幾項現在是空的）` : '';
      toast(`已匯入 ${total} 筆${note}`);
      await store.update().catch(() => {});
      await settings();
    } catch (e) {
      status.textContent = `匯入失敗：${e?.message || e}`;
    } finally {
      importBtn.disabled = false;
    }
  });

  return h('section', { class: 'card', dataset: { card: 'backup' } },
    h('h2', { class: 'card-title' }, '備份'),
    h('p', { class: 'muted sm' },
      '匯出持股、異動紀錄、定期定額計畫、除權息事件與設定。'
      + '**備份檔不含 API 金鑰** —— 金鑰存在另一個地方，匯出的程式讀不到它。'),
    exportBtn,

    h('h3', { class: 'sub-title' }, '匯入'),
    h('p', { class: 'muted sm' },
      '匯入是**取代**：現在這台裝置上的持股、異動、計畫、除權息、設定會被備份檔的內容蓋掉，'
      + '不可復原。建議先匯出一份現在的資料再匯入。'),
    h('p', { class: 'muted sm' }, '匯入不會動到這台裝置上的 API 金鑰。'),
    file,
    h('label', { class: 'pref-row' }, confirm, h('span', {}, ' 我知道匯入會蓋掉現在的資料')),
    importBtn,
    status);
}
