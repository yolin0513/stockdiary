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

import { h, num, fmtMoneyMicro, fmtShares, toast } from '../ui.js';
import {
  validateInputs, compareScenarios, methodGap, displayTotals,
  CONTRIB_FREQ, DIVIDEND_FREQ, DIVIDEND_FREQ_LABEL,
} from '../calc.js';
import { setTop, render } from '../shell.js';

const DISCLAIMER = '以下結果完全由你輸入的假設算出，不是預測，也不是投資判斷。';

// 畫面狀態。**每一個數值欄位的初始值都是空字串。**
const state = {
  amount: '', perMonth: 1, years: '', growthRate: '', yieldRate: '',
  dividendFreq: 1, feeRate: '', startValue: '', dividendFees: false,
  method: 'value', price: '',
  result: null, gap: null, errors: {},
};

export default async function calcView() {
  setTop({ title: '定期定額試算' });
  paint();
}

function paint() {
  render([
    h('section', { class: 'card', dataset: { card: 'calcDisclaimer' } },
      h('p', { class: 'disclaimer' }, DISCLAIMER),
      h('p', { class: 'muted sm' },
        '年化成長率以複利換算到每個月；年化配息率以年率除以配息次數。' +
        '這裡的每一個數字都是你填的假設，不是任何形式的預測。'),
    ),
    inputCard(),
    state.result ? resultCard(state.result, state.gap) : null,
    state.result ? yearlyCard(state.result) : null,
  ].filter(Boolean));
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
  return h('div', { class: 'pref-row' },
    h('div', { class: 'pref-main' },
      h('p', { class: 'pref-label' }, label),
      hint ? h('p', { class: 'muted sm' }, hint) : null),
    h('button', {
      class: 'chip' + (on ? ' on' : ''),
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      dataset: { calcChip: `${key}:${!on}` },
      onclick: () => { state[key] = !on; paint(); },
    }, on ? '開啟' : '關閉'),
  );
}

function inputCard() {
  return h('section', { class: 'card', dataset: { card: 'calcInputs' } },
    h('h2', { class: 'card-title' }, '你的假設'),
    field({ key: 'amount', label: '每期扣款金額', suffix: '元', inputmode: 'numeric' }),
    chips({
      key: 'perMonth', label: '每月扣款次數',
      options: CONTRIB_FREQ.map((n) => ({ value: n, label: `${n} 次` })),
    }),
    field({ key: 'years', label: '期間', suffix: '年', inputmode: 'numeric' }),
    field({ key: 'growthRate', label: '年化價格成長率', suffix: '%', hint: '可以填負數。' }),
    field({ key: 'yieldRate', label: '年化配息率', suffix: '%' }),
    chips({
      key: 'dividendFreq', label: '配息頻率',
      options: DIVIDEND_FREQ.map((n) => ({ value: n, label: DIVIDEND_FREQ_LABEL[n] })),
    }),

    h('h2', { class: 'card-title', style: 'margin-top:12px' }, '選填'),
    field({ key: 'startValue', label: '目前已有部位的市值', suffix: '元', inputmode: 'numeric' }),
    field({ key: 'feeRate', label: '扣款手續費率', hint: '用小數填，例如 0.001425 代表 0.1425%。不填就是不扣。' }),
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
    state.method === 'share'
      ? field({ key: 'price', label: '目前股價', suffix: '元' })
      : null,

    h('button', { class: 'btn btn-primary', onclick: compute }, '算一次'),
    h('button', { class: 'btn', onclick: reset }, '全部清空'),
  );
}

function compute() {
  const v = validateInputs(state);
  state.errors = v.errors;
  if (!v.ok) {
    state.result = null;
    state.gap = null;
    paint();
    toast('還有欄位沒填');
    return;
  }
  state.result = compareScenarios(v.values);
  state.gap = v.values.method === 'share' ? methodGap(v.values, { reinvest: true }) : null;
  paint();
}

function reset() {
  for (const k of ['amount', 'years', 'growthRate', 'yieldRate', 'feeRate', 'startValue', 'price']) state[k] = '';
  state.perMonth = 1;
  state.dividendFreq = 1;
  state.dividendFees = false;
  state.method = 'value';
  state.result = null;
  state.gap = null;
  state.errors = {};
  paint();
}

// ---------- 結果 ----------

function scenarioBlock(title, subtitle, sim) {
  // 畫面上的數字全部用四捨五入到元之後的版本 —— 分項加起來一定等於總計。
  const d = displayTotals(sim);
  return h('div', { class: 'scenario' },
    h('h3', { class: 'scenario-title' }, title),
    h('p', { class: 'muted sm' }, subtitle),
    h('p', { class: 'mid-number' }, num(fmtMoneyMicro(d.totalEndMicro))),
    h('p', { class: 'muted sm' }, '期末手上總共（元）'),
    h('div', { class: 'kv' },
      kv('累積投入', d.investedMicro),
      kv('期末市值', d.valueMicro),
      sim.reinvest
        ? kv('已再投入的配息', d.dividendReinvestedMicro)
        : kv('已領到的配息', d.paidOutMicro),
      kv('累積配息（毛額）', d.dividendTotalMicro),
    ),
    sim.shares != null
      ? h('p', { class: 'muted sm' },
        '期末 ', num(fmtShares(sim.shares)), ' 股，未投入現金 ',
        num(fmtMoneyMicro(sim.leftoverCashMicro)), ' 元（已計入期末市值）')
      : null,
  );
}

function kv(label, micro) {
  return h('div', { class: 'kv-row' },
    h('span', { class: 'muted sm' }, label),
    num(fmtMoneyMicro(micro)),
  );
}

function resultCard(result, gap) {
  return h('section', { class: 'card', dataset: { card: 'calcResult' } },
    h('h2', { class: 'card-title' }, '結果'),
    h('p', { class: 'disclaimer' }, DISCLAIMER),
    h('div', { class: 'scenarios' },
      scenarioBlock('你的假設 A', '配息再投入', result.reinvest),
      scenarioBlock('你的假設 B', '配息領現', result.payout),
    ),
    gap
      ? h('p', { class: 'muted sm' },
        '同一組假設下，金額法的期末比股數法高 ',
        num(fmtMoneyMicro(gap.diffMicro)),
        ` 元（約 ${gap.inShares.toFixed(2)} 股）——差在「湊不滿一股的現金閒置著，沒有跟著成長」。`)
      : null,
  );
}

function yearlyCard(result) {
  const a = result.reinvest.yearly;
  const b = result.payout.yearly;
  const maxValue = a.reduce((m, r) => (r.valueMicro > m ? r.valueMicro : m), 1n);
  return h('section', { class: 'card', dataset: { card: 'calcYearly' } },
    h('h2', { class: 'card-title' }, '逐年（你的假設 A：配息再投入）'),
    h('div', { class: 'chart' }, ...a.map((r) => {
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
        h('tbody', {}, ...a.map((r, i) => h('tr', {},
          h('td', {}, String(r.year)),
          h('td', { class: 'num' }, fmtMoneyMicro(r.investedMicro)),
          h('td', { class: 'num' }, fmtMoneyMicro(r.valueMicro)),
          h('td', { class: 'num' }, fmtMoneyMicro(b[i].valueMicro)),
          h('td', { class: 'num' }, fmtMoneyMicro(b[i].dividendPaidOutMicro)),
        ))),
      ),
    ),
  );
}
