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
import * as plans from '../plans.js';
import { computeUnrealized, exclusionNote, partialCostNote, STATUS_TEXT, BASIS_SOURCE_TEXT } from '../settle.js';
import { STATUS } from '../update.js';
import { setTop, render } from '../shell.js';

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
  const pendingChanges = await plans.pendingChanges();
  const divSummary = await events.summary({ year: new Date().getFullYear() });

  // 全新裝置：三張「—」加一張資料狀態，看起來像壞掉，而且**沒有任何地方告訴你怎麼開始**
  // （實測過：那個畫面上一個帶得到持股頁的按鈕都沒有，只能自己去按底部分頁）。
  // 一筆持股、一個計畫都沒有的時候，就只講「怎麼開始」。
  const plansList = await plans.list();
  if (held.length === 0 && plansList.length === 0) {
    render([startCard(), newsCard(), statusCard(upd, settleDate)]);
    return;
  }

  render([
    pendingBanner(pendingEvents, pendingChanges),
    dayPLCard(settled, settleDate, upd),
    marketValueCard(settled),
    unrealizedCard(unreal, held),
    dividendCard(divSummary),
    newsCard(),
    statusCard(upd, settleDate),
    // 持股明細不放這裡 —— 使用者回報總覽不用再放一次，持股頁本來就有（而且更完整）。
  ].filter(Boolean));
}

/**
 * 全新裝置的第一張卡片。**只講下一步要做什麼**，不放任何「—」。
 *
 * 為什麼不直接把當日損益那幾張留著顯示「—」：一個什麼都還沒設定的人看到三個破折號，
 * 分不出是「App 壞了」「今天還沒開盤」還是「我還沒設定」。
 */
function startCard() {
  return h('section', { class: 'card', dataset: { card: 'start' } },
    h('h2', { class: 'card-title' }, '開始使用'),
    h('p', { class: 'muted' }, '加入你手上的股票之後，每天打開這一頁就會看到當日損益、市值與除權息提醒。'),
    h('a', { class: 'btn btn-primary', href: '#/holdings' }, '新增第一檔持股'),
    h('p', { class: 'muted sm' }, '只做定期定額也可以，先建一個計畫，扣款日過了就會提醒你確認。'),
    h('a', { class: 'btn', href: '#/plans' }, '建立定期定額計畫'),
  );
}

/** 進新聞頁的入口。新聞不進底部分頁（那五格是每天一定會看的），放在總覽上。 */
function newsCard() {
  return h('a', { class: 'card card-link', href: '#/news', dataset: { card: 'newsEntry' } },
    h('h2', { class: 'card-title' }, '新聞'),
    h('p', { class: 'muted sm' }, '台股與國際財經標題，只顯示標題與連結，點了到原站看。'));
}

/** 有待確認的除權息事件時，首頁最上面提示一下（PLAN §2.2 第 6 點）。 */
function pendingBanner(evts, changes) {
  if (evts.length === 0 && changes.length === 0) return null;
  // 兩種待確認都有的話，帶去除權息那一頁（股利金額比較容易忘），
  // 只有扣款的話就帶去定期定額。
  const href = evts.length ? '#/dividends' : '#/plans';
  const parts = [];
  if (evts.length) parts.push(`${evts.length} 筆除權息`);
  if (changes.length) parts.push(`${changes.length} 筆扣款`);
  return h('a', { class: 'banner', href, dataset: { card: 'pendingBanner' } },
    h('span', { class: 'banner-icon' }, '💰'),
    h('span', { class: 'banner-body' },
      `有 ${parts.join('、')}等你確認`,
      h('span', { class: 'muted sm banner-sub' }, '對照券商通知確認之後才會計入'),
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
      ? h('p', { class: 'warn sm' }, s.totalMicro == null
        ? `${s.unknown} 筆已確認但都還沒有填金額，所以加不出總計`
        : `另有 ${s.unknown} 筆已確認但沒有填金額，不計入總計`)
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
    // 而且要分得出參考價是證交所公布的、還是我們依公式推導的。
    ...exAdjustmentNotes(settled),
    settled?.dividendMicro != null
      ? h('p', { class: 'muted sm' },
        settled.includeDividend === false ? '當日應收股利（未計入）' : '其中當日應收股利',
        ' ', num(fmtMoneyMicro(settled.dividendMicro)), ' 元')
      : null,
    note ? h('p', { class: 'muted sm' }, note) : null,
  );
}

/**
 * 除權息調整的說明。證交所公布的與我們推導的**分開講**——
 * 推導的那筆使用者拿去跟證交所網站對的時候，數字理論上一樣，
 * 但它有權利知道這個數字不是證交所直接給的。
 */
function exAdjustmentNotes(settled) {
  const rows = settled?.byCode ?? [];
  const out = [];
  if (rows.some((r) => r.basisSource === 'refPrice')) {
    out.push(h('p', { class: 'muted sm' },
      h('span', { class: 'tag' }, BASIS_SOURCE_TEXT.refPrice),
      ' 有持股在這一天除權息，基準價用證交所公布的除權息參考價'));
  }
  const derived = rows.filter((r) => r.basisSource === 'refPriceDerived');
  if (derived.length) {
    out.push(h('p', { class: 'muted sm' },
      h('span', { class: 'tag tag-warn' }, BASIS_SOURCE_TEXT.refPriceDerived),
      ` ${derived.map((r) => r.code).join('、')} 的參考價證交所已經查不到了（結果表只留最近一次），`,
      '這裡的基準價是依證交所公式試算的'));
  }
  if (rows.some((r) => r.status === 'exNoRef')) {
    out.push(h('p', { class: 'warn sm' },
      '有持股在這一天除權息，但參考價既查不到也算不出來，這一檔沒有計入當日損益'));
  }
  return out;
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


