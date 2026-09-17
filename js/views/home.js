// 首頁：當日損益放最上面（那是每天打開 App 的理由），其餘依序是市值、未實現、
// 資料狀態、持股明細。
//
// 畫面規則：
//   · 算不出來就寫「—」，絕不寫 0
//   · 不支援報價的持股那一列**不產生任何 .num 節點**（測試靠這個斷言）
//   · 沒有任何一檔填平均成本時，「未實現損益」整個區塊不出現（不是顯示「—」）

import { h, num, moneyNode, fmtMoneyMicro, fmtPct, fmtDate, NO_VALUE, progressLine } from '../ui.js';
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
    render([startCard(), newsCard()]);
    return;
  }

  render([
    ...pendingBanners(pendingEvents, pendingChanges),
    dayPLCard(settled, settleDate, upd, store.calendarRunway()),
    marketValueCard(settled),
    unrealizedCard(unreal, held),
    dividendCard(divSummary),
    newsCard(),
    // 資料狀態搬到設定頁，與「資料來源」合併成一區（使用者要求）。
    // 那是「偶爾想確認」的東西，不是每天要看的 —— 佔著總覽的位置只是讓人多捲。
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
/**
 * 進新聞頁的入口。
 *
 * 新聞不在底部分頁（那五格是每天一定會看的），所以它只能靠總覽上這張卡片。
 * 整張卡片本來就是連結，但使用者回報「找不到」—— 一張看起來像說明文字的卡片
 * 不像可以按的東西。給它一顆明確的按鈕（使用者要求）。
 */
function newsCard() {
  return h('section', { class: 'card', dataset: { card: 'newsEntry' } },
    h('h2', { class: 'card-title' }, '新聞'),
    h('p', { class: 'muted sm' }, '台股與國際財經標題、跟你持股有關的標記，以及今日觀察。'),
    h('a', { class: 'btn btn-primary', href: '#/news', dataset: { link: 'news' } }, '看新聞'),
  );
}

/** 有待確認的除權息事件時，首頁最上面提示一下（PLAN §2.2 第 6 點）。 */
/**
 * 待確認的提示列。**一種一條，各自帶到自己那一頁。**
 *
 * 以前是一條合併的：寫著「1 筆除權息、1 筆扣款等你確認」，但只帶去股利頁 ——
 * 而股利頁上一個通往定期定額的連結都沒有（實測過）。提示列答應了兩件事只給一件，
 * 另一半要自己想到回總覽再點一次（那時 href 才會變成 /plans）。
 * 每個月扣款日之後如果剛好也有除權息就會踩到。
 */
function pendingBanners(evts, changes) {
  const out = [];
  if (evts.length) {
    out.push(bannerRow({
      card: 'pendingBannerEvents',
      href: '#/dividends',
      title: `有 ${evts.length} 筆除權息等你確認`,
      // B：除息日 ≠ 入帳日。四個官方端點（TWT48U／TWT49U／TWT48U_ALL／
      // openapi t187ap45_L）實測都沒有現金股利發放日，所以我們只知道除息日。
      // 與其讓他以為錢已經到了，不如講清楚什麼時候再來。
      sub: '收到券商的股利通知之後再來確認就好，這筆不會消失',
    }));
  }
  if (changes.length) {
    out.push(bannerRow({
      card: 'pendingBannerChanges',
      href: '#/plans',
      title: `有 ${changes.length} 筆定期定額扣款等你確認`,
      sub: '對照券商的成交通知確認股數，確認之後才會計入持股',
    }));
  }
  return out;
}

function bannerRow({ card, href, title, sub }) {
  return h('a', { class: 'banner', href, dataset: { card } },
    h('span', { class: 'banner-icon', 'aria-hidden': 'true' }, '💰'),
    h('span', { class: 'banner-body' },
      title,
      h('span', { class: 'muted sm banner-sub' }, sub),
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

function dayPLCard(settled, settleDate, upd, runway) {
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
    // 回補中的進度。長假之後可能要補十幾天 —— 沒有這一行的話，
    // 使用者盯著一個不動的畫面，不知道它在做事還是當掉了。
    progressLine(store.progress, store.subscribe),
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
    // **日曆快用完了要先講。** 跨年當天才發現就來不及了 ——
    // 那一天起每天都只剩一句「今天不在範圍內」，而且除權息同步與
    // 定期定額待確認也會一起停掉。實測（2026-09-17）證交所的 holidaySchedule
    // 目前只有 2026 年，所以這一行是目前唯一會提醒使用者的地方。
    runway?.warn && runway.lastDay
      ? h('p', { class: 'sm warn', dataset: { note: 'calendarWarn' } },
        `開休市日只到 ${fmtDate(runway.lastDay)}（剩 ${runway.daysLeft} 天），之後會無法結算，請更新 App。`)
      : null,
    // 這裡**刻意沒有**「看每一檔的當日損益」那顆按鈕。
    // 它是 v0.7.10 加的（總覽答不出「是哪一檔」），使用者在 v0.7.11 之後
    // 明確說不要 —— 底部的「持股」分頁本來就到得了。**不要再自動加回來。**
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
    // **拿去跟券商對帳一定會差一點，先講清楚差在哪。**
    // 這裡的成本只有「成交價 × 股數」（js/avgcost.js 沒有任何手續費項，
    // PLAN 第 23 行也把手續費列為「不做的指標」）。券商庫存頁的成本慣例含買進手續費。
    // 不講的話，他每次對帳都會重新懷疑一次是不是算錯了。
    h('p', { class: 'muted sm', dataset: { note: 'costExcludesFee' } },
      '這裡的成本是你填的成交價乘上股數，沒有加手續費。'
      + '券商 App 的成本通常把買進手續費算進去，所以會比這裡高一點點，報酬率也會低一點點。'),
  );
}



