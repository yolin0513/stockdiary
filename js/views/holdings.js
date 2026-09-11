// 持股管理：新增、平均成本、進單檔詳情。
//
// 新增流程照 PLAN §2.4：
//   上市     → 直接加
//   上櫃／興櫃 → 明講不支援，問要不要「仍然記錄股數（不計損益）」
//   查不到   → 講清楚代號表的日期，不要只說「錯誤」

import { h, num, fmtShares, fmtPrice, fmtMoneyMicro, toast, modal, confirmDialog } from '../ui.js';
import * as holdings from '../holdings.js';
import * as catalog from '../catalog.js';
import * as store from '../store.js';
import { STATUS_TEXT } from '../settle.js';
import { setTop, render } from '../shell.js';
import { localISODate } from '../roc.js';
import * as concentration from '../concentration.js';

export default async function holdingsView() {
  setTop({ title: '持股' });
  const held = await holdings.list();

  // 集中度用最後一次結算的收盤價算，跟首頁的未實現損益同一個來源。
  const settled = await store.latestSettle();
  const quotes = {};
  for (const row of settled?.byCode ?? []) if (row.close != null) quotes[row.code] = { close: row.close };
  const withIndustry = held.map((hd) => ({ ...hd, industry: catalog.lookup(hd.code)?.industry ?? null }));

  // 順序：目前持股在最上面（每天打開最想看的），兩個入口放它下面。
  // 使用者實機回報原本「新增持股」「定期定額」擋在持股前面，每次都要往下捲。
  render([
    concentrationCard(withIndustry, quotes),
    held.length === 0
      ? h('section', { class: 'card', dataset: { card: 'holdingsList' } },
        h('h2', { class: 'card-title' }, '目前持股'),
        h('p', { class: 'muted' }, '還沒有持股。用下面的「新增一檔」開始。'))
      : h('section', { class: 'card', dataset: { card: 'holdingsList' } },
        h('h2', { class: 'card-title' }, `目前持股（${held.length} 檔）`),
        h('div', { class: 'rows' }, ...held.map(manageRow)),
      ),
    h('section', { class: 'card', dataset: { card: 'addHolding' } },
      h('h2', { class: 'card-title' }, '新增持股'),
      h('p', { class: 'muted sm' }, '這個版本只支援上市股票。上櫃與興櫃可以記股數，但不會顯示價格與損益。'),
      h('button', { class: 'btn btn-primary', onclick: () => addFlow() }, '新增一檔'),
    ),
    h('section', { class: 'card', dataset: { card: 'plansEntry' } },
      h('h2', { class: 'card-title' }, '定期定額'),
      h('p', { class: 'muted sm' }, '設好計畫之後，扣款日過了就會自動產生一筆待確認的扣款，對照券商通知確認就好。'),
      // 跟「新增一檔」同一顆按鈕樣式（使用者實機回報這兩顆長得不一樣）。
      // 它是導覽用的連結，所以仍然是 <a>，但視覺上與 .btn-primary 一致。
      h('a', { class: 'btn btn-primary', href: '#/plans' }, '管理定期定額計畫'),
    ),
  ]);
}

function manageRow(hd) {
  const head = h('div', { class: 'row-head' },
    h('span', { class: 'row-code' }, hd.code),
    h('span', { class: 'row-name' }, hd.name || ''),
    hd.industry ? h('span', { class: 'tag' }, hd.industry) : null,
  );

  // 不支援報價的持股：這一列不建立任何 .num 節點
  if (!hd.supported) {
    return h('a', { class: 'row row-unsupported', href: `#/holdings/${hd.code}`, dataset: { code: hd.code } },
      head,
      h('div', { class: 'row-side' },
        h('span', { class: 'muted sm' }, `${fmtShares(hd.shares)} 股`),
        h('span', { class: 'tag' }, STATUS_TEXT.unsupported),
      ),
    );
  }

  return h('a', { class: 'row', href: `#/holdings/${hd.code}`, dataset: { code: hd.code } },
    head,
    h('div', { class: 'row-mid' }, h('span', { class: 'muted sm' }, `${fmtShares(hd.shares)} 股`)),
    h('div', { class: 'row-side' },
      hd.avgCost != null
        ? h('span', { class: 'muted sm' }, '均價 ', num(fmtPrice(hd.avgCost)))
        : h('span', { class: 'muted sm' }, '未填均價'),
    ),
  );
}

async function addFlow() {
  const codeInput = h('input', { class: 'field', type: 'text', inputmode: 'numeric', placeholder: '例如 2330', autocomplete: 'off' });
  const hint = h('p', { class: 'form-hint muted sm' }, '輸入 4–6 碼股票代號');
  const preview = h('div', { class: 'preview' });

  const renderPreview = () => {
    const checked = holdings.checkCode(codeInput.value);
    preview.replaceChildren();
    if (!codeInput.value.trim()) return;
    if (checked.error) {
      preview.append(h('p', { class: 'warn sm' }, checked.error));
      return;
    }
    const info = checked.info;
    preview.append(h('p', { class: 'sm' }, `${info.code} ${info.name}　${info.market}${info.industry ? `　${info.industry}` : ''}`));
    if (!info.supported) {
      preview.append(h('p', { class: 'warn sm' }, catalog.unsupportedMessage(info)));
    }
  };
  codeInput.addEventListener('input', renderPreview);

  const sharesInput = h('input', { class: 'field', type: 'text', inputmode: 'numeric', placeholder: '股數（例如 1000）' });
  const costInput = h('input', { class: 'field', type: 'text', inputmode: 'decimal', placeholder: '平均成本（選填，可以之後再填）' });

  const go = await modal({
    title: '新增持股',
    body: h('div', { class: 'form' },
      h('label', { class: 'sm muted' }, '股票代號'), codeInput, hint, preview,
      h('label', { class: 'sm muted' }, '目前股數'), sharesInput,
      h('label', { class: 'sm muted' }, '平均成本（選填）'), costInput,
      h('p', { class: 'muted sm' }, '平均成本不填也沒關係，當日損益與市值都算得出來；填了才會多算未實現損益。'),
    ),
    actions: [{ label: '取消', value: false }, { label: '加入', value: true, primary: true }],
  });
  if (!go) return;

  const checked = holdings.checkCode(codeInput.value);
  if (checked.error) { toast(checked.error); return; }
  const info = checked.info;

  if (!info.supported) {
    const yes = await confirmDialog(
      `${catalog.unsupportedMessage(info)}。\n\n仍然要記錄股數嗎？（只記股數，不計損益，也不會有除權息提醒）`,
      { okLabel: '仍然記錄股數', cancelLabel: '取消' },
    );
    if (!yes) return;
  }

  const shares = Number(String(sharesInput.value).replace(/,/g, '').trim());
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isInteger(shares)) {
    toast('股數要是大於零的整數');
    return;
  }
  const rawCost = String(costInput.value).replace(/,/g, '').trim();
  const avgCost = rawCost === '' ? null : Number(rawCost);
  if (avgCost != null && (!Number.isFinite(avgCost) || avgCost < 0)) {
    toast('平均成本要是不小於零的數字');
    return;
  }

  try {
    await holdings.addOpening({ code: info.code, shares, avgCost, date: localISODate() });
    toast(`已加入 ${info.code} ${info.name}`);
    store.notifyChanged();
    // 新增了持股就重新結算一次（這時候才有東西要算）
    store.update({ force: true }).then(() => holdingsView());
    holdingsView();
  } catch (e) {
    toast(String(e.message || e));
  }
}


/**
 * 產業集中度。
 *
 * **只陳述事實，不做評價。** 不寫「過度集中」「建議分散」「風險偏高」——
 * 那些都是投資建議。使用者看到百分比自己會有判斷。
 *
 * 條狀圖用 CSS 寬度畫，不用圖表庫：特大字級時它會跟著文字一起長，
 * 不會像 canvas 那樣被壓成一團（layouttest 會掃這件事）。
 */
function concentrationCard(held, quotes) {
  if (held.length === 0) return null;
  const { rows, excluded, counted, totalMicro } = concentration.byIndustry(held, quotes);
  if (rows.length === 0) {
    return h('section', { class: 'card', dataset: { card: 'concentration' } },
      h('h2', { class: 'card-title' }, '產業分布'),
      h('p', { class: 'muted' }, '還算不出市值，沒有辦法顯示分布。'),
      noteOf({ excluded, counted }));
  }

  return h('section', { class: 'card', dataset: { card: 'concentration' } },
    h('h2', { class: 'card-title' }, '產業分布'),
    h('p', { class: 'muted sm' }, `依最後一次結算的收盤價計算，共 ${fmtMoneyMicro(totalMicro)} 元。`),
    h('div', { class: 'bars' }, ...rows.map((r) => bar(r))),
    noteOf({ excluded, counted }));
}

function bar(r) {
  const pct = r.pct ?? 0;
  return h('div', { class: 'bar-row', dataset: { industry: r.industry } },
    h('div', { class: 'bar-head' },
      h('span', { class: 'bar-label' }, r.industry),
      h('span', { class: 'bar-pct' }, `${pct.toFixed(1)}%`)),
    h('div', { class: 'bar-track' },
      h('div', { class: 'bar-fill', style: `width: ${Math.max(0, Math.min(100, pct))}%` })),
    h('p', { class: 'muted sm' }, `${r.codes.join('、')}　${fmtMoneyMicro(r.valueMicro)} 元`));
}

function noteOf(x) {
  const note = concentration.exclusionNote(x);
  return note ? h('p', { class: 'muted sm', dataset: { note: 'concentrationExcluded' } }, note) : null;
}
