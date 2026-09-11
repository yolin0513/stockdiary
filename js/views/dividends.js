// 股利頁：待確認事件、除權息日曆、累積已領股利。
//
// 文案規則：
//   · 金額還沒公告的事件（TWSE 回「待公告實際收益分配金額」）顯示「金額待公告」，
//     **不顯示 0 元，也不顯示預估金額**
//   · 沒有參考價的除權息日要講出來，因為那一天的當日損益不會把這一檔算進去
//   · 這一頁不出現任何「該不該參加除權息」之類的判斷

import { h, num, fmtMoneyMicro, fmtPrice, fmtShares, fmtDate, toast, modal, confirmDialog, NO_VALUE } from '../ui.js';
import * as events from '../events.js';
import * as holdings from '../holdings.js';
import * as prefs from '../prefs.js';
import { dividendAmount, stockDividendShares, KIND_LABEL } from '../dividend.js';
import { setTop, render } from '../shell.js';

export default async function dividendsView() {
  setTop({ title: '股利' });

  const [pending, upcoming, confirmed, summary, held] = await Promise.all([
    events.pending(), events.upcoming(), events.confirmed(),
    events.summary({ year: new Date().getFullYear() }),
    holdings.list(),
  ]);

  render([
    pending.length ? pendingCard(pending) : null,
    summaryCard(summary),
    upcomingCard(upcoming, held),
    confirmed.length ? historyCard(confirmed) : null,
  ].filter(Boolean));
}

// ---------- 待確認 ----------

function pendingCard(list) {
  return h('section', { class: 'card', dataset: { card: 'pendingEvents' } },
    h('h2', { class: 'card-title' }, `待確認（${list.length} 筆）`),
    h('p', { class: 'muted sm' }, '除權息日已經過了。對照券商的通知確認金額，確認後才會計入累積已領股利。'),
    h('div', { class: 'rows' }, ...list.map(pendingRow)),
  );
}

function pendingRow(e) {
  const hasAmount = e.amountEst != null;
  return h('div', { class: 'row', dataset: { eventId: e.id } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, fmtDate(e.exDate)),
      h('span', { class: 'row-name' }, `${e.code} ${e.name}`),
      h('span', { class: 'tag' }, KIND_LABEL[e.kind] ?? ''),
    ),
    h('p', { class: 'row-note muted sm' }, describeEvent(e)),
    h('div', { class: 'row-side' },
      hasAmount
        ? num(fmtMoneyMicro(BigInt(e.amountEst)))
        : h('span', { class: 'warn sm' }, '金額待公告'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => confirmFlow(e) }, '確認'),
    ),
  );
}

/**
 * 一句話描述這筆事件在配什麼。金額未公告就明講，不湊數字。
 *
 * 「尚未取得參考價」只有在除權息日**已經過了**的時候才講 —— 還沒到的日子
 * 本來就不會有參考價，先講只會讓人以為有問題。
 */
function describeEvent(e, { happened = true } = {}) {
  const parts = [];
  if (e.cashPerShare != null && e.cashPerShare > 0) {
    parts.push(`每股配息 ${fmtPrice(e.cashPerShare)} 元 × ${fmtShares(e.sharesHeld)} 股`);
  } else if (e.kind === 'cash' || e.kind === 'both') {
    parts.push('配息金額尚未公告');
  }
  if (e.stockRate != null && e.stockRate > 0) {
    const { wholeShares, fractionShares, perThousand } = stockDividendShares({ shares: e.sharesHeld, stockRate: e.stockRate });
    parts.push(`每仟股配 ${perThousand.toFixed(2)} 股 → 約增加 ${fmtShares(wholeShares)} 股` +
      (fractionShares > 0 ? `，餘數 ${fractionShares.toFixed(5)} 股以現金找零` : ''));
  }
  if (e.rightsRate != null && e.rightsRate > 0) {
    parts.push('另有現金增資，請對照券商通知自行輸入變動');
  }
  if (happened && e.refPrice == null) {
    parts.push('尚未取得除權息參考價，這一天的當日損益不含這一檔');
  }
  return parts.join('；') || '沒有可計算的配息資料';
}

async function confirmFlow(e) {
  const autoFees = prefs.get('dividendAutoFees');
  const est = dividendAmount({ shares: e.sharesHeld, cashPerShare: e.cashPerShare, autoFees });
  const input = h('input', {
    class: 'field', type: 'text', inputmode: 'decimal',
    placeholder: est.netMicro == null ? '券商實際入帳金額' : '',
    value: est.netMicro == null ? '' : String(Number(est.netMicro) / 1e6),
  });

  const feeLines = [];
  if (autoFees && est.grossMicro != null) {
    feeLines.push(h('p', { class: 'muted sm' },
      '股數 × 每股配息 = ', num(fmtMoneyMicro(est.grossMicro)), ' 元'));
    feeLines.push(h('p', { class: 'muted sm' },
      '扣匯費 ', num(fmtMoneyMicro(est.wireFeeMicro)), ' 元'));
    if (est.nhiFeeMicro > 0n) {
      feeLines.push(h('p', { class: 'muted sm' },
        '扣二代健保補充保費 2.11% = ', num(fmtMoneyMicro(est.nhiFeeMicro)), ' 元'));
    } else {
      feeLines.push(h('p', { class: 'muted sm' }, '未達 20,000 元，不扣補充保費'));
    }
  } else if (est.grossMicro != null) {
    feeLines.push(h('p', { class: 'muted sm' }, '自動扣費目前關閉，金額是「股數 × 每股配息」，沒有扣任何費用。'));
  } else {
    feeLines.push(h('p', { class: 'warn sm' }, '這一筆的配息金額證交所還沒公告，請填入券商實際入帳的金額。'));
  }

  const go = await modal({
    title: `${e.code} ${e.name}　${fmtDate(e.exDate)} ${KIND_LABEL[e.kind] ?? ''}`,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted sm' }, describeEvent(e)),
      ...feeLines,
      h('label', { class: 'sm muted' }, '實收金額（元）'),
      input,
      h('p', { class: 'muted sm' }, '以券商實際入帳為準。金額填錯了之後也可以取消確認重填。'),
    ),
    actions: [
      { label: '取消', value: 'cancel' },
      { label: '這筆我沒有', value: 'dismiss' },
      { label: '確認', value: 'confirm', primary: true },
    ],
  });

  if (go === 'confirm') {
    try {
      await events.confirm(e.id, { amountActual: input.value, autoFees });
      toast('已確認');
    } catch (err) { toast(String(err.message || err)); }
  } else if (go === 'dismiss') {
    const yes = await confirmDialog(
      `把 ${e.code} ${e.name} ${fmtDate(e.exDate)} 這筆標成「我沒有」？\n它不會計入累積已領股利，日曆上也不再提醒。`,
      { okLabel: '標成沒有' });
    if (yes) { await events.dismiss(e.id); toast('已忽略'); }
  } else {
    return;
  }
  dividendsView();
}

// ---------- 累積已領股利 ----------

function summaryCard(s) {
  const year = new Date().getFullYear();
  return h('section', { class: 'card', dataset: { card: 'dividendSummary' } },
    h('h2', { class: 'card-title' }, '累積已領股利'),
    h('p', { class: 'big-number' },
      s.totalMicro != null ? num(fmtMoneyMicro(s.totalMicro)) : num(NO_VALUE, 'v-none')),
    s.totalMicro == null
      ? h('p', { class: 'muted sm' }, '還沒有確認過任何一筆股利。')
      : h('p', { class: 'muted sm' },
        `${year} 年 `, num(s.yearMicro != null ? fmtMoneyMicro(s.yearMicro) : NO_VALUE), ' 元',
        `　共 ${s.counted} 筆`),
    s.unknown > 0
      ? h('p', { class: 'warn sm' }, `另有 ${s.unknown} 筆已確認但沒有填金額，不計入總計`)
      : null,
    s.byCode.length
      ? h('div', { class: 'rows' }, ...s.byCode.map(([code, micro]) =>
        h('div', { class: 'row' },
          h('div', { class: 'row-head' }, h('span', { class: 'row-code' }, code)),
          h('div', { class: 'row-side' }, num(fmtMoneyMicro(micro))))))
      : null,
  );
}

// ---------- 日曆 ----------

function upcomingCard(list, held) {
  const supported = held.filter((x) => x.supported).length;
  return h('section', { class: 'card', dataset: { card: 'upcomingEvents' } },
    h('h2', { class: 'card-title' }, '即將除權息'),
    list.length === 0
      ? h('p', { class: 'muted sm' }, supported === 0
        ? '還沒有支援報價的上市持股，所以沒有除權息資料。'
        : '未來幾週，你的持股沒有要除權息的。證交所的預告表大約涵蓋七週。')
      : h('div', { class: 'rows' }, ...list.map(upcomingRow)),
    h('p', { class: 'muted sm' }, '資料來自證交所「除權除息預告表」，只涵蓋上市股票。'),
  );
}

function upcomingRow(e) {
  const hasAmount = e.amountEst != null;
  return h('div', { class: 'row', dataset: { eventId: e.id } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, fmtDate(e.exDate)),
      h('span', { class: 'row-name' }, `${e.code} ${e.name}`),
      h('span', { class: 'tag' }, KIND_LABEL[e.kind] ?? ''),
    ),
    h('p', { class: 'row-note muted sm' }, describeEvent(e, { happened: false })),
    h('div', { class: 'row-side' },
      hasAmount
        ? h('span', {}, '預估 ', num(fmtMoneyMicro(BigInt(e.amountEst))), ' 元')
        : h('span', { class: 'warn sm' }, '金額待公告'),
    ),
  );
}

// ---------- 已確認紀錄 ----------

function historyCard(list) {
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, `已確認（${list.length} 筆）`),
    h('div', { class: 'rows' }, ...list.map((e) => h('div', { class: 'row', dataset: { eventId: e.id } },
      h('div', { class: 'row-head' },
        h('span', { class: 'row-code' }, fmtDate(e.exDate)),
        h('span', { class: 'row-name' }, `${e.code} ${e.name}`),
      ),
      h('div', { class: 'row-side' },
        e.amountActual != null
          ? num(fmtMoneyMicro(BigInt(e.amountActual)))
          : h('span', { class: 'muted sm' }, '沒有金額'),
        h('button', {
          class: 'link-btn sm',
          onclick: async () => {
            const yes = await confirmDialog(`取消確認 ${e.code} ${fmtDate(e.exDate)}？\n它會回到待確認，配股產生的股數變動也會一併刪掉。`);
            if (!yes) return;
            await events.unconfirm(e.id);
            toast('已取消確認');
            dividendsView();
          },
        }, '取消確認'),
      ),
    ))),
  );
}
