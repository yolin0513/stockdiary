// 定期定額試算（PLAN §6）。純函式，沒有任何預設值。
//
// **這不是預測，是把使用者給的假設算出來。**
// 所以這個檔案裡：
//   · 沒有任何「建議報酬率」「常見值」「歷史平均」「範例值」
//   · 少一個必填欄位就回 null —— 不會自己補一個數字把結果湊出來
//   · AI 完全不介入（PLAN §6）
//
// 兩種算法（PLAN §6「零股與未滿一股」）：
//   金額法（預設）市值 × 成長率、市值 × 配息率，全程 BigInt 微元，不做任何捨入，
//                只在顯示時取到元。買得到幾股不管 —— 這是「數學上的複利」。
//   股數法        每期 股數 = floor(可用現金 ÷ 當期股價)，**買不足的餘額結轉下期**
//                （不捨棄、不四捨五入），配息進同一個現金池。這是「實際會發生的事」。
//
// 兩者的差距來自「湊不滿一股的現金閒置著沒有跟著漲」，期末會把差距算給使用者看，
// 不寫死「差距小於一股」之類的斷言 —— 期間拉長時那句話不一定成立。

import { toMicro, MICRO } from './money.js';

// 成長率換算用的刻度。比微元細很多，避免每個月複利一次就被截掉一點。
const RATE_SCALE = 1000000000000n;      // 1e12

export const CONTRIB_FREQ = [1, 2, 3];              // 每月扣款次數
export const DIVIDEND_FREQ = [1, 2, 4, 12];         // 每年配息次數
export const DIVIDEND_FREQ_LABEL = { 1: '每年', 2: '每半年', 4: '每季', 12: '每月' };
export const METHODS = ['value', 'share'];

/** 這些欄位一定要有值。少一個就算不出來 —— 不補預設值。 */
export const REQUIRED = ['amount', 'perMonth', 'years', 'growthRate', 'yieldRate', 'dividendFreq'];

/**
 * 檢查輸入。回 { ok, errors: {欄位: 訊息}, values }。
 * **空字串不是 0**：沒填就是沒填，不會被當成「成長率 0%」。
 */
/** 手續費率的上限（1%），跟 js/plans.js 同一條線。台股券商實際是 0.1425% 打折。 */
export const MAX_FEE_RATE = 0.01;

export function validateInputs(raw = {}) {
  const errors = {};
  const values = {};

  const numField = (key, { min = null, max = null, integer = false, label }) => {
    const v = raw[key];
    if (v == null || String(v).trim() === '') { errors[key] = `請填${label}`; return; }
    const n = Number(String(v).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) { errors[key] = `${label}要是數字`; return; }
    if (integer && !Number.isInteger(n)) { errors[key] = `${label}要是整數`; return; }
    if (min != null && n < min) { errors[key] = `${label}不能小於 ${min}`; return; }
    if (max != null && n > max) { errors[key] = `${label}不能大於 ${max}`; return; }
    values[key] = n;
  };

  // 允許填 0：「只試算目前已有的部位、之後不再扣款」是合理的假設。
  // 但**不能不填** —— 空白代表沒填，不是 0。
  numField('amount', { min: 0, label: '每期扣款金額' });
  numField('years', { min: 1, max: 60, integer: true, label: '期間（年）' });
  // 成長率允許負數 —— 使用者要假設下跌是他的自由，我們不做判斷
  numField('growthRate', { min: -99, max: 1000, label: '年化價格成長率' });
  numField('yieldRate', { min: 0, max: 1000, label: '年化配息率' });

  if (!CONTRIB_FREQ.includes(Number(raw.perMonth))) errors.perMonth = '請選擇每月扣款次數';
  else values.perMonth = Number(raw.perMonth);

  if (!DIVIDEND_FREQ.includes(Number(raw.dividendFreq))) errors.dividendFreq = '請選擇配息頻率';
  else values.dividendFreq = Number(raw.dividendFreq);

  // 選填
  // 費率是**比例**不是百分比（0.001425 ＝ 0.1425%）。上限跟定期定額那一頁一致：
  // 超過 1% 就是把百分比直接填進來了。0.999 的上限等於什麼都沒擋 ——
  // 填 0.1425 會被當成 14.25%，算出來的每一期都少扣一成四，而畫面上看不出來。
  values.feeRate = optionalNumber(raw.feeRate, errors, 'feeRate', { min: 0, max: MAX_FEE_RATE, label: '扣款手續費率' }) ?? 0;
  if (errors.feeRate && Number(String(raw.feeRate).replace(/,/g, '').trim()) > MAX_FEE_RATE) {
    errors.feeRate = `${String(raw.feeRate).trim()} 代表 `
      + `${(Number(String(raw.feeRate).replace(/,/g, '').trim()) * 100).toFixed(4)}%，`
      + '看起來是把百分比直接填進來了。券商說的「0.1425%」要填 0.001425。';
  }
  values.startValue = optionalNumber(raw.startValue, errors, 'startValue', { min: 0, label: '目前已有部位市值' }) ?? 0;
  values.dividendFees = !!raw.dividendFees;
  values.method = METHODS.includes(raw.method) ? raw.method : 'value';

  if (values.method === 'share') {
    numField('price', { min: 0.01, label: '目前股價' });
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

function optionalNumber(v, errors, key, { min, max, label }) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) { errors[key] = `${label}要是數字`; return null; }
  if (min != null && n < min) { errors[key] = `${label}不能小於 ${min}`; return null; }
  if (max != null && n > max) { errors[key] = `${label}不能大於 ${max}`; return null; }
  return n;
}

/**
 * 年化成長率 → 每月的成長倍數（1e12 刻度的 BigInt）。
 * 用複利換算：連續 12 個月相乘剛好回到使用者填的年成長率。
 */
export function monthlyFactor(annualRatePercent) {
  const annual = 1 + Number(annualRatePercent) / 100;
  if (!(annual > 0)) return null;
  return BigInt(Math.round(Math.pow(annual, 1 / 12) * 1e12));
}

function mulRate(micro, factorScaled) {
  const product = micro * factorScaled;
  // 四捨五入回微元（每步誤差 < 0.5 微元；480 個月累積也不到萬分之一元）
  const half = RATE_SCALE / 2n;
  return (product + (product >= 0n ? half : -half)) / RATE_SCALE;
}

const WIRE_FEE_MICRO = toMicro(10);
const NHI_THRESHOLD_MICRO = toMicro(20000);
const NHI_RATE_BP = 211n;

/** 一筆配息扣掉費用之後的淨額（開關關閉時原數奉還）。 */
function netDividend(grossMicro, applyFees) {
  if (!applyFees || grossMicro <= 0n) return grossMicro;
  const nhi = grossMicro >= NHI_THRESHOLD_MICRO
    ? roundToYuanMicro((grossMicro * NHI_RATE_BP) / 10000n)
    : 0n;
  const net = grossMicro - WIRE_FEE_MICRO - nhi;
  return net > 0n ? net : 0n;
}

function roundToYuanMicro(micro) {
  const rem = micro % MICRO;
  return rem * 2n >= MICRO ? micro - rem + MICRO : micro - rem;
}

/**
 * 跑一次試算。inputs 必須先過 validateInputs。
 *
 * 回傳的金額全部是 BigInt 微元。yearly 是逐年表（每年年底的快照）。
 */
export function simulate(v, { reinvest }) {
  const months = v.years * 12;
  const growth = monthlyFactor(v.growthRate);
  if (growth == null) return null;

  const contribEach = toMicro(v.amount);                       // 每一次扣款的金額
  const usableEach = contribEach - mulRate(contribEach, BigInt(Math.round(v.feeRate * 1e12)));
  const dividendMonths = 12 / v.dividendFreq;                  // 每幾個月配一次
  const perPayoutRate = BigInt(Math.round((v.yieldRate / 100 / v.dividendFreq) * 1e12));

  let value = toMicro(v.startValue);        // 金額法：市值
  let shares = 0;                           // 股數法：股數
  let cash = 0n;                            // 股數法：湊不滿一股的現金（結轉，不捨棄）
  let priceMicro = v.method === 'share' ? toMicro(v.price) : null;
  if (v.method === 'share' && v.startValue > 0 && priceMicro > 0n) {
    // 已有部位用目前股價換算成股數，餘額進現金池
    shares = Number(toMicro(v.startValue) / priceMicro);
    cash = toMicro(v.startValue) - BigInt(shares) * priceMicro;
  }

  let invested = toMicro(v.startValue);
  let dividendTotal = 0n;                   // 累積配息（毛額）
  let dividendReinvested = 0n;              // 其中再投入的部分
  let dividendPaidOut = 0n;                 // 其中領現的部分
  const yearly = [];

  const marketValue = () => (v.method === 'share'
    ? BigInt(shares) * priceMicro + cash
    : value);

  for (let m = 1; m <= months; m += 1) {
    // 1) 這個月的扣款（每月 perMonth 次，金額相同）
    for (let k = 0; k < v.perMonth; k += 1) {
      invested += contribEach;
      if (v.method === 'share') {
        cash += usableEach;
        const bought = priceMicro > 0n ? cash / priceMicro : 0n;
        shares += Number(bought);
        cash -= bought * priceMicro;
      } else {
        value += usableEach;
      }
    }

    // 2) 價格成長（月底）
    if (v.method === 'share') priceMicro = mulRate(priceMicro, growth);
    else value = mulRate(value, growth);

    // 3) 配息
    if (dividendMonths > 0 && m % dividendMonths === 0 && perPayoutRate > 0n) {
      const base = v.method === 'share' ? BigInt(shares) * priceMicro : value;
      const gross = mulRate(base, perPayoutRate);
      const net = netDividend(gross, v.dividendFees);
      dividendTotal += gross;
      if (reinvest) {
        dividendReinvested += net;
        if (v.method === 'share') {
          cash += net;
          const bought = priceMicro > 0n ? cash / priceMicro : 0n;
          shares += Number(bought);
          cash -= bought * priceMicro;
        } else {
          value += net;
        }
      } else {
        dividendPaidOut += net;
      }
    }

    if (m % 12 === 0) {
      yearly.push({
        year: m / 12,
        investedMicro: invested,
        valueMicro: marketValue(),
        dividendMicro: dividendTotal,
        dividendPaidOutMicro: dividendPaidOut,
        shares: v.method === 'share' ? shares : null,
        cashMicro: v.method === 'share' ? cash : null,
        priceMicro: v.method === 'share' ? priceMicro : null,
      });
    }
  }

  const finalValue = marketValue();
  return {
    method: v.method,
    reinvest,
    months,
    yearly,
    investedMicro: invested,
    finalValueMicro: finalValue,
    dividendTotalMicro: dividendTotal,
    dividendReinvestedMicro: dividendReinvested,
    dividendPaidOutMicro: dividendPaidOut,
    // 領現的情境：期末手上的錢 = 市值 + 已經領到的現金
    totalEndMicro: finalValue + dividendPaidOut,
    shares: v.method === 'share' ? shares : null,
    leftoverCashMicro: v.method === 'share' ? cash : null,
    finalPriceMicro: v.method === 'share' ? priceMicro : null,
  };
}

/**
 * 兩個情境並排：配息再投入 vs 配息領現。
 * 名稱是「你的假設 A／B」（PLAN §6）—— 不叫「保守／樂觀」，那是在替使用者做判斷。
 */
export function compareScenarios(values) {
  const a = simulate(values, { reinvest: true });
  const b = simulate(values, { reinvest: false });
  if (!a || !b) return null;
  return { reinvest: a, payout: b };
}

/**
 * 金額法與股數法的期末差距。
 * 差距來自「湊不滿一股的現金閒置著沒有跟著漲」。
 * 這裡只回報算出來的事實，不宣稱它一定小於某個數。
 */
export function methodGap(values, { reinvest }) {
  if (values.method !== 'share' || values.price == null) return null;
  const share = simulate({ ...values, method: 'share' }, { reinvest });
  const value = simulate({ ...values, method: 'value' }, { reinvest });
  if (!share || !value) return null;
  const diffMicro = value.totalEndMicro - share.totalEndMicro;
  const sharePriceMicro = share.finalPriceMicro;
  return {
    diffMicro,
    sharePriceMicro,
    inShares: sharePriceMicro > 0n ? Number(diffMicro) / Number(sharePriceMicro) : null,
  };
}

/**
 * 給畫面用的「已經四捨五入到元」的數字。
 *
 * 為什麼需要這個：各項分別四捨五入之後再相加，跟「先相加再四捨五入」可能差 1 元。
 * 使用者會自己把畫面上的兩個數字加起來對總計 —— 差 1 元看起來就是程式算錯。
 * 所以總計**用四捨五入後的分項相加**，保證畫面上的數字彼此加得起來。
 * 代價是總計與精確值最多差 1 元，而這一頁本來就只顯示到元。
 */
/**
 * 每一檔各自的假設，一起試算。
 *
 * 為什麼要分開：0050、0056、00878、2330 的性質差很多，用同一組成長率與配息率
 * 算出來的東西沒有意義（使用者自己提的）。
 *
 * legs: [{ code, name, amount, startValue, growthRate, yieldRate, price }]
 * shared: { years, perMonth, dividendFreq, feeRate, dividendFees, method }
 *
 * **沒填完的那一檔不算，也不會被當成 0。** 空白代表「還沒決定」，
 * 不是「假設它不成長／不配息」—— 拿 0 去算會生出一個看起來很正常的錯數字。
 * 回傳裡的 skipped 就是那幾檔，畫面必須把它們講出來。
 */
export function compareMulti(legs, shared) {
  const rows = [];
  const skipped = [];

  for (const leg of legs ?? []) {
    const missing = [];
    if (!Number.isFinite(Number(leg.growthRate)) || String(leg.growthRate).trim() === '') missing.push('年化價格成長率');
    if (!Number.isFinite(Number(leg.yieldRate)) || String(leg.yieldRate).trim() === '') missing.push('年化配息率');
    if (!Number.isFinite(Number(leg.amount)) || String(leg.amount).trim() === '') missing.push('每期扣款金額');
    if (missing.length) { skipped.push({ code: leg.code, name: leg.name, missing }); continue; }

    const values = {
      amount: Number(leg.amount),
      startValue: Number(leg.startValue ?? 0) || 0,
      growthRate: Number(leg.growthRate),
      yieldRate: Number(leg.yieldRate),
      price: leg.price == null || String(leg.price).trim() === '' ? null : Number(leg.price),
      years: shared.years,
      perMonth: shared.perMonth,
      dividendFreq: shared.dividendFreq,
      feeRate: shared.feeRate ?? 0,
      dividendFees: !!shared.dividendFees,
    };
    // 股數法需要價格。**沒有價格的那一檔改用金額法**，並且在回傳裡標出來 ——
    // 硬用股數法會拿一個不存在的價格去除，算出來的股數是假的。
    values.method = shared.method === 'share' && hasPrice(leg) ? 'share' : 'value';
    const pair = compareScenarios(values);
    if (!pair) { skipped.push({ code: leg.code, name: leg.name, missing: ['算不出來'] }); continue; }
    rows.push({
      sims: pair,
      code: leg.code,
      name: leg.name,
      usedMethod: values.method,
      values,
      reinvest: displayTotals(pair.reinvest),
      payout: displayTotals(pair.payout),
    });
  }

  if (rows.length === 0) return { rows, skipped, total: null };

  const sum = (pick) => rows.reduce((acc, r) => acc + (pick(r) ?? 0n), 0n);
  const total = {
    reinvest: {
      investedMicro: sum((r) => r.reinvest.investedMicro),
      totalEndMicro: sum((r) => r.reinvest.totalEndMicro),
      dividendTotalMicro: sum((r) => r.reinvest.dividendTotalMicro),
    },
    payout: {
      investedMicro: sum((r) => r.payout.investedMicro),
      totalEndMicro: sum((r) => r.payout.totalEndMicro),
      dividendTotalMicro: sum((r) => r.payout.dividendTotalMicro),
      paidOutMicro: sum((r) => r.payout.paidOutMicro),
    },
    counted: rows.length,
    // 逐年合計：每一年把各檔加起來。各檔的年數都一樣（期間是共用設定），
    // 所以逐年表對得起來；真的長度不一致就以最短的為準，不要對錯年。
    yearly: sumYearly(rows),
  };
  return { rows, skipped, total };
}

/** 把每一檔的逐年表加起來。長度不一致時以最短的為準 —— 寧可少幾年，也不要把不同年份加在一起。 */
function sumYearly(rows) {
  if (rows.length === 0) return [];
  const n = Math.min(...rows.map((r) => r.sims.reinvest.yearly.length));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let invested = 0n; let valueA = 0n; let valueB = 0n; let paidB = 0n;
    for (const r of rows) {
      invested += r.sims.reinvest.yearly[i].investedMicro;
      valueA += r.sims.reinvest.yearly[i].valueMicro;
      valueB += r.sims.payout.yearly[i].valueMicro;
      paidB += r.sims.payout.yearly[i].dividendPaidOutMicro;
    }
    out.push({ year: rows[0].sims.reinvest.yearly[i].year, investedMicro: invested, valueMicro: valueA, valueBMicro: valueB, paidOutBMicro: paidB });
  }
  return out;
}

function hasPrice(leg) {
  return leg.price != null && String(leg.price).trim() !== '' && Number(leg.price) > 0;
}

export function displayTotals(sim) {
  const value = roundYuan(sim.finalValueMicro);
  const paidOut = roundYuan(sim.dividendPaidOutMicro);
  return {
    valueMicro: value,
    paidOutMicro: paidOut,
    investedMicro: roundYuan(sim.investedMicro),
    dividendTotalMicro: roundYuan(sim.dividendTotalMicro),
    dividendReinvestedMicro: roundYuan(sim.dividendReinvestedMicro),
    totalEndMicro: value + paidOut,
  };
}

function roundYuan(micro) {
  if (micro == null) return null;
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const rem = abs % MICRO;
  const out = rem * 2n >= MICRO ? abs - rem + MICRO : abs - rem;
  return neg ? -out : out;
}
