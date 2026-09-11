// 金額運算。**全部用 BigInt 微元（1 微元 = 0.000001 元）做整數運算。**
//
// 為什麼不用一般的浮點數：
//   0.1 + 0.2 !== 0.3。單筆看不出來，但「每檔股票的當日損益加總」「逐年累加的
//   定期定額試算」會把誤差一路帶下去，最後跟券商對帳單差幾塊錢 —— 而使用者
//   會合理地認為是程式算錯了（他是對的）。
//
// 為什麼是微元而不是分：每股配息常常是 0.125 元，有些 ETF 配到小數第四位；
// 定期定額試算要求「不做任何捨入」。微元（小數第六位）涵蓋得下。
//
// 為什麼是 BigInt 而不是整數 Number：股數 × 單價在微元下很容易超過 2^53
// （100 萬股 × 2500 元 = 2.5e15 微元，已經貼著上限）。BigInt 沒有這個問題。

export const MICRO = 1000000n;

/** 數字或字串 → BigInt 微元。四捨五入（.5 往遠離零的方向）。無效值回 null。 */
export function toMicro(x) {
  if (x == null) return null;
  if (typeof x === 'bigint') return x;
  let n;
  if (typeof x === 'number') n = x;
  else {
    // Number('') 與 Number('   ') 都是 0。空字串是「沒有這個數字」，不是零 ——
    // 這正是「沒成交卻顯示 0」那類錯誤的源頭，在入口就擋掉。
    const s = String(x).trim();
    if (s === '') return null;
    n = Number(s);
  }
  if (!Number.isFinite(n)) return null;
  // 先轉成字串處理，避免 (0.07 * 1e6) 這種乘法本身就先產生誤差
  return parseDecimalToMicro(n);
}

function parseDecimalToMicro(n) {
  const neg = n < 0;
  const s = Math.abs(n).toFixed(7);            // 多取一位用來四捨五入
  const [intPart, fracPart = ''] = s.split('.');
  const keep = fracPart.slice(0, 6).padEnd(6, '0');
  const nextDigit = Number(fracPart[6] ?? '0');
  let micro = BigInt(intPart) * MICRO + BigInt(keep);
  if (nextDigit >= 5) micro += 1n;
  return neg ? -micro : micro;
}

/** BigInt 微元 → Number（元）。只給顯示用，不要拿回去繼續算。 */
export function toYuan(micro) {
  if (micro == null) return null;
  return Number(micro) / 1e6;
}

/** 股數（整數）× 每股金額（微元）→ 微元。 */
export function mulShares(shares, perShareMicro) {
  if (shares == null || perShareMicro == null) return null;
  return BigInt(Math.round(shares)) * perShareMicro;
}

/** 一串微元相加；只要有一個是 null 就回 null（不要把「不知道」當成 0 加進去）。 */
export function sumMicro(list) {
  let total = 0n;
  for (const m of list) {
    if (m == null) return null;
    total += m;
  }
  return total;
}

/** 微元四捨五入到元（回 BigInt 微元，小數部分歸零）。 */
export function roundToYuan(micro) {
  if (micro == null) return null;
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const rem = abs % MICRO;
  let out = abs - rem;
  if (rem * 2n >= MICRO) out += MICRO;
  return neg ? -out : out;
}

/**
 * a ÷ b，結果是微元（b 是純量，不是微元）。用於報酬率之類的除法。
 * 回傳 Number 比例（不是微元）—— 比例不是金額，不需要微元精度。
 */
export function ratio(numeratorMicro, denominatorMicro) {
  if (numeratorMicro == null || denominatorMicro == null) return null;
  if (denominatorMicro === 0n) return null;
  return Number(numeratorMicro) / Number(denominatorMicro);
}
