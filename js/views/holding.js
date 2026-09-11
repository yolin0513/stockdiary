// 單檔持股：股數、平均成本、變動紀錄。
//
// 股數是「所有已確認變動的總和」，不能直接改 —— 要改就是新增一筆變動。
// 畫面上講明這件事，使用者才知道為什麼沒有「直接改股數」的欄位。

import { h, num, fmtShares, fmtPrice, fmtDate, toast, modal, confirmDialog, NO_VALUE } from '../ui.js';
import * as holdings from '../holdings.js';
import * as catalog from '../catalog.js';
import * as store from '../store.js';
import { STATUS_TEXT, BASIS_SOURCE_TEXT } from '../settle.js';
import { setTop, render } from '../app.js';
import { navigate } from '../router.js';
import { localISODate } from '../roc.js';

const KIND_LABEL = {
  opening: '快速設定持股',
  manual: '手動調整',
  dca: '定期定額扣款',
  dividendReinvest: '配息再投入',
  stockDividend: '配股',
};

export default async function holdingView(code) {
  const list = await holdings.list();
  const hd = list.find((x) => x.code === code);
  if (!hd) { navigate('/holdings', { replace: true }); return; }

  setTop({ title: `${hd.code} ${hd.name || ''}` });
  const changes = await holdings.changesOf(code);
  const settleDate = await store.lastSettledDate();
  const settled = settleDate ? await store.loadSettle(settleDate) : null;
  const row = (settled?.byCode ?? []).find((r) => r.code === code) ?? null;

  render([
    summaryCard(hd, row),
    costCard(hd),
    changesCard(hd, changes),
    dangerCard(hd),
  ]);
}

function summaryCard(hd, row) {
  const info = catalog.lookup(hd.code);
  const meta = [hd.market, hd.industry, info.type].filter(Boolean).join('　');

  const body = [
    h('p', { class: 'muted sm' }, meta),
    h('p', { class: 'mid-number' }, h('span', {}, `${fmtShares(hd.shares)} 股`)),
  ];

  if (!hd.supported) {
    // 不支援報價：整張卡片不建立任何 .num 節點
    body.push(h('p', { class: 'warn sm' }, catalog.unsupportedMessage(info)));
    body.push(h('p', { class: 'muted sm' }, '這一檔只記股數，不會出現在當日損益與市值裡，也不會有除權息提醒。'));
  } else if (row && row.status === 'ok') {
    body.push(h('p', { class: 'muted sm' },
      '收盤 ', num(fmtPrice(row.close)),
      '　基準 ', num(fmtPrice(row.basis)),
      row.basisSource === 'refPrice' ? h('span', { class: 'tag' }, BASIS_SOURCE_TEXT.refPrice) : null,
      row.basisSource === 'refPriceDerived' ? h('span', { class: 'tag tag-warn' }, BASIS_SOURCE_TEXT.refPriceDerived) : null));
    if (row.basisSource === 'refPriceDerived') {
      body.push(h('p', { class: 'muted sm' },
        '證交所的除權除息計算結果表只留最近一次，這一天的參考價已經查不到，' +
        '所以基準價是用前一交易日收盤價與公告的配息、配股率，依證交所公式試算的。'));
    }
    body.push(h('p', { class: 'muted sm' }, '當日損益 ', num(fmtMoneyFromMicroString(row.pl))));
  } else {
    body.push(h('p', { class: 'muted sm' }, STATUS_TEXT[row?.status] ?? '尚未結算'));
  }

  return h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '目前'), ...body);
}

function fmtMoneyFromMicroString(s) {
  if (s == null) return NO_VALUE;
  const v = Number(BigInt(s)) / 1e6;
  const r = Math.round(v);
  const abs = Math.abs(r).toLocaleString('zh-Hant-TW');
  return r > 0 ? `+${abs}` : r < 0 ? `-${abs}` : '0';
}

function costCard(hd) {
  if (!hd.supported) return null;
  const input = h('input', {
    class: 'field', type: 'text', inputmode: 'decimal',
    placeholder: '未填', value: hd.openingAvgCost == null ? '' : String(hd.openingAvgCost),
  });
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '平均成本（選填）'),
    input,
    h('p', { class: 'muted sm' }, '這裡填的是「起始持股」的平均成本。之後每一筆有填成交價的買進會自動加權進來。'),
    h('p', { class: 'muted sm' }, '填了才會算未實現損益與報酬率。不填不影響當日損益與市值。'),
    hd.costNote ? h('p', { class: 'warn sm' }, hd.costNote) : null,
    hd.avgCost != null && hd.openingAvgCost != null && Math.abs(hd.avgCost - hd.openingAvgCost) > 1e-6
      ? h('p', { class: 'muted sm' }, '目前加權後的平均成本：', num(fmtPrice(hd.avgCost)), ' 元')
      : null,
    h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        try {
          await holdings.setAvgCost(hd.code, input.value.replace(/,/g, '').trim());
          toast('已儲存');
          holdingView(hd.code);
        } catch (e) { toast(String(e.message || e)); }
      },
    }, '儲存'),
  );
}

function changesCard(hd, changes) {
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, `持股變動（${changes.length} 筆）`),
    h('p', { class: 'muted sm' }, '股數是這些變動加起來的結果，所以沒有「直接改股數」的欄位 —— 要改就新增一筆變動，這樣才回推得出過去每一天的持股。'),
    h('div', { class: 'rows' }, ...changes.map((c) => changeRow(hd, c))),
    h('button', { class: 'btn', onclick: () => addChangeFlow(hd) }, '新增一筆變動'),
  );
}

function changeRow(hd, c) {
  const delta = Number(c.deltaShares);
  return h('div', { class: 'row', dataset: { changeId: c.id } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, fmtDate(c.date)),
      h('span', { class: 'row-name' }, KIND_LABEL[c.kind] ?? c.kind),
      c.status === 'pending' ? h('span', { class: 'tag tag-warn' }, '待確認') : null,
    ),
    h('div', { class: 'row-side' },
      h('span', { class: delta >= 0 ? 'v-up' : 'v-down' }, `${delta >= 0 ? '+' : ''}${fmtShares(delta)} 股`),
      h('button', {
        class: 'link-btn sm',
        onclick: async () => {
          const yes = await confirmDialog(`刪掉 ${fmtDate(c.date)} 這筆變動？股數會跟著重算。`, { danger: true, okLabel: '刪掉' });
          if (!yes) return;
          await holdings.deleteChange(c.id);
          toast('已刪除');
          holdingView(hd.code);
        },
      }, '刪除'),
    ),
  );
}

async function addChangeFlow(hd) {
  const dateInput = h('input', { class: 'field', type: 'date', value: localISODate() });
  const sharesInput = h('input', { class: 'field', type: 'text', inputmode: 'numeric', placeholder: '買進填正數、賣出填負數' });
  const priceInput = h('input', { class: 'field', type: 'text', inputmode: 'decimal', placeholder: '成交價（選填）' });

  const go = await modal({
    title: `${hd.code} 新增變動`,
    body: h('div', { class: 'form' },
      h('label', { class: 'sm muted' }, '日期'), dateInput,
      h('label', { class: 'sm muted' }, '股數增減'), sharesInput,
      h('label', { class: 'sm muted' }, '成交價（選填）'), priceInput,
    ),
    actions: [{ label: '取消', value: false }, { label: '加入', value: true, primary: true }],
  });
  if (!go) return;

  const delta = Number(String(sharesInput.value).replace(/,/g, '').trim());
  const rawPrice = String(priceInput.value).replace(/,/g, '').trim();
  try {
    await holdings.addChange({
      code: hd.code,
      date: dateInput.value,
      deltaShares: delta,
      price: rawPrice === '' ? null : Number(rawPrice),
      kind: 'manual',
      status: 'confirmed',
    });
    toast('已新增');
    holdingView(hd.code);
  } catch (e) {
    toast(String(e.message || e));
  }
}

function dangerCard(hd) {
  return h('section', { class: 'card' },
    h('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        const yes = await confirmDialog(
          `刪掉 ${hd.code} ${hd.name}？\n它的 ${hd.shares} 股與所有變動紀錄都會一起刪掉，無法復原。`,
          { danger: true, okLabel: '刪掉這一檔' },
        );
        if (!yes) return;
        await holdings.removeHolding(hd.code);
        toast('已刪除');
        navigate('/holdings');
      },
    }, '刪除這一檔持股'),
  );
}
