// 定期定額：計畫管理與待確認扣款。
//
// 文案規則：
//   · 估算股數就說是估算，旁邊寫出餘額，讓使用者對得起來
//   · 拿不到扣款日收盤價時，那一筆仍然列出來，股數留空並說明 —— 扣款是真的發生了
//   · 這一頁不出現任何「要不要繼續扣」「這檔適不適合定期定額」之類的判斷

import { h, num, fmtMoneyMicro, fmtMoney, fmtPrice, fmtShares, fmtDate, toast, modal, confirmDialog, switchRow } from '../ui.js';
import * as plans from '../plans.js';
import * as holdings from '../holdings.js';
import * as catalog from '../catalog.js';
import * as store from '../store.js';
import { setTop, render } from '../shell.js';

const KIND_LABEL = {
  dca: '定期定額扣款',
  dividendReinvest: '配息再投入',
  manual: '手動調整',
  stockDividend: '配股',
  opening: '快速設定持股',
};

export default async function plansView() {
  setTop({ title: '定期定額' });
  const [list, pending] = await Promise.all([plans.list(), plans.pendingChanges()]);

  render([
    pending.length ? pendingCard(pending) : null,
    h('section', { class: 'card', dataset: { card: 'plansList' } },
      h('h2', { class: 'card-title' }, `計畫（${list.length}）`),
      h('p', { class: 'muted sm' },
        '扣款日過了之後第一次開 App，會產生一筆待確認的扣款，對照券商通知確認就好。' +
        '沒開 App 的月份會累積起來，不會消失，也不會自動確認。'),
      list.length
        ? h('div', { class: 'rows' }, ...list.map(planRow))
        : h('p', { class: 'muted' }, '還沒有計畫。'),
      h('button', { class: 'btn btn-primary', onclick: () => editFlow(null) }, '新增計畫'),
    ),
  ].filter(Boolean));
}

// ---------- 待確認扣款 ----------

function pendingCard(list) {
  return h('section', { class: 'card', dataset: { card: 'pendingChanges' } },
    h('h2', { class: 'card-title' }, `待確認扣款（${list.length} 筆）`),
    h('p', { class: 'muted sm' }, '股數是用扣款日收盤價估的，跟券商實際成交可能差一點。對照通知確認，或直接改成實際的數字。'),
    h('div', { class: 'rows' }, ...list.map(pendingRow)),
  );
}

function pendingRow(c) {
  const info = catalog.lookup(c.code);
  const rem = c.estimate?.remainder != null ? BigInt(c.estimate.remainder) : null;
  return h('div', { class: 'row', dataset: { changeId: c.id } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, fmtDate(c.date)),
      h('span', { class: 'row-name' }, `${c.code} ${info.found ? info.name : ''}`),
      h('span', { class: 'tag' }, KIND_LABEL[c.kind] ?? c.kind),
    ),
    h('p', { class: 'row-note muted sm' },
      c.note || '',
      c.deltaShares != null && (c.price ?? c.estimatePrice) != null
        ? ` → 估 ${fmtShares(c.deltaShares)} 股 @ ${fmtPrice(c.price ?? c.estimatePrice)}` +
          (rem != null ? `，餘 ${fmtMoneyMicro(rem)} 元` : '')
        : ''),
    h('div', { class: 'row-side' },
      c.deltaShares != null
        ? num(`${fmtShares(c.deltaShares)} 股`)
        : h('span', { class: 'warn sm' }, '股數待填'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => confirmFlow(c) }, '確認'),
    ),
  );
}

async function confirmFlow(c) {
  const info = catalog.lookup(c.code);
  const sharesInput = h('input', {
    class: 'field', type: 'text', inputmode: 'numeric',
    value: c.deltaShares == null ? '' : String(c.deltaShares),
    placeholder: '券商通知上的股數',
  });
  const priceInput = h('input', {
    class: 'field', type: 'text', inputmode: 'decimal',
    value: (c.price ?? c.estimatePrice) == null ? '' : String(c.price ?? c.estimatePrice),
    placeholder: '成交價（選填）',
  });

  const go = await modal({
    title: `${fmtDate(c.date)}　${c.code} ${info.found ? info.name : ''}`,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted sm' }, c.note || ''),
      c.amount != null
        ? h('p', { class: 'muted sm' }, '扣款金額 ', num(fmtMoney(c.amount)), ' 元')
        : null,
      h('label', { class: 'sm muted' }, '股數'),
      sharesInput,
      h('label', { class: 'sm muted' }, '成交價（選填）'),
      priceInput,
      h('p', { class: 'muted sm' },
        c.estimatePrice != null
          ? '預設帶入扣款日的收盤價，跟券商實際成交價通常差一點，請以通知為準。'
          : '這一天的收盤價沒有取得，成交價請照券商通知填。'),
      h('p', { class: 'muted sm' },
        '填了成交價，平均成本才會把這一筆加權進去；清空不填也可以，只是平均成本會少算這一筆（畫面會標出來）。'),
    ),
    actions: [
      { label: '取消', value: 'cancel' },
      { label: '這筆沒扣到', value: 'delete', danger: true },
      { label: '確認', value: 'confirm', primary: true },
    ],
  });

  if (go === 'confirm') {
    try {
      await holdings.confirmChange(c.id, { deltaShares: sharesInput.value, price: priceInput.value });
      // 「已確認」三個字不夠 —— 他手上正拿著券商通知在對。
      // 把**實際記進去的數字**講出來，當場就能核對：對不上就按刪除重來。
      const after = (await holdings.list()).find((x) => x.code === c.code);
      const added = Number(String(sharesInput.value).replace(/,/g, '').trim());
      toast(`已確認 ${c.code}：＋${fmtShares(added)} 股，持有 ${fmtShares(after?.shares)} 股`
        + (after?.avgCost != null ? `，均價 ${fmtPrice(after.avgCost)}` : ''), 4200);
      store.notifyChanged();
    } catch (e) { toast(String(e.message || e)); return; }
  } else if (go === 'delete') {
    const yes = await confirmDialog(`刪掉 ${fmtDate(c.date)} 這筆待確認扣款？\n如果券商那天其實沒有扣款，刪掉是對的。`, { danger: true, okLabel: '刪掉' });
    if (!yes) return;
    await holdings.deleteChange(c.id);
    toast('已刪除');
  } else {
    return;
  }
  plansView();
}

// ---------- 計畫 ----------

function planRow(p) {
  return h('div', { class: 'row', dataset: { planId: p.id } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, p.code),
      h('span', { class: 'row-name' }, p.name || ''),
      p.active ? null : h('span', { class: 'tag' }, '已停用'),
      p.reinvestDividend ? h('span', { class: 'tag' }, '配息再投入') : null,
    ),
    h('p', { class: 'row-note muted sm' },
      `每次 ${p.amount.toLocaleString('zh-Hant-TW')} 元，每月 ${p.days.join('、')} 號` +
      (p.feeRate ? `，手續費率 ${(p.feeRate * 100).toFixed(4)}%（每次約 ${Math.round(p.amount * p.feeRate)} 元）` : '，無手續費率')),
    // 修改／停用用一般按鈕，不用底線文字連結：文字連結的點擊區太小，
    // 又跟旁邊的代號基線對不齊（使用者實機回報）。全 App 統一用 .btn。
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => editFlow(p) }, '修改'),
      h('button', {
        class: 'btn btn-sm',
        onclick: async () => { await plans.setActive(p.id, !p.active); toast(p.active ? '已停用' : '已啟用'); plansView(); },
      }, p.active ? '停用' : '啟用'),
    ),
  );
}

async function editFlow(existing) {
  const codeInput = h('input', {
    class: 'field', type: 'text', inputmode: 'numeric', placeholder: '例如 0050',
    value: existing?.code ?? '', autocomplete: 'off',
  });
  const preview = h('div', { class: 'preview' });
  const renderPreview = () => {
    preview.replaceChildren();
    const raw = codeInput.value.trim();
    if (!raw) return;
    const info = catalog.lookup(raw);
    if (!info.found) { preview.append(h('p', { class: 'warn sm' }, `找不到代號 ${raw.toUpperCase()}`)); return; }
    preview.append(h('p', { class: 'sm' }, `${info.code} ${info.name}　${info.market}${info.industry ? `　${info.industry}` : ''}`));
    if (!info.supported) {
      preview.append(h('p', { class: 'warn sm' },
        `${catalog.unsupportedMessage(info)}，所以也估不出扣款股數，不能建定期定額計畫`));
    }
  };
  codeInput.addEventListener('input', renderPreview);
  renderPreview();

  const amountInput = h('input', {
    class: 'field', type: 'text', inputmode: 'numeric', placeholder: '每次扣款金額（元）',
    value: existing?.amount == null ? '' : String(existing.amount),
  });
  const daysInput = h('input', {
    class: 'field', type: 'text', inputmode: 'numeric', placeholder: '例如 6,16,26',
    value: existing?.days?.join(',') ?? '',
  });
  const feeInput = h('input', {
    class: 'field', type: 'text', inputmode: 'decimal', placeholder: '選填，例如 0.001425',
    value: existing?.feeRate ? String(existing.feeRate) : '',
  });
  // 費率是**比例**不是百分比（0.001425 ＝ 0.1425%）。這個單位很容易填錯，
  // 而填錯之後畫面只會寫「手續費率 14.2500%」，看起來完全正常。
  // 所以當場把它換算成「這一次會被收走幾元」—— 錯了一眼就看得出來。
  const feeHint = h('p', { class: 'muted sm', dataset: { hint: 'feeRate' } }, '');
  const paintFeeHint = () => {
    const raw = feeInput.value.replace(/,/g, '').trim();
    const amt = Number(amountInput.value.replace(/,/g, '').trim());
    if (raw === '') { feeHint.replaceChildren('沒填就是不扣手續費，估出來的股數會略多一點。'); feeHint.className = 'muted sm'; return; }
    const f = Number(raw);
    if (!Number.isFinite(f) || f < 0) { feeHint.replaceChildren('手續費率要是不小於零的數字。'); feeHint.className = 'warn sm'; return; }
    if (f > plans.MAX_FEE_RATE) {
      feeHint.className = 'warn sm';
      feeHint.replaceChildren(`${raw} 代表 ${(f * 100).toFixed(4)}%，看起來是把百分比直接填進來了。`
        + `券商說的「0.1425%」要填 0.001425。`);
      return;
    }
    feeHint.className = 'muted sm';
    const per = Number.isFinite(amt) && amt > 0
      ? `這一次扣款 ${amt.toLocaleString('zh-Hant-TW')} 元會收 ${(amt * f).toFixed(2)} 元手續費`
      : `每 10,000 元收 ${(10000 * f).toFixed(2)} 元手續費`;
    feeHint.replaceChildren(`${raw} ＝ ${(f * 100).toFixed(4)}%，${per}。`);
  };
  feeInput.addEventListener('input', paintFeeHint);
  amountInput.addEventListener('input', () => paintFeeHint());
  paintFeeHint();

  let reinvest = existing?.reinvestDividend ?? false;
  // 切換開關（js/ui.js），跟設定頁與試算器同一套。原本是一顆寫著「開啟／關閉」的
  // 膠囊按鈕 —— 使用者實機回報看不出現在是哪一邊：寫「開啟」是目前開著、還是按了會開？
  let reinvestRow = h('div');
  const paintReinvest = () => {
    const next = switchRow({
      label: '配息再投入',
      hint: '這一檔的股利確認之後，自動產生一筆待確認的再投入買進（用除息日後第一個交易日的收盤價估算）。',
      checked: reinvest,
      onChange: () => { reinvest = !reinvest; paintReinvest(); },
    });
    reinvestRow.replaceWith(next);
    reinvestRow = next;
  };
  paintReinvest();

  const go = await modal({
    title: existing ? `修改 ${existing.code} 的計畫` : '新增定期定額計畫',
    body: h('div', { class: 'form' },
      h('label', { class: 'sm muted' }, '股票代號'), codeInput, preview,
      h('label', { class: 'sm muted' }, '每次扣款金額（元）'), amountInput,
      h('label', { class: 'sm muted' }, '每月扣款日（可多個，用逗號分開）'), daysInput,
      h('p', { class: 'muted sm' }, '扣款日遇到週末或休市會順延到下一個交易日；當月沒有那一天（例如 31 號）會改用月底。'),
      h('label', { class: 'sm muted' }, '券商手續費率（選填，0.001425 代表 0.1425%）'), feeInput,
      feeHint,
      reinvestRow,
    ),
    actions: [
      { label: '取消', value: 'cancel' },
      ...(existing ? [{ label: '刪除計畫', value: 'delete', danger: true }] : []),
      { label: '儲存', value: 'save', primary: true },
    ],
  });

  if (go === 'delete') {
    const yes = await confirmDialog(
      `刪掉 ${existing.code} 的定期定額計畫？\n已經確認過的扣款紀錄會留著，只是之後不再自動產生新的。`,
      { danger: true, okLabel: '刪掉計畫' });
    if (!yes) return;
    await plans.remove(existing.id);
    toast('已刪除');
    plansView();
    return;
  }
  if (go !== 'save') return;

  const days = daysInput.value.split(/[,，\s]+/).filter(Boolean).map(Number);
  try {
    await plans.save({
      id: existing?.id,
      createdAt: existing?.createdAt,
      startDate: existing?.startDate,
      code: codeInput.value.trim().toUpperCase(),
      amount: amountInput.value.replace(/,/g, '').trim(),
      days,
      feeRate: feeInput.value.trim(),
      reinvestDividend: reinvest,
      active: existing?.active !== false,
    });
    toast('已儲存');
    // 存好之後跑一次更新，扣款日已經過了的話馬上就會出現待確認
    store.update({ force: true }).then(() => plansView());
    plansView();
  } catch (e) {
    toast(String(e.message || e));
  }
}
