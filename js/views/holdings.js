// 持股管理：新增、平均成本、進單檔詳情。
//
// 新增流程照 PLAN §2.4：
//   上市     → 直接加
//   上櫃／興櫃 → 明講不支援，問要不要「仍然記錄股數（不計損益）」
//   查不到   → 講清楚代號表的日期，不要只說「錯誤」

import { h, num, fmtShares, fmtPrice, fmtMoneyMicro, fmtDate, fmtPct, moneyNode, toast, modal, confirmDialog } from '../ui.js';
import * as holdings from '../holdings.js';
import * as catalog from '../catalog.js';
import * as store from '../store.js';
import { STATUS_TEXT } from '../settle.js';
import { setTop, render } from '../shell.js';
import { localISODate } from '../roc.js';
import * as concentration from '../concentration.js';

// 「已出清」的那幾檔要不要展開。**不寫進設定** —— 那是當下想看什麼，
// 不是長期偏好；下次進來從「收起來」開始才合理（跟新聞頁的個股篩選同一個判斷）。
let showClosed = false;

export default async function holdingsView() {
  setTop({ title: '持股' });
  const all = await holdings.list();
  // 賣光的那幾檔**預設不顯示**：出清了就不該佔版面，而且 0 股旁邊擺一個均價
  // 是個沒有意義的數字（實測過「2330 台積電 0 股 均價 500.00」）。
  // 但也不能讓它憑空消失 —— 下面會講「另有 N 檔已出清」，按一下就看得到。
  const held = all.filter((x) => Number(x.shares) > 0);
  const closed = all.filter((x) => !(Number(x.shares) > 0));

  // 集中度用最後一次結算的收盤價算，跟首頁的未實現損益同一個來源。
  const settled = await store.latestSettle();
  const quotes = {};
  for (const row of settled?.byCode ?? []) if (row.close != null) quotes[row.code] = { close: row.close };
  // type 也要帶進去 —— 產業分布要分得出「ETF（本來就沒有產業別）」與「查不到產業」。
  // 產業分布只看還有股數的 —— 出清的檔丟進去只會變成「以下 N 檔不計入（沒有股數）」的雜訊
  const withIndustry = held.map((hd) => {
    const info = catalog.lookup(hd.code);
    return { ...hd, industry: info?.industry ?? null, type: info?.type ?? null };
  });

  // 每一檔那一天的損益，用來回答「總覽上那個當日損益是哪幾檔造成的」——
  // 以前只有進單檔詳情才看得到，每天盤後最常走的那條路到這裡就斷了。
  const plByCode = new Map((settled?.byCode ?? []).map((r) => [r.code, r]));

  // 順序：目前持股在最上面（每天打開最想看的），產業分布與兩個入口放它下面。
  // 使用者實機回報原本「新增持股」「定期定額」擋在持股前面，每次都要往下捲；
  // 產業分布後來又擠到持股上面去了，一樣要往下捲才看得到持股。
  render([
    held.length === 0
      ? h('section', { class: 'card', dataset: { card: 'holdingsList' } },
        h('h2', { class: 'card-title' }, '目前持股'),
        h('p', { class: 'muted' }, closed.length
          ? '目前沒有還持有的股票。'
          : '還沒有持股。用下面的「新增一檔」開始。'),
        ...closedBlock(closed))
      : h('section', { class: 'card', dataset: { card: 'holdingsList' } },
        h('h2', { class: 'card-title' }, `目前持股（${held.length} 檔）`),
        // **哪一天**要寫出來。沒寫的話，收盤還沒公布的日子看到的是昨天的數字，
        // 而使用者以為是今天的。
        h('p', { class: 'muted sm' }, settled?.date
          ? `下面的當日損益是 ${fmtDate(settled.date)} 收盤結算的`
          : '還沒有結算過，所以沒有當日損益'),
        h('div', { class: 'rows' }, ...held.map((hd) => manageRow(hd, plByCode.get(hd.code)))),
        ...closedBlock(closed),
      ),
    concentrationCard(withIndustry, quotes),
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

/**
 * 「另有 N 檔已出清」。
 *
 * 出清的檔**預設收起來**，但一定要讓他知道歷史還在 —— 直接消失的話，
 * 他會以為資料掉了（這個 App 沒有雲端，任何「東西不見了」都很嚇人）。
 * 點開之後那幾列只顯示代號、名稱與「已出清」，**不顯示均價**：
 * 0 股配一個均價是沒有意義的數字。點進去仍然看得到完整的變動紀錄。
 */
function closedBlock(closed) {
  if (closed.length === 0) return [];
  const toggle = h('button', {
    class: 'btn btn-sm',
    dataset: { toggle: 'closedHoldings' },
    'aria-expanded': String(showClosed),
    onclick: () => { showClosed = !showClosed; holdingsView(); },
  }, showClosed ? '收起來' : `看這 ${closed.length} 檔`);

  return [
    h('p', { class: 'muted sm', dataset: { note: 'closedCount' } },
      `另有 ${closed.length} 檔已出清（0 股）。紀錄還在，點進去看得到當初的買賣。`),
    toggle,
    showClosed
      ? h('div', { class: 'rows', dataset: { block: 'closedRows' } }, ...closed.map((hd) =>
        h('a', { class: 'row row-holding', href: `#/holdings/${hd.code}`, dataset: { code: hd.code, closed: '1' } },
          h('div', { class: 'row-head' },
            h('span', { class: 'row-code' }, hd.code),
            h('span', { class: 'row-name' }, hd.name || '')),
          h('div', { class: 'row-mid' }, h('span', { class: 'muted sm' }, '0 股')),
          h('div', { class: 'row-side' }, h('span', { class: 'tag' }, '已出清')))))
      : null,
  ].filter(Boolean);
}

function manageRow(hd, plRow) {
  const head = h('div', { class: 'row-head' },
    h('span', { class: 'row-code' }, hd.code),
    h('span', { class: 'row-name' }, hd.name || ''),
    hd.industry ? h('span', { class: 'tag' }, hd.industry) : null,
  );

  // 不支援報價的持股：這一列不建立任何 .num 節點
  if (!hd.supported) {
    // 不支援報價的列也走同一套格線，不然它會跟上下兩列對不齊。
    // 右欄放「不支援報價」的標籤 —— 那一格本來就是「這一檔今天怎麼樣」。
    return h('a', { class: 'row row-holding row-unsupported', href: `#/holdings/${hd.code}`, dataset: { code: hd.code } },
      head,
      h('div', { class: 'row-mid' }, h('span', { class: 'muted sm' }, `${fmtShares(hd.shares)} 股`)),
      h('div', { class: 'row-side' },
        h('span', { class: 'tag' }, STATUS_TEXT.unsupported),
      ),
    );
  }

  return h('a', { class: 'row row-holding', href: `#/holdings/${hd.code}`, dataset: { code: hd.code } },
    head,
    h('div', { class: 'row-mid' },
      h('span', { class: 'muted sm row-shares' }, `${fmtShares(hd.shares)} 股`),
      hd.avgCost != null
        ? h('span', { class: 'muted sm row-avg' }, '　均價 ', num(fmtPrice(hd.avgCost)))
        : h('span', { class: 'muted sm row-avg' }, '　未填均價'),
    ),
    h('div', { class: 'row-side' }, ...dayPLParts(plRow)),
  );
}

/**
 * 一列右邊的「當日損益」。
 *
 * 算不出來就**寫出算不出來的原因**（尚未取得收盤價、除權息日還沒有參考價…），
 * 不要留白也不要寫 0 —— 使用者分不出「沒漲沒跌」與「我們不知道」。
 *
 * 漲跌％用結算紀錄裡的 close 與 basis 算，basis 在除權息日是**參考價**，
 * 所以除息日不會冒出一個等於息值的假跌幅。
 */
function dayPLParts(r) {
  if (!r) return [h('span', { class: 'muted sm' }, '尚未結算')];
  if (r.status !== 'ok' || r.pl == null) {
    return [h('span', { class: 'muted sm' }, STATUS_TEXT[r.status] ?? '沒有當日損益')];
  }
  // fmtPct 收的是**百分比數字**（12.34 → 12.34%），不是比例（0.1234）。
  // 直接把比例丟進去的話 −1.33% 會顯示成 −0.01%，而且看起來很正常。
  const pct = Number.isFinite(r.close) && Number.isFinite(r.basis) && r.basis !== 0
    ? ((r.close - r.basis) / r.basis) * 100
    : null;
  return [
    moneyNode(BigInt(r.pl)),
    h('span', { class: 'muted sm' }, pct == null ? '　—' : `　${fmtPct(pct, { sign: true })}`),
  ];
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
