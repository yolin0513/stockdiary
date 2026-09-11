// 首頁：當日損益放最上面（那是每天打開 App 的理由），其餘依序是市值、未實現、
// 資料狀態、持股明細。
//
// 畫面規則：
//   · 算不出來就寫「—」，絕不寫 0
//   · 不支援報價的持股那一列**不產生任何 .num 節點**（測試靠這個斷言）
//   · 沒有任何一檔填平均成本時，「未實現損益」整個區塊不出現（不是顯示「—」）

import { h, num, moneyNode, fmtMoneyMicro, fmtPrice, fmtShares, fmtPct, fmtDate, toast, NO_VALUE } from '../ui.js';
import * as store from '../store.js';
import * as holdings from '../holdings.js';
import * as events from '../events.js';
import { computeUnrealized, exclusionNote, partialCostNote, STATUS_TEXT } from '../settle.js';
import { STATUS } from '../update.js';
import { setTop, render } from '../app.js';

export default async function home() {
  setTop({ title: 'StockDiary 股息日記', back: false });

  const held = await holdings.list();
  const upd = store.lastUpdate();
  // 顯示用的是「最後一筆結算紀錄」，不是「最後一次算得出東西的日子」——
  // 一檔都算不出來的那天也要看得到原因（例如在等除權息參考價）。
  const settled = await store.latestSettle();
  const settleDate = settled?.date ?? null;

  // 未實現損益用「最後結算日的收盤價」，不用任何別的來源
  const quotes = {};
  for (const row of settled?.byCode ?? []) {
    if (row.close != null) quotes[row.code] = { close: row.close };
  }
  const unreal = computeUnrealized({ holdings: held, quotes });
  const pendingEvents = await events.pending();
  const divSummary = await events.summary({ year: new Date().getFullYear() });

  render([
    pendingEvents.length ? pendingBanner(pendingEvents) : null,
    dayPLCard(settled, settleDate, upd),
    marketValueCard(settled),
    unrealizedCard(unreal, held),
    dividendCard(divSummary),
    statusCard(upd, settleDate),
    holdingsCard(held, settled),
  ].filter(Boolean));
}

/** 有待確認的除權息事件時，首頁最上面提示一下（PLAN §2.2 第 6 點）。 */
function pendingBanner(list) {
  return h('a', { class: 'banner', href: '#/dividends', dataset: { card: 'pendingBanner' } },
    h('span', { class: 'banner-icon' }, '💰'),
    h('span', { class: 'banner-body' },
      `有 ${list.length} 筆除權息等你確認`,
      h('span', { class: 'muted sm banner-sub' }, '對照券商通知確認後才會計入累積已領股利'),
    ),
    h('span', { class: 'banner-go' }, '›'),
  );
}

/** 累積已領股利。一筆都還沒確認過就顯示「—」，不顯示 0。 */
function dividendCard(s) {
  if (s.counted === 0 && s.unknown === 0) return null;
  return h('section', { class: 'card', dataset: { card: 'dividendTotal' } },
    h('h2', { class: 'card-title' }, '累積已領股利'),
    h('p', { class: 'mid-number' },
      s.totalMicro != null ? num(fmtMoneyMicro(s.totalMicro)) : num(NO_VALUE, 'v-none')),
    h('p', { class: 'muted sm' },
      `${new Date().getFullYear()} 年 `,
      num(s.yearMicro != null ? fmtMoneyMicro(s.yearMicro) : NO_VALUE), ' 元'),
    s.unknown > 0
      ? h('p', { class: 'warn sm' }, `另有 ${s.unknown} 筆已確認但沒有填金額，不計入總計`)
      : null,
    h('a', { class: 'btn', href: '#/dividends' }, '看股利明細'),
  );
}

function dayPLCard(settled, settleDate, upd) {
  const pending = upd?.status === STATUS.TODAY_PENDING;
  const note = settled ? exclusionNote({
    excludedUnsupported: settled.excludedUnsupported ?? 0,
    excludedMissing: settled.excludedMissing ?? 0,
  }) : null;

  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '當日損益'),
    h('p', { class: 'big-number' },
      settled?.dayPLMicro != null ? moneyNode(settled.dayPLMicro) : num(NO_VALUE, 'v-none')),
    settleDate
      ? h('p', { class: 'muted sm' }, `結算日：${fmtDate(settleDate)}`)
      : h('p', { class: 'muted sm' }, '尚未結算過'),
    pending ? h('p', { class: 'sm warn' }, '今日收盤尚未公布') : null,
    // 這一天有持股除權息 → 基準價用的是除權息參考價，要講出來，
    // 不然使用者會拿自己記的「昨天收盤」去對，怎麼算都對不上。
    (settled?.byCode ?? []).some((r) => r.basisSource === 'refPrice')
      ? h('p', { class: 'muted sm' }, h('span', { class: 'tag' }, '含除息調整'),
        ' 有持股在這一天除權息，基準價用證交所的除權息參考價')
      : null,
    (settled?.byCode ?? []).some((r) => r.status === 'exNoRef')
      ? h('p', { class: 'warn sm' }, '有持股在這一天除權息，但尚未取得參考價，這一檔沒有計入當日損益')
      : null,
    settled?.dividendMicro != null
      ? h('p', { class: 'muted sm' },
        settled.includeDividend === false ? '當日應收股利（未計入）' : '其中當日應收股利',
        ' ', num(fmtMoneyMicro(settled.dividendMicro)), ' 元')
      : null,
    note ? h('p', { class: 'muted sm' }, note) : null,
  );
}

function marketValueCard(settled) {
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '持股市值'),
    h('p', { class: 'mid-number' },
      num(settled?.marketValueMicro != null ? fmtMoneyMicro(settled.marketValueMicro) : NO_VALUE,
        settled?.marketValueMicro == null ? 'v-none' : '')),
  );
}

function unrealizedCard(u, held) {
  // 一檔都沒填平均成本 → 這個區塊整個不出現。顯示「—」也不行：
  // 那會讓使用者以為系統算過了但算不出來，其實是根本沒有成本可以算。
  if (u.withCost === 0) {
    if (!held.some((x) => x.supported)) return null;
    return h('section', { class: 'card', dataset: { card: 'costPrompt' } },
      h('h2', { class: 'card-title' }, '平均成本'),
      h('p', { class: 'muted sm' }, '填了平均成本之後，這裡會顯示未實現損益與報酬率。'),
      h('a', { class: 'btn', href: '#/holdings' }, '去填平均成本'),
    );
  }
  const note = partialCostNote(u);
  return h('section', { class: 'card', dataset: { card: 'unrealized' } },
    h('h2', { class: 'card-title' }, '未實現損益'),
    h('p', { class: 'mid-number' }, moneyNode(u.unrealizedMicro)),
    h('p', { class: 'muted sm' },
      '報酬率 ', num(fmtPct(u.returnRate, { sign: true })),
      '　成本 ', num(fmtMoneyMicro(u.costMicro))),
    note ? h('p', { class: 'muted sm' }, note) : null,
  );
}

function statusCard(upd, settleDate) {
  const cal = store.calendar();
  const lines = [];

  if (store.calendarError()) lines.push('開休市日尚未取得，無法判斷交易日');
  else if (cal) lines.push(`開休市日：${cal.year} 年，${cal.days.length} 個交易日`);
  if (store.catalogError()) lines.push('代號表尚未取得');

  lines.push(upd ? upd.message : '尚未更新');
  for (const p of (upd?.problems ?? []).slice(0, 3)) lines.push(p);
  lines.push(settleDate ? `最後結算：${fmtDate(settleDate)}` : '尚未結算過');
  lines.push('資料來源：臺灣證券交易所，每次開啟 App 更新一次');

  const btn = h('button', {
    class: 'btn',
    onclick: async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '更新中…';
      const r = await store.update({ force: true });
      toast(r?.message || '已更新');
      home();
    },
  }, '重新整理');

  return h('section', { class: 'card status-card' },
    h('h2', { class: 'card-title' }, '資料狀態'),
    ...lines.map((t) => h('p', { class: 'muted sm' }, t)),
    btn,
  );
}

function holdingsCard(held, settled) {
  if (held.length === 0) {
    return h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '持股'),
      h('p', { class: 'muted' }, '還沒有持股。'),
      h('a', { class: 'btn btn-primary', href: '#/holdings' }, '新增持股'),
    );
  }
  const byCode = new Map((settled?.byCode ?? []).map((r) => [r.code, r]));
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, `持股（${held.length} 檔）`),
    h('div', { class: 'rows' }, ...held.map((hd) => holdingRow(hd, byCode.get(hd.code)))),
    h('a', { class: 'btn', href: '#/holdings' }, '管理持股'),
  );
}

function holdingRow(hd, row) {
  const head = h('div', { class: 'row-head' },
    h('span', { class: 'row-code' }, hd.code),
    h('span', { class: 'row-name' }, hd.name || ''),
  );

  // 不支援報價：這一列**不建立任何 .num 節點**。
  // 股數用純文字寫，因為 num() 是「這是一個報價相關的數字」的標記，
  // 測試會斷言不支援的列裡一個 .num 都沒有。
  if (!hd.supported) {
    return h('a', { class: 'row row-unsupported', href: `#/holdings/${hd.code}`, dataset: { code: hd.code } },
      head,
      h('div', { class: 'row-side' },
        h('span', { class: 'muted sm' }, `${fmtShares(hd.shares)} 股`),
        h('span', { class: 'tag' }, STATUS_TEXT.unsupported),
      ),
    );
  }

  const status = row?.status ?? 'noClose';
  const side = status === 'ok' && row?.pl != null
    ? h('div', { class: 'row-side' }, moneyNode(BigInt(row.pl)), num(fmtPrice(row.close), 'sm'))
    : h('div', { class: 'row-side' }, h('span', { class: 'muted sm' }, STATUS_TEXT[status] ?? '尚未結算'));

  return h('a', { class: 'row', href: `#/holdings/${hd.code}`, dataset: { code: hd.code } },
    head,
    h('div', { class: 'row-mid' }, h('span', { class: 'muted sm' }, `${fmtShares(hd.shares)} 股`)),
    side,
  );
}
