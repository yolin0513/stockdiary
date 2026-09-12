// 定期定額試算器（PLAN §6）。
//
// 這一頁的規則，每一條都是產品決定，不是風格：
//   · **所有數值欄位預設空白。** 沒有預設值、沒有範例值、沒有 placeholder 裡的數字。
//     一旦畫面上先出現一個數字，使用者就會把它當成我們認為合理的值 —— 那是投資判斷。
//   · placeholder 只說「這一格要填什麼」，不說「大概填多少」。
//   · 兩個情境叫「你的假設 A／B」，不叫任何帶方向的名字。
//   · AI 完全不介入這一頁。
//   · 頁首固定一句話：結果由你輸入的假設算出，不是預測。
//
// 測試（scripts/calcviewtest.mjs）會掃整頁的文字**與屬性**，禁用詞一個都不能出現。

import { h, num, fmtMoneyMicro, toast, switchRow, NO_VALUE } from '../ui.js';
import {
  validateInputs,
  CONTRIB_FREQ, DIVIDEND_FREQ, DIVIDEND_FREQ_LABEL, MAX_FEE_RATE, compareMulti,
} from '../calc.js';
import { setTop, render } from '../shell.js';
import * as divrecord from '../divrecord.js';
import * as events from '../events.js';
import * as catalog from '../catalog.js';
import * as holdings from '../holdings.js';
import * as plans from '../plans.js';
import * as store from '../store.js';

const DISCLAIMER = '以下結果完全由你輸入的假設算出，不是預測，也不是投資判斷。';

// 畫面狀態。**每一個數值欄位的初始值都是空字串。**
const state = {
  amount: '', perMonth: 1, years: '', growthRate: '', yieldRate: '',
  dividendFreq: 1, feeRate: '', startValue: '', dividendFees: false,
  method: 'value', price: '',
  errors: {},
  // 「查這一檔過去配了多少」。**跟試算完全分離**：查到的數字不會、也不能
  // 流進上面任何一個欄位。看完之後要不要採用、採用什麼數字，是使用者的決定。
  lookupCode: '', lookup: null, lookupErr: '', holdings: [],
  // 「從你的資料帶入」用的。plans／settle 都是**他自己已經設定或已經發生的事實**，
  // 不是對未來的假設 —— 這條界線決定了什麼能帶、什麼不能帶（見 filledFrom）。
  plans: [], settle: null,
  // 每一檔各自的假設。0050、0056、00878、2330 的性質差很多，
  // 用同一組成長率與配息率算出來的東西沒有意義（使用者自己提的）。
  // 每一列：{ code, name, amount, startValue, growthRate, yieldRate, price }
  legs: [],
  multi: null,
  filled: null,      // { label, fields: [...] } —— 帶入之後講清楚帶了什麼
};

export default async function calcView() {
  setTop({ title: '定期定額試算' });
  // 配息紀錄是同源的靜態檔（data/dividends.json），讀不到就讓那張卡自己說，
  // 不要讓整頁打不開 —— 試算器本身不需要它。
  try { await divrecord.load(); } catch (e) { state.lookupErr = String(e.message || e); }
  // 直接把他的持股列出來當按鈕 —— 他不該需要先知道哪一檔查得到。
  try { state.holdings = await holdings.list(); } catch { state.holdings = []; }
  try { state.plans = await plans.list(); } catch { state.plans = []; }
  try { state.settle = await store.latestSettle(); } catch { state.settle = null; }
  if (state.legs.length === 0) state.legs = defaultLegs();
  paint();
}

/**
 * 預設的標的清單：有計畫的排前面，其餘持股跟在後面。
 *
 * **只鋪出「哪幾檔」，不填任何數字。** 金額與市值要按「從你自己的資料帶入」
 * 才會進來；成長率與配息率永遠要他自己填（那是對未來的假設）。
 */
/** 代號表認得的 ETF。data/stocks.json 的 type 欄位分得出來（實測 360 檔 ETF）。 */
function isETF(code) {
  return catalog.lookup(code)?.type === 'ETF';
}

function newLeg(code, name) {
  return { code, name: name ?? '', amount: '', startValue: '', growthRate: '', yieldRate: '', price: '' };
}

/**
 * 這一頁要列哪幾檔（使用者要求：**只列 ETF**）。
 *
 * 定期定額最常見的就是 ETF，而個股與 ETF 的假設差很多、放在一起只是雜訊。
 * 代號表的 type 欄位分得出來（實測 360 檔 ETF），所以照 ETF 篩。
 * 萬一代號表壞掉、一檔 ETF 都認不出來，就退回「只列有定期定額計畫的」——
 * 那是使用者指定的備案，不要在這時候把全部持股倒出來。
 */
function defaultLegs() {
  const seen = new Set();
  const etfs = [];
  const planned = [];

  for (const pl of state.plans.filter((x) => x.active)) {
    if (seen.has(pl.code)) continue;
    seen.add(pl.code);
    const info = catalog.lookup(pl.code);
    const leg = newLeg(pl.code, info.found ? info.name : '');
    planned.push(leg);
    if (isETF(pl.code)) etfs.push(leg);
  }
  for (const hd of state.holdings) {
    if (seen.has(hd.code) || !hd.supported) continue;
    seen.add(hd.code);
    if (isETF(hd.code)) etfs.push(newLeg(hd.code, hd.name ?? ''));
  }
  return etfs.length ? etfs : planned;
}

function paint() {
  render([
    h('section', { class: 'card', dataset: { card: 'calcDisclaimer' } },
      h('p', { class: 'disclaimer' }, DISCLAIMER),
      h('p', { class: 'muted sm' },
        '年化成長率以複利換算到每個月；年化配息率以年率除以配息次數。' +
        '這裡的每一個數字都是你填的假設，不是任何形式的預測。'),
    ),
    prefillCard(),
    legsCard(),
    inputCard(),
    dividendLookupCard(),
    state.multi && state.multi.total ? multiResultCard(state.multi) : null,
    state.multi && state.multi.total ? yearlyCard(state.multi.total.yearly) : null,
  ].filter(Boolean));
}

// ---------- 從你自己的資料帶入 ----------
//
// **界線：只帶事實，不帶假設。**
//   帶：每期扣款金額、每月扣款次數、手續費率（都是他在定期定額裡自己設的）、
//       目前部位市值與目前股價（都是已經發生的結算結果）
//   不帶：年化成長率、年化配息率 —— 那兩個是對未來的假設。
//       給了預設值就等於我們替他預測，而且他會把那個數字當成我們認為合理的值。
//
// 帶完之後畫面會列出「帶了哪幾格」與「哪兩格沒帶、為什麼」，
// 不要讓他以為整張表都填好了。

/** 某一檔在最後一次結算裡的收盤價與市值（沒有就回 null，不猜）。 */
function positionOf(code) {
  const row = (state.settle?.byCode ?? []).find((r) => r.code === code);
  if (!row || row.status !== 'ok' || !Number.isFinite(row.close)) return null;
  const hd = state.holdings.find((h2) => h2.code === code);
  const shares = Number(hd?.shares);
  return {
    close: row.close,
    marketValue: Number.isFinite(shares) && shares > 0 ? Math.round(row.close * shares) : null,
  };
}

/** 全部持股在最後一次結算的市值合計（算不出來的檔就不算，並回報漏了幾檔）。 */
function totalPosition() {
  const rows = (state.settle?.byCode ?? []).filter((r) => r.status === 'ok' && Number.isFinite(r.close));
  let total = 0;
  let counted = 0;
  for (const r of rows) {
    const hd = state.holdings.find((h2) => h2.code === r.code);
    const shares = Number(hd?.shares);
    if (!Number.isFinite(shares) || shares <= 0) continue;
    total += r.close * shares;
    counted += 1;
  }
  const excluded = state.holdings.filter((h2) => h2.supported).length - counted;
  return counted > 0 ? { marketValue: Math.round(total), counted, excluded } : null;
}

/** 把帶入的數字寫進對應的那一列（沒有那一列就補一列）。 */
function legFor(code) {
  let leg = state.legs.find((x) => x.code === code);
  if (!leg) {
    const info = catalog.lookup(code);
    leg = { code, name: info.found ? info.name : '', amount: '', startValue: '', growthRate: '', yieldRate: '', price: '' };
    state.legs.push(leg);
  }
  return leg;
}

function fillFromPlan(plan) {
  const pos = positionOf(plan.code);
  const fields = [];
  // 選了某一檔，下面就**只留那一檔**（使用者要求）。
  // 全部列出來的話，他得自己一檔一檔按「不算這一檔」才能只試算一檔。
  // 想看全部就按「全部持股與計畫」那一顆。
  state.legs = [legFor(plan.code)];
  state.multi = null;
  const leg = state.legs[0];
  leg.amount = String(plan.amount);
  state.amount = String(plan.amount);
  fields.push(`每期扣款金額 ${plan.amount.toLocaleString('zh-Hant-TW')} 元`);
  if (CONTRIB_FREQ.includes(plan.days.length)) {
    state.perMonth = plan.days.length;
    fields.push(`每月扣款 ${plan.days.length} 次`);
  }
  if (plan.feeRate) {
    state.feeRate = String(plan.feeRate);
    fields.push(`手續費率 ${(plan.feeRate * 100).toFixed(4)}%`);
  }
  if (pos?.marketValue != null) {
    leg.startValue = String(pos.marketValue);
    state.startValue = String(pos.marketValue);
    fields.push(`目前部位市值 ${pos.marketValue.toLocaleString('zh-Hant-TW')} 元`);
  }
  if (pos?.close != null) {
    leg.price = String(pos.close);
    state.price = String(pos.close);
    fields.push(`目前股價 ${pos.close}`);
  }
  const info = catalog.lookup(plan.code);
  state.filled = { label: `${plan.code} ${info.found ? info.name : ''}`, fields };
  paint();
}

function fillFromAll() {
  const t = totalPosition();
  const fields = [];
  // 按「全部」就把清單還原 —— 上面「選一檔」會把 legs 縮成一檔
  state.legs = defaultLegs();
  state.multi = null;
  // 每一檔各自帶自己的 —— 不要把所有人的金額加成一筆，那就失去分開設定的意義
  // **只填已經在清單裡的那幾檔**，不要用 legFor() 把不在清單裡的補進來 ——
  // 那會把被 ETF 篩掉的個股又加回去（踩過：按「全部」之後 2330、2317 冒出來）。
  const byCode = new Map(state.legs.map((l) => [l.code, l]));
  for (const pl of state.plans.filter((x) => x.active)) {
    const leg = byCode.get(pl.code);
    if (leg) leg.amount = String(pl.amount);
  }
  for (const leg of state.legs) {
    const pos = positionOf(leg.code);
    if (pos?.marketValue != null) leg.startValue = String(pos.marketValue);
    if (pos?.close != null) leg.price = String(pos.close);
  }
  fields.push(`${state.legs.length} 檔各自帶入自己的扣款金額、目前市值與收盤價`);
  if (t) {
    state.startValue = String(t.marketValue);
    fields.push(`目前部位市值 ${t.marketValue.toLocaleString('zh-Hant-TW')} 元（${t.counted} 檔合計`
      + `${t.excluded > 0 ? `，另有 ${t.excluded} 檔算不出市值沒有計入` : ''}）`);
  }
  const active = state.plans.filter((x) => x.active);
  const sum = active.reduce((a, b) => a + (Number(b.amount) || 0) * (b.days?.length || 1), 0);
  if (sum > 0) {
    state.amount = String(sum);
    state.perMonth = 1;
    fields.push(`每期扣款金額 ${sum.toLocaleString('zh-Hant-TW')} 元（${active.length} 個計畫每月合計）`);
  }
  state.filled = { label: '全部持股與計畫', fields };
  paint();
}

function prefillCard() {
  const active = state.plans.filter((x) => x.active);
  const hasAny = active.length > 0 || (state.settle?.byCode ?? []).length > 0;
  if (!hasAny) return null;

  const buttons = active.map((plan) => {
    const info = catalog.lookup(plan.code);
    return h('button', {
      class: 'chip',
      dataset: { prefill: plan.code },
      onclick: () => fillFromPlan(plan),
    }, `${plan.code} ${info.found ? info.name : ''}　每次 ${plan.amount.toLocaleString('zh-Hant-TW')} 元`);
  });
  if (totalPosition()) {
    buttons.push(h('button', { class: 'chip', dataset: { prefill: 'all' }, onclick: fillFromAll }, '全部持股與計畫'));
  }

  return h('section', { class: 'card', dataset: { card: 'calcPrefill' } },
    h('h2', { class: 'card-title' }, '從你自己的資料帶入'),
    h('p', { class: 'muted sm' },
      '按一下就把你已經設定好的金額、扣款次數、手續費率，'
      + '以及最後一次結算的市值與收盤價填進下面的欄位，不必重打一遍。'),
    h('div', { class: 'chip-row' }, ...buttons),
    state.filled
      ? h('div', { dataset: { block: 'prefillDone' } },
        h('p', { class: 'sm' }, `已帶入（${state.filled.label}）：`),
        ...state.filled.fields.map((t) => h('p', { class: 'muted sm' }, `· ${t}`)),
        // **這一段是重點**：講清楚哪兩格沒有帶、為什麼。
        h('p', { class: 'warn sm', dataset: { note: 'prefillNotFilled' } },
          // 這句話本身不可以出現「建議」兩個字 —— 就算是「不會給建議值」也不行。
          // 掃描器只看字面，而且畫面上出現那兩個字本來就容易被誤讀。
          '沒有帶入：年化價格成長率、年化配息率。那兩個是對未來的假設，'
          + '只有你能決定要用什麼數字 —— 這個 App 不會替你填，也不會給任何參考數字。'))
      : h('p', { class: 'muted sm' }, '帶入之後，成長率與配息率仍然要你自己填。'),
    state.settle?.date
      ? h('p', { class: 'muted sm' }, `市值與股價來自 ${state.settle.date} 的結算。`)
      : null,
  );
}

// ---------- 輸入 ----------

function field({ key, label, hint, inputmode = 'decimal', suffix }) {
  const input = h('input', {
    class: 'field' + (state.errors[key] ? ' field-error' : ''),
    type: 'text',
    inputmode,
    // placeholder 只說明格式，**不給數字**
    placeholder: '',
    value: state[key],
    dataset: { calcField: key },
    oninput: (e) => { state[key] = e.target.value; },
  });
  return h('div', { class: 'calc-field' },
    h('label', { class: 'sm muted' }, label, suffix ? h('span', { class: 'muted' }, `（${suffix}）`) : null),
    input,
    hint ? h('p', { class: 'muted sm' }, hint) : null,
    state.errors[key] ? h('p', { class: 'warn sm' }, state.errors[key]) : null,
  );
}

function chips({ key, options, label, hint }) {
  return h('div', { class: 'calc-field' },
    h('label', { class: 'sm muted' }, label),
    h('div', { class: 'chip-row' }, ...options.map((o) =>
      h('button', {
        class: 'chip' + (state[key] === o.value ? ' on' : ''),
        dataset: { calcChip: `${key}:${o.value}` },
        onclick: () => { state[key] = o.value; paint(); },
      }, o.label))),
    hint ? h('p', { class: 'muted sm' }, hint) : null,
    state.errors[key] ? h('p', { class: 'warn sm' }, state.errors[key]) : null,
  );
}

function toggle({ key, label, hint }) {
  const on = state[key] === true;
  // 共用的切換開關（js/ui.js）—— 跟設定頁、定期定額同一套。
  return switchRow({
    label,
    hint,
    checked: on,
    onChange: () => { state[key] = !on; paint(); },
  });
}

/**
 * 手續費率欄位。跟定期定額那一頁**同一套行為**：當場換算成「這一次會收幾元」。
 *
 * 同一個單位陷阱在兩個地方，行為卻不一樣的話，使用者在其中一頁學到的東西
 * 到另一頁就不成立了。這裡也擋 1%，訊息也一樣。
 */
function feeField() {
  const wrap = field({
    key: 'feeRate',
    label: '扣款手續費率',
    hint: '用小數填，例如 0.001425 代表 0.1425%。不填就是不扣。',
  });
  const note = h('p', { class: 'muted sm', dataset: { hint: 'calcFeeRate' } }, '');
  const paintNote = () => {
    const raw = String(state.feeRate).replace(/,/g, '').trim();
    if (raw === '') { note.className = 'muted sm'; note.replaceChildren(''); return; }
    const f = Number(raw);
    if (!Number.isFinite(f) || f < 0) {
      note.className = 'warn sm';
      note.replaceChildren('手續費率要是不小於零的數字。');
      return;
    }
    if (f > MAX_FEE_RATE) {
      note.className = 'warn sm';
      note.replaceChildren(`${raw} 代表 ${(f * 100).toFixed(4)}%，看起來是把百分比直接填進來了。`
        + '券商說的「0.1425%」要填 0.001425。');
      return;
    }
    note.className = 'muted sm';
    const amt = Number(String(state.amount).replace(/,/g, '').trim());
    note.replaceChildren(`${raw} ＝ ${(f * 100).toFixed(4)}%`
      + (Number.isFinite(amt) && amt > 0
        ? `，每期扣款 ${amt.toLocaleString('zh-Hant-TW')} 元會收 ${(amt * f).toFixed(2)} 元`
        : `，每 10,000 元收 ${(10000 * f).toFixed(2)} 元`));
  };
  const input = wrap.querySelector('input');
  input.addEventListener('input', paintNote);
  paintNote();
  wrap.append(note);
  return wrap;
}

/**
 * 為什麼這兩格沒有「長期平均」可以參考 —— 兩個原因都不一樣，所以分開講。
 *
 * 這是查證之後的結論，不是省事：
 *
 * 配息率：證交所公開的股利分派資料（openapi t187ap45_L）只涵蓋上市**公司**
 *   877 檔、**0 檔 ETF**，而且只有民國 114–115 兩個年度（每檔平均 1.0 筆）。
 *   他的 0050／0056／00878 一筆都沒有。
 *
 * 成長率：STOCK_DAY 的歷史收盤價**沒有還原分割與配息**。實測 0050 在
 *   114/06/18 從 188.65 變成 47.57（1:4 分割），直接拿兩點相除算出來的
 *   五年年化是 −5.25% —— **連正負號都是錯的**。證交所只還原「當天的漲跌」
 *   （那一天的漲跌價差欄寫 +0.41），不還原收盤價序列，而分割比例又不在除權息表裡。
 *
 * 所以兩格都不給參考值。**寧可空白，也不要給一個錯得看不出來的數字** ——
 * 它會直接乘進試算結果裡。
 */
function whyNoReference(kind) {
  if (kind === 'yield') {
    return h('p', { class: 'muted sm', dataset: { note: 'noYieldReference' } },
      '算不出長期平均。證交所公開的股利分派資料只涵蓋上市公司，不含 ETF，'
      + '而且只有兩個年度 —— 你的 ETF 一筆都查不到。'
      + '你在「股利」頁確認過的紀錄會累積起來，那是你真正領到的錢。');
  }
  return h('p', { class: 'muted sm', dataset: { note: 'noGrowthReference' } },
    '算不出長期平均。證交所的歷史收盤價沒有還原分割與配息 —— '
    + '例如 0050 在 2025 年做過 1:4 分割，收盤價一天之內從 188.65 變成 47.57，'
    + '直接拿前後兩個價格相除會算出一個連正負號都相反的數字。');
}

/** 一檔一列的假設。數值欄位一律空白，沒有預設值。 */
function legCard(leg, i) {
  const f = (key, label, opts = {}) => {
    const input = h('input', {
      class: 'field',
      type: 'text',
      inputmode: opts.inputmode ?? 'decimal',
      placeholder: '',
      value: leg[key] ?? '',
      dataset: { legField: `${leg.code}:${key}` },
      oninput: (e) => { leg[key] = e.target.value; },
    });
    return h('div', { class: 'calc-field' },
      h('label', { class: 'sm muted' }, label, opts.suffix ? h('span', { class: 'muted' }, `（${opts.suffix}）`) : null),
      input,
      opts.note ?? null);
  };

  return h('div', { class: 'card card-sub', dataset: { leg: leg.code } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, leg.code),
      h('span', { class: 'row-name' }, leg.name || ''),
      h('button', {
        class: 'btn btn-sm',
        dataset: { removeLeg: leg.code },
        onclick: () => { state.legs.splice(i, 1); state.multi = null; paint(); },
      }, '不算這一檔'),
    ),
    f('amount', '每期扣款金額', { suffix: '元', inputmode: 'numeric' }),
    f('startValue', '目前已有部位的市值', { suffix: '元', inputmode: 'numeric' }),
    f('growthRate', '年化價格成長率', { suffix: '%', note: whyNoReference('growth') }),
    f('yieldRate', '年化配息率', { suffix: '%', note: whyNoReference('yield') }),
    state.method === 'share' ? f('price', '目前股價', { suffix: '元' }) : null,
  );
}

function legsCard() {
  return h('section', { class: 'card', dataset: { card: 'calcLegs' } },
    h('h2', { class: 'card-title' }, `每一檔各自的假設（${state.legs.length} 檔）`),
    h('p', { class: 'muted sm' },
      '每一檔的成長率與配息率分開填 —— 市值型與高股息的性質不一樣，'
      + '用同一組數字算出來的東西沒有意義。'),
    h('p', { class: 'muted sm', dataset: { note: 'legsScope' } },
      '這裡只列 ETF。要只算其中一檔，按上面那一檔的按鈕就好。'),
    h('p', { class: 'muted sm' },
      // 畫面字串裡不可以有 markdown 記號（h() 全是 textNode，星號會原樣印出來）
      '沒填完的那一檔不會被算進去，也不會被當成 0 —— 空白代表還沒決定。'),
    ...state.legs.map((leg, i) => legCard(leg, i)),
    state.legs.length === 0
      ? h('p', { class: 'muted' }, '還沒有標的。先到「持股」或「定期定額」建立，再回來試算。')
      : null,
  );
}

function inputCard() {
  return h('section', { class: 'card', dataset: { card: 'calcInputs' } },
    // 每檔都一樣的設定放這裡；每檔不一樣的（金額、市值、成長率、配息率、股價）
    // 在上面那張「每一檔各自的假設」。
    h('h2', { class: 'card-title' }, '共用設定'),
    h('p', { class: 'muted sm' }, '這幾項每一檔都套用同一個值。'),
    chips({
      key: 'perMonth', label: '每月扣款次數',
      options: CONTRIB_FREQ.map((n) => ({ value: n, label: `${n} 次` })),
    }),
    field({ key: 'years', label: '期間', suffix: '年', inputmode: 'numeric' }),
    chips({
      key: 'dividendFreq', label: '配息頻率',
      options: DIVIDEND_FREQ.map((n) => ({ value: n, label: DIVIDEND_FREQ_LABEL[n] })),
    }),

    h('h2', { class: 'card-title', style: 'margin-top:12px' }, '選填'),
    feeField(),
    toggle({
      key: 'dividendFees',
      label: '股利扣匯費與補充保費',
      hint: '開啟後每筆配息扣匯費 10 元；單筆達 20,000 元再扣 2.11%。',
    }),

    h('h2', { class: 'card-title', style: 'margin-top:12px' }, '算法'),
    chips({
      key: 'method', label: '零股與未滿一股',
      options: [
        { value: 'value', label: '金額法' },
        { value: 'share', label: '股數法' },
      ],
      hint: state.method === 'value'
        ? '金額法：市值直接乘上成長率與配息率，全程高精度小數，不管買不買得到整股。'
        : '股數法：每期用可用現金買整數股，買不足一股的餘額結轉到下一期，不捨棄也不四捨五入。',
    }),
    h('button', { class: 'btn btn-primary', onclick: compute }, '算一次'),
    h('button', { class: 'btn', onclick: reset }, '全部清空'),
  );
}

function compute() {
  // 共用設定的錯誤仍然照舊驗（期間、次數、頻率、費率）。
  // 每一檔自己的欄位由 compareMulti 判斷 —— 沒填完的那一檔不算，而且會被列出來。
  const probe = validateInputs({
    ...state,
    // 這三個在共用設定裡已經沒有欄位了，借一組能過的值來驗其餘的共用項
    amount: '0', growthRate: '0', yieldRate: '0',
  });
  state.errors = {};
  for (const k of ['years', 'perMonth', 'dividendFreq', 'feeRate']) {
    if (probe.errors[k]) state.errors[k] = probe.errors[k];
  }
  if (Object.keys(state.errors).length) {
    state.multi = null;
    paint();
    toast('共用設定還有欄位沒填好');
    return;
  }

  const shared = {
    years: probe.values.years,
    perMonth: probe.values.perMonth,
    dividendFreq: probe.values.dividendFreq,
    feeRate: probe.values.feeRate,
    dividendFees: !!state.dividendFees,
    method: state.method,
  };
  state.multi = compareMulti(state.legs, shared);
  if (state.multi.rows.length === 0) {
    paint();
    toast('每一檔都還沒填完，沒有東西可以算');
    return;
  }
  paint();
  requestAnimationFrame(() => {
    document.querySelector('#view [data-card="calcResult"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function reset() {
  for (const k of ['amount', 'years', 'growthRate', 'yieldRate', 'feeRate', 'startValue', 'price']) state[k] = '';
  for (const leg of state.legs) {
    for (const k of ['amount', 'startValue', 'growthRate', 'yieldRate', 'price']) leg[k] = '';
  }
  state.perMonth = 1;
  state.dividendFreq = 1;
  state.dividendFees = false;
  state.method = 'value';
  state.multi = null;
  state.filled = null;
  paint();
}

function kv(label, micro) {
  return h('div', { class: 'kv-row' },
    h('span', { class: 'muted sm' }, label),
    num(fmtMoneyMicro(micro)),
  );
}

function multiResultCard(multi) {
  const yuan = (m) => (m == null ? NO_VALUE : fmtMoneyMicro(m));
  const legRow = (r) => h('div', { class: 'row row-holding', dataset: { resultCode: r.code } },
    h('div', { class: 'row-head' },
      h('span', { class: 'row-code' }, r.code),
      h('span', { class: 'row-name' }, r.name || ''),
      r.usedMethod !== multi.rows[0].usedMethod ? null : null,
    ),
    h('div', { class: 'row-mid' },
      h('span', { class: 'muted sm' }, '投入 ', num(yuan(r.reinvest.investedMicro)))),
    h('div', { class: 'row-side' },
      num(yuan(r.reinvest.totalEndMicro)),
      h('span', { class: 'muted sm' }, '配息領現 ', num(yuan(r.payout.totalEndMicro)))),
  );

  return h('section', { class: 'card', dataset: { card: 'calcResult' } },
    h('h2', { class: 'card-title' }, `結果（${multi.total.counted} 檔）`),
    h('p', { class: 'disclaimer' }, DISCLAIMER),

    h('h3', { class: 'sub-title' }, '全部加起來'),
    h('div', { class: 'scenarios' },
      h('div', { class: 'scenario' },
        h('h3', { class: 'scenario-title' }, '你的假設 A'),
        h('p', { class: 'muted sm' }, '配息再投入'),
        h('p', { class: 'mid-number' }, num(yuan(multi.total.reinvest.totalEndMicro))),
        h('p', { class: 'muted sm' }, '期末手上總共（元）'),
        h('div', { class: 'kv' },
          kv('累積投入', multi.total.reinvest.investedMicro),
          kv('累積配息（毛額）', multi.total.reinvest.dividendTotalMicro)),
      ),
      h('div', { class: 'scenario' },
        h('h3', { class: 'scenario-title' }, '你的假設 B'),
        h('p', { class: 'muted sm' }, '配息領現'),
        h('p', { class: 'mid-number' }, num(yuan(multi.total.payout.totalEndMicro))),
        h('p', { class: 'muted sm' }, '期末手上總共（元）'),
        h('div', { class: 'kv' },
          kv('累積投入', multi.total.payout.investedMicro),
          kv('已領到的配息', multi.total.payout.paidOutMicro)),
      ),
    ),
    h('p', { class: 'muted sm' }, '合計就是下面每一檔加起來的結果，沒有別的假設。'),

    h('h3', { class: 'sub-title' }, '每一檔'),
    h('div', { class: 'rows' }, ...multi.rows.map(legRow)),

    // **沒算到的那幾檔一定要講出來。** 不講的話，合計看起來就像是全部的結果。
    multi.skipped.length
      ? h('div', { dataset: { block: 'calcSkipped' } },
        h('h3', { class: 'sub-title' }, `沒有算進去（${multi.skipped.length} 檔）`),
        ...multi.skipped.map((x) => h('p', { class: 'warn sm' },
          `${x.code} ${x.name || ''}：還沒填 ${x.missing.join('、')}`)),
        h('p', { class: 'muted sm' }, '空白代表還沒決定，不是 0 —— 所以這幾檔完全沒有算，上面的合計也不含它們。'))
      : null,
  );
}

/**
 * 逐年表與圖。改成多檔之後畫的是**合計** —— 每一年把各檔加起來。
 * 逐檔各畫一張的話，四檔就是四張圖，讀的人反而對不出總共會變怎樣。
 */
function yearlyCard(yearly) {
  if (!yearly?.length) return null;
  const maxValue = yearly.reduce((m, r) => (r.valueMicro > m ? r.valueMicro : m), 1n);
  return h('section', { class: 'card', dataset: { card: 'calcYearly' } },
    h('h2', { class: 'card-title' }, '逐年（全部加起來，你的假設 A：配息再投入）'),
    h('div', { class: 'chart' }, ...yearly.map((r) => {
      const invPct = Number(r.investedMicro * 100n / maxValue);
      const valPct = Number(r.valueMicro * 100n / maxValue);
      return h('div', { class: 'chart-col', title: `第 ${r.year} 年` },
        h('div', { class: 'chart-bars' },
          h('div', { class: 'chart-bar chart-bar-value', style: `height:${valPct}%` }),
          h('div', { class: 'chart-bar chart-bar-invested', style: `height:${invPct}%` }),
        ),
        h('span', { class: 'chart-label' }, String(r.year)),
      );
    })),
    h('p', { class: 'muted sm' },
      h('span', { class: 'legend legend-value' }), ' 期末市值　',
      h('span', { class: 'legend legend-invested' }), ' 累積投入'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'yearly' },
        h('thead', {}, h('tr', {},
          h('th', {}, '年'),
          h('th', {}, '累積投入'),
          h('th', {}, 'A：市值'),
          h('th', {}, 'B：市值'),
          h('th', {}, 'B：已領配息'))),
        h('tbody', {}, ...yearly.map((r) => h('tr', {},
          h('td', {}, String(r.year)),
          h('td', { class: 'num' }, fmtMoneyMicro(r.investedMicro)),
          h('td', { class: 'num' }, fmtMoneyMicro(r.valueMicro)),
          h('td', { class: 'num' }, fmtMoneyMicro(r.valueBMicro)),
          h('td', { class: 'num' }, fmtMoneyMicro(r.paidOutBMicro)),
        ))),
      ),
    ),
  );
}

async function runLookup(code) {
  state.lookupCode = code;
  state.lookupErr = '';
  const key = String(code).trim().toUpperCase();
  if (!key) { state.lookup = null; paint(); return; }

  const info = catalog.lookup(key);
  const announced = divrecord.forCode(key);
  let upcoming = { found: false };
  let received = null;
  try {
    const evs = await events.all();
    upcoming = divrecord.upcomingFor(evs, key);
    received = divrecord.receivedFor(evs, key);
  } catch { /* 沒有紀錄就是沒有，不要讓整張卡片壞掉 */ }

  state.lookup = { key, info, announced, upcoming, received };
  paint();
}

function dividendLookupCard() {
  // 直接列出他自己的持股當按鈕 —— 他不該需要先知道哪一檔查得到。
  const chips = h('div', { class: 'chip-row', dataset: { row: 'lookupHoldings' } },
    ...(state.holdings ?? []).map((hd) => {
      const on = state.lookup?.key === hd.code;
      const b = h('button', {
        class: 'chip' + (on ? ' on' : ''),
        'aria-pressed': on ? 'true' : 'false',
        dataset: { lookup: hd.code },
      }, `${hd.code} ${hd.name ?? ''}`.trim());
      b.addEventListener('click', () => runLookup(hd.code));
      return b;
    }));

  const input = h('input', {
    class: 'field', type: 'text', inputmode: 'numeric',
    placeholder: '或輸入其他代號', value: state.lookupCode, autocomplete: 'off',
    dataset: { field: 'lookupCode' },
  });
  const go = h('button', { class: 'btn' }, '查詢');
  go.addEventListener('click', () => runLookup(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runLookup(input.value); });

  const body = [];
  if (state.lookupErr) body.push(h('p', { class: 'warn' }, `讀不到配息資料：${state.lookupErr}`));
  else if (state.lookup) body.push(...lookupBody(state.lookup));

  const st = divrecord.staleness();
  return h('section', { class: 'card', dataset: { card: 'dividendLookup' } },
    h('h2', { class: 'card-title' }, '查配息紀錄'),
    h('p', { class: 'disclaimer' },
      '以下都是已經公告或已經發生的事實，不是未來的預測，也不會自動填進上面的試算欄位。'
      + '要不要採用、採用什麼數字，由你決定。'),
    (state.holdings ?? []).length
      ? chips
      : h('p', { class: 'muted sm' }, '還沒有持股。可以直接輸入代號查。'),
    h('div', { class: 'row-actions' }, input, go),
    ...body,
    st.known
      ? h('p', { class: 'muted sm', dataset: { note: 'dividendDataDate' } },
        `公司股利分派資料出表日期：${st.iso}`
        + (st.stale ? `（距今 ${st.days} 天，可能已經有新的決議沒收進來）` : ''))
      : null);
}

function lookupBody({ key, info, announced, upcoming, received }) {
  const out = [];
  out.push(h('p', {}, info.found ? `${key} ${info.name}` : `代號 ${key}`));
  if (!info.found) out.push(h('p', { class: 'warn sm' }, '這個代號不在上市清單裡。'));

  // ---- 1. 下一次除權息（已公告的預告） ----
  out.push(h('h3', { class: 'sub-title' }, '下一次除權息'));
  if (!upcoming?.found) {
    out.push(h('p', { class: 'muted sm' },
      '目前沒有已公告的下一次除權息。證交所的預告表只涵蓋未來約七週，時間還沒到就不會出現。'));
  } else {
    out.push(h('p', { dataset: { note: 'upcomingNext' } },
      `${upcoming.exDate}`
      + (upcoming.cashPerShare != null
        ? `　現金 ${divrecord.fmtPerShare(upcoming.cashPerShare)} 元/股`
        : '　金額待公告')
      + (upcoming.stockRate ? `　配股 ${divrecord.fmtPerShare(upcoming.stockRate)}` : '')));
    out.push(h('p', { class: 'muted sm' },
      '來源：證交所除權除息預告表，這是已經公告的數字。這裡只寫這一次，不會拿它推算一年會配多少。'));
  }

  // ---- 2. 你自己實際領到的 ----
  out.push(h('h3', { class: 'sub-title' }, '你自己實際領到的'));
  if (!received || received.rows.length === 0) {
    out.push(h('p', { class: 'muted sm' },
      '還沒有這一檔已確認的除權息紀錄。這一區是從你開始用這個 App 記帳之後慢慢累積起來的，'
      + '不是歷史匯入 —— 所以剛開始會是空的。'));
  } else {
    out.push(h('div', { class: 'rows' }, ...received.rows.map((r) => h('div', { class: 'row' },
      h('span', { class: 'row-code' }, r.exDate ?? ''),
      h('span', { class: 'muted sm' },
        r.micro == null ? '沒有填金額' : `${fmtMoneyMicro(r.micro)} 元`)))));
    out.push(h('p', { dataset: { note: 'receivedTotal' } },
      received.totalMicro == null
        ? '這幾筆都沒有填金額，算不出合計。'
        : `過去 ${received.counted} 次合計實際領到 ${fmtMoneyMicro(received.totalMicro)} 元`
          + (received.unknown ? `（另有 ${received.unknown} 筆沒有填金額，沒算進去）` : '')));
    out.push(h('p', { class: 'muted sm' },
      '這是你自己的紀錄，跟你當時持有的股數有關，跟「元/股」不是同一種數字，不要相加。'));
  }

  // ---- 3. 公司公告的股利分派（查得到才顯示） ----
  if (announced.found) {
    out.push(h('h3', { class: 'sub-title' }, '公司公告的股利分派'));
    out.push(h('div', { class: 'rows' }, ...announced.records.map((r) => h('div', { class: 'row' },
      h('div', { class: 'row-head' },
        h('span', { class: 'row-code' }, `${r.year} 年 ${r.period}`),
        h('span', { class: 'tag' }, r.status)),
      h('p', { class: 'row-note muted sm' },
        `現金 ${divrecord.fmtPerShare(r.cash)} 元/股`
        + (r.stock ? `　配股 ${divrecord.fmtPerShare(r.stock)} 元/股` : '')
        + (r.range ? `　（${r.range}）` : ''))))));
    out.push(h('p', { dataset: { note: 'announcedTotal' } },
      `過去 ${announced.periods} 期合計實際配發現金 ${divrecord.fmtPerShare(announced.totalCash)} 元/股`
      + (announced.totalStock ? `、配股 ${divrecord.fmtPerShare(announced.totalStock)} 元/股` : '')));
    out.push(h('p', { class: 'muted sm' },
      '「董事會決議」表示還沒經股東會確認，數字可能還會變。'));
  } else if (info.found && info.type === 'ETF') {
    // ETF 專屬說明。含糊地寫「不含 ETF」會讓人以為是我們偷懶 ——
    // 要講出限制在哪裡，以及他的紀錄會怎麼長出來。
    out.push(h('p', { class: 'muted sm', dataset: { note: 'etfNote' } },
      'ETF 的歷史收益分配，證交所沒有公開資料可以查（我們實際查過了）。'
      + '所以這一檔只看得到上面兩塊：已公告的下一次除權息，以及你自己記下來的紀錄。'));
  }

  out.push(h('p', { class: 'muted sm' }, '過去配息不代表未來。'));
  return out;
}
