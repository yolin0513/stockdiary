// 試算器畫面（npm run calcviewtest）。真的開瀏覽器跑。
//
// 驗收條件（STATUS M4）：
//   · 頁面載入時**任何數值欄位都是空字串**
//   · DOM 中不含「預期」「保守」「樂觀」「建議」「歷史平均」
//   · 對照組：故意塞一個預設值 → 測試要紅
//
// 掃描範圍不只 textContent，還包含 placeholder／value／title／aria-label ——
// 「建議值」最容易藏的地方就是 placeholder。

import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf, detects, note } from './tap.mjs';
import { listen } from './serve.mjs';
// 禁用詞清單跟 calctest、uikittest 共用同一份（2026-09-23，以前三處各抄一份）
import { BANNED } from './banned.mjs';

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.goto(`http://localhost:${port}/#/calc`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#view [data-card="calcInputs"]');

  /** 整頁看得到的文字 ＋ 所有可能顯示文字的屬性。 */
  const scanPage = () => page.evaluate(() => {
    const parts = [document.querySelector('#view').textContent];
    for (const el of document.querySelectorAll('#view *')) {
      for (const attr of ['placeholder', 'value', 'title', 'aria-label', 'alt']) {
        const v = el.getAttribute(attr);
        if (v) parts.push(v);
      }
    }
    // 分隔符是 ||| 而不是空白：整頁文字與各個屬性值被接成一個大字串之後，
    // 下面那些正則不可以跨過片段的邊界去比對（s 會匹配空白與換行，||| 不會）。
    // 這裡原本用的是一個 NUL 字元，語意相同，但那讓 grep 與 git diff 把整個檔案
    // 當成二進位 —— 搜尋搜不到、code review 看不到 diff。
    return parts.join(' ||| ');
  });

  // v0.7.11 起欄位有兩種：共用設定與每一檔自己的。**兩種都要掃** ——
  // 只掃共用的話，每檔那幾格（成長率、配息率）有沒有預設值就沒人看著了，
  // 而那兩格正是最不能有預設值的。
  const numericFields = () => page.$$eval('#view [data-calc-field], #view [data-leg-field]',
    (els) => els.map((e) => ({
      key: e.dataset.calcField ?? e.dataset.legField,
      value: e.value,
      placeholder: e.placeholder,
    })));

  // =================================================================
  section('載入時所有數值欄位都是空的');
  // 先種一檔標的，不然每檔那幾格根本不存在 —— 掃一個沒有標的的頁面等於什麼都沒掃。
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    await holdings.addOpening({ code: '0050', shares: 1000, avgCost: null, date: '2026-01-05' });
    const cv = await import('./js/views/calc.js');
    await cv.default();
    await new Promise((r) => setTimeout(r, 400));
  });
  const fields = await numericFields();
  ok(fields.length >= 6, `找到 ${fields.length} 個數值欄位：${fields.map((f) => f.key).join('、')}`);
  ok(fields.some((f) => String(f.key).includes('growthRate')) && fields.some((f) => String(f.key).includes('yieldRate')),
    '（對照）成長率與配息率那兩格真的掃到了 —— 它們是最不能有預設值的兩格');
  everyOf(fields, (f) => f.value === '', '每一個欄位的值都是空字串');
  noneOf(fields, (f) => f.value !== '', '沒有任何欄位有預設值');
  // placeholder 裡也不能有數字 —— 那一樣是在暗示「大概填多少」
  noneOf(fields, (f) => /\d/.test(f.placeholder || ''),
    'placeholder 裡沒有任何數字（那會變成建議值）');

  section('禁用詞：整頁的文字與屬性都不能有');
  const text1 = await scanPage();
  ok(text1.length > 200, `掃到 ${text1.length} 個字元的內容`);
  noneOf(BANNED.map((w) => ({ w, hit: text1.includes(w) })), (x) => x.hit,
    `輸入畫面沒有任何「建議」意味的字（${BANNED.join('、')}）`);
  // 對照組：掃描器要抓得到真的塞進去的詞
  const detected = await page.evaluate(() => {
    const p = document.createElement('p');
    p.textContent = '建議報酬率 5%';
    document.querySelector('#view').append(p);
    const parts = [document.querySelector('#view').textContent];
    p.remove();
    return parts.join(' ');
  });
  ok(BANNED.some((w) => detected.includes(w)),
    '（對照）故意塞一句「建議報酬率 5%」進 DOM，掃描器確實抓得到');
  // 對照組：屬性也要掃得到
  const attrDetected = await page.evaluate(() => {
    const el = document.querySelector('#view [data-calc-field]');
    el.setAttribute('placeholder', '歷史平均 8%');
    const parts = [];
    for (const e of document.querySelectorAll('#view *')) {
      const v = e.getAttribute('placeholder');
      if (v) parts.push(v);
    }
    el.setAttribute('placeholder', '');
    return parts.join(' ');
  });
  ok(attrDetected.includes('歷史平均'), '（對照）塞進 placeholder 的禁用詞也掃得到');

  section('免責文字固定在頁首');
  ok(text1.includes('不是預測'), '頁首寫明「不是預測」');
  ok((await page.$('#view [data-card="calcDisclaimer"]')) != null, '有免責區塊');

  // =================================================================
  section('填完之後算得出結果');
  // v0.7.11 起：每一檔的假設分開填，所以欄位分兩種 ——
  //   共用設定 [data-calc-field]（期間、次數、頻率、費率）
  //   每一檔   [data-leg-field="代號:欄位"]（金額、市值、成長率、配息率、股價）
  const fill = async (key, value) => {
    await page.evaluate(({ k, v }) => {
      const el = document.querySelector(`#view [data-calc-field="${k}"]`);
      if (!el) throw new Error(`共用設定沒有 ${k} 這一格`);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { k: key, v: String(value) });
  };
  const fillLeg = async (code, key, value) => {
    await page.evaluate(({ c, k, v }) => {
      const el = document.querySelector(`#view [data-leg-field="${c}:${k}"]`);
      if (!el) throw new Error(`${c} 沒有 ${k} 這一格`);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { c: code, k: key, v: String(value) });
  };
  // 這一段需要一檔標的。種一檔進去再重畫。
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    await holdings.addOpening({ code: '0050', shares: 1000, avgCost: null, date: '2026-01-05' });
    const cv = await import('./js/views/calc.js');
    await cv.default();
    await new Promise((r) => setTimeout(r, 400));
  });
  // 手算：起始 1,000,000、零成長、年配息 5%、每年一次、10 年、不扣款
  //   A（再投入）：1,000,000 × 1.05^10 = 1,628,894.63 → 顯示 1,628,895
  //   B（領現）  ：市值 1,000,000 ＋ 領到 500,000 = 1,500,000
  await fill('years', 10);
  await fillLeg('0050', 'amount', 0);
  await fillLeg('0050', 'growthRate', 0);
  await fillLeg('0050', 'yieldRate', 5);
  await fillLeg('0050', 'startValue', 1000000);
  await page.evaluate(() => {
    [...document.querySelectorAll('#view .btn-primary')].find((b) => b.textContent === '算一次').click();
  });
  await page.waitForSelector('#view [data-card="calcResult"]');
  const resultText = await page.$eval('#view [data-card="calcResult"]', (el) => el.textContent.replace(/\s+/g, ' '));
  ok(resultText.includes('你的假設 A'), '情境 A 出現');
  ok(resultText.includes('你的假設 B'), '情境 B 出現');
  ok(resultText.includes('配息再投入'), 'A 標明是配息再投入');
  ok(resultText.includes('配息領現'), 'B 標明是配息領現');
  ok(resultText.includes('1,628,895'), `A 的期末 1,628,895 元（1,000,000 × 1.05^10）：「${resultText.slice(0, 160)}…」`);
  ok(resultText.includes('1,500,000'), 'B 的期末 1,500,000 元（市值 1,000,000 ＋ 領到 500,000）');

  section('畫面上的分項加得起來');
  // 各項分別四捨五入之後再相加，跟「先相加再四捨五入」可能差 1 元。
  // 使用者會自己把畫面上的兩個數字加起來對總計 —— 差 1 元看起來就是程式算錯。
  const adds = await page.evaluate(() => {
    const toNum = (t) => Number(String(t).replace(/[^0-9.-]/g, ''));
    // v0.7.11 的結果卡片是「每一檔一列 ＋ 合計」。
    // 要守的不變式變成：**畫面上的合計剛好等於畫面上每一檔相加**。
    // （少一檔、多加一檔、或把沒算的那幾檔偷偷算進去，這條都會紅。）
    const card = document.querySelector('#view [data-card="calcResult"]');
    const totals = [...card.querySelectorAll('.scenario')].map((el) => ({
      title: el.querySelector('.scenario-title').textContent,
      total: toNum(el.querySelector('.mid-number').textContent),
    }));
    const rows = [...card.querySelectorAll('[data-result-code]')].map((r) => {
      const nums = [...r.querySelectorAll('.num')].map((x) => toNum(x.textContent));
      return { code: r.dataset.resultCode, nums };
    });
    return { totals, rows, skipped: card.querySelector('[data-block="calcSkipped"]')?.textContent ?? '' };
  });
  eq(adds.totals.length, 2, '兩個情境的合計');
  ok(adds.rows.length >= 1, `每一檔各有一列（${adds.rows.map((r) => r.code).join('、')}）`);
  // 每一列的數字是：投入、期末（再投入）、期末（領現）
  const sumReinvest = adds.rows.reduce((acc, r) => acc + (r.nums[1] ?? 0), 0);
  const sumPayout = adds.rows.reduce((acc, r) => acc + (r.nums[2] ?? 0), 0);
  eq(adds.totals[0].total, sumReinvest,
    `合計 A 剛好等於每一檔相加（${adds.totals[0].total} ＝ ${sumReinvest}）`);
  eq(adds.totals[1].total, sumPayout,
    `合計 B 剛好等於每一檔相加（${adds.totals[1].total} ＝ ${sumPayout}）`);
  ok(adds.totals[0].total > 0 && sumReinvest > 0,
    '（前提）數字真的不是 0，不然上面兩條是恆真的');

  section('情境名稱不帶方向');
  noneOf(BANNED.map((w) => ({ w, hit: resultText.includes(w) })), (x) => x.hit,
    '結果區塊也沒有任何「建議」意味的字');
  noneOf([resultText], (t) => /情境 ?[一二]|方案|較佳|最佳|勝出/.test(t),
    '沒有「較佳」「最佳」之類替使用者做判斷的字');

  section('逐年表與圖');
  await page.waitForSelector('#view [data-card="calcYearly"]');
  const rows = await page.$$eval('#view table.yearly tbody tr', (els) => els.length);
  eq(rows, 10, '逐年表有 10 列');
  const bars = await page.$$eval('#view .chart-col', (els) => els.length);
  // A8：長條的高度走 CSS 變數 --h（CSSOM）。CSP 沒有 unsafe-inline 之後，style 屬性字串會被
  // **靜默**忽略 —— 高度全變 0、圖表變成一排空底、畫面看起來很正常。所以要量瀏覽器真的畫出來的高度。
  const barPx = await page.$$eval('#view .chart-bar-value', (els) => els.map((e) => ({
    h: parseFloat(getComputedStyle(e).height),
    v: e.style.getPropertyValue('--h'),
    parent: parseFloat(getComputedStyle(e.parentElement).height),
  })));
  ok(barPx.length >= 5, `（前提）有 ${barPx.length} 根價值長條`);
  everyOf(barPx, (b) => /^\d+(\.\d+)?%$/.test(b.v), '每一根的 --h 都是百分比');
  ok(barPx.some((b) => b.h > 0), `長條真的有高度（最高 ${Math.max(...barPx.map((b) => b.h)).toFixed(1)}px）—— CSS 變數沒被 CSP 擋掉`);
  everyOf(barPx.filter((b) => parseFloat(b.v) > 0), (b) => b.h > 0 && b.h <= b.parent + 1,
    '--h > 0 的每一根，畫出來的高度都 > 0 且不超過容器');
  // 對照：最高那根的 --h 應該接近 100%（逐年圖以最大值為滿）
  ok(Math.max(...barPx.map((b) => parseFloat(b.v))) >= 99, '（對照）最高那根接近 100%');
  eq(bars, 10, '折線／長條圖有 10 根');
  const yearlyText = await page.$eval('#view [data-card="calcYearly"]', (el) => el.textContent.replace(/\s+/g, ' '));
  noneOf(BANNED.map((w) => ({ w, hit: yearlyText.includes(w) })), (x) => x.hit, '逐年表也沒有禁用詞');

  section('全部清空之後又回到空白');
  await page.evaluate(() => {
    [...document.querySelectorAll('#view .btn')].find((b) => b.textContent === '全部清空').click();
  });
  await page.waitForSelector('#view [data-card="calcInputs"]');
  const after = await numericFields();
  everyOf(after, (f) => f.value === '', '清空之後每一個欄位又都是空字串');
  eq(await page.$('#view [data-card="calcResult"]'), null, '結果區塊也收起來了');

  section('沒填完就按「算一次」不會生出結果');
  // 只填金額、成長率與配息率留白 —— 那一檔必須完全不算，而且要被列出來。
  await fillLeg('0050', 'amount', 3000);
  await page.evaluate(() => {
    [...document.querySelectorAll('#view .btn-primary')].find((b) => b.textContent === '算一次').click();
  });
  await page.waitForSelector('#view [data-card="calcLegs"]');
  await new Promise((r) => setTimeout(r, 400));
  eq(await page.$('#view [data-card="calcResult"]'), null, '沒有結果區塊');
  const pageText = await page.$eval('#view', (el) => el.textContent.replace(/\s+/g, ' '));
  // **不可以拿 0 把結果湊出來** —— 空白代表還沒決定，不是「假設不成長」。
  //
  // 這三條（上面那條 eq(..., null) 與下面兩條 noneOf）在**畫面整個沒渲染**時
  // 會一起通過：沒有結果區塊、頁面文字是空的、正則當然都不命中。
  // 所以先證明頁面還在，而且那一檔的欄位真的在畫面上。
  ok(pageText.length > 50 && pageText.includes('0050'),
    `（前提）試算頁真的還在，而且看得到 0050 那一組欄位（共 ${pageText.length} 字）`,
    pageText.slice(0, 200));
  noneOf([pageText], (t) => /期末手上總共/.test(t), '畫面上沒有任何期末數字');
  noneOf([pageText], (t) => /預設值/.test(t), '也沒有拿預設值湊');

  section('共用設定沒填完：講得出缺什麼');
  await page.evaluate(() => {
    const el = document.querySelector('#view [data-calc-field="years"]');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#view .btn-primary')].find((b) => b.textContent === '算一次').click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const sharedErr = await page.$eval('#view [data-card="calcInputs"]', (el) => el.textContent);
  ok(/請填/.test(sharedErr), `共用設定缺欄位時講得出來：「${/請填[^，。]*/.exec(sharedErr)?.[0]}」`);
  await fill('years', 10);

  section('從你自己的資料帶入：只帶事實，不帶假設');
  //
  // 使用者要的是「不用把已經在 App 裡的數字再打一遍」。
  // 界線在於**帶進來的是事實還是假設**：
  //   事實 → 他自己設定的扣款金額／次數／費率、已經結算出來的市值與收盤價
  //   假設 → 年化成長率、年化配息率（帶了就等於我們替他預測）
  // 前面幾段在欄位裡留了值（金額 3000、期間 10）。這一段要驗「打開時是空的」，
  // 所以先按「全部清空」—— 不清的話量到的是上一段的殘留，那條斷言就白寫了。
  await page.evaluate(() => {
    [...document.querySelectorAll('#view button')].find((b) => b.textContent.trim() === '全部清空')?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const pre = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    const plans = await import('./js/plans.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    const iso = new Date().toLocaleDateString('sv');
    await holdings.addOpening({ code: '0050', shares: 3000, avgCost: 132.4, date: '2026-01-05' });
    await holdings.addOpening({ code: '00878', shares: 8000, avgCost: 20.15, date: '2026-01-05' });
    await plans.save({ code: '0050', amount: 6000, days: [6], feeRate: 0.001425, reinvestDividend: false, active: true, startDate: '2026-01-05', createdAt: '2026-01-05T00:00:00.000Z' });
    await plans.save({ code: '00878', amount: 3000, days: [6, 16], feeRate: 0.001425, reinvestDividend: false, active: true, startDate: '2026-01-05', createdAt: '2026-01-05T00:00:00.000Z' });
    await db.put('settle', {
      date: iso, dayPL: '0', marketValue: null, dividend: null, counted: 2,
      excludedUnsupported: 0, excludedMissing: 0,
      byCode: [
        { code: '0050', shares: 3000, close: 107.7, basis: 109.15, basisSource: 'prevClose', status: 'ok', pl: '-4350000000' },
        { code: '00878', shares: 8000, close: 22.31, basis: 22.61, basisSource: 'prevClose', status: 'ok', pl: '-2400000000' },
      ],
      settledAt: new Date().toISOString(),
    });
    const cv = await import('./js/views/calc.js');
    await cv.default();
    await new Promise((x) => setTimeout(x, 400));

    const val = (k) => document.querySelector(`#view [data-calc-field="${k}"]`)?.value ?? null;
    const legVal = (k) => document.querySelector(`#view [data-leg-field="0050:${k}"]`)?.value ?? null;
    const before = { amount: legVal('amount'), growthRate: legVal('growthRate'), yieldRate: legVal('yieldRate'), feeRate: val('feeRate'), startValue: legVal('startValue') };
    const chips = [...document.querySelectorAll('#view [data-card="calcPrefill"] .chip')]
      .map((c) => ({ code: c.dataset.prefill, text: c.textContent.trim(), h: Math.round(c.getBoundingClientRect().height) }));

    const chip0050 = document.querySelector('#view [data-prefill="0050"]');
    if (!chip0050) return { error: 'prefill 0050 不存在', prefills: [...document.querySelectorAll('#view [data-prefill]')].map((e) => e.dataset.prefill), all };
    chip0050.click();
    await new Promise((x) => setTimeout(x, 400));
    const after = { amount: legVal('amount'), years: val('years'), growthRate: legVal('growthRate'), yieldRate: legVal('yieldRate'), feeRate: val('feeRate'), startValue: legVal('startValue'), price: legVal('price') };
    return {
      before, after, chips,
      done: document.querySelector('#view [data-block="prefillDone"]')?.textContent.replace(/\s+/g, ' ') ?? '',
      notFilled: document.querySelector('#view [data-note="prefillNotFilled"]')?.textContent.replace(/\s+/g, ' ') ?? '',
      cardText: document.querySelector('#view [data-card="calcPrefill"]')?.textContent.replace(/\s+/g, ' ') ?? '',
    };
  });

  // 一開始每一格都是空的（原本就有的規則，這裡再確認一次 —— 帶入功能不可以破壞它）
  everyOf(Object.entries(pre.before), ([, v]) => v === '',
    `還沒按之前每一個數值欄位都是空的（${JSON.stringify(pre.before)}）`);

  // 按鈕是他自己的計畫，不必打字
  ok(pre.chips.length >= 3, `列出他自己的計畫當按鈕（${pre.chips.map((c) => c.code).join('、')}）`);
  everyOf(pre.chips, (c) => c.h >= 44, `按鈕都夠大（${pre.chips.map((c) => `${c.code} ${c.h}px`).join('、')}）`);
  ok(pre.chips.some((c) => c.text.includes('6,000')), '按鈕上就看得到那個計畫每次扣多少');

  // **帶進來的是事實**
  eq(pre.after.amount, '6000', '每期扣款金額 ← 他自己設的 6,000');
  eq(pre.after.feeRate, '0.001425', '手續費率 ← 他自己設的 0.001425');
  // 手算：3,000 股 × 107.70 ＝ 323,100
  eq(pre.after.startValue, '323100', '目前部位市值 ← 3,000 股 × 107.70 ＝ 323,100');
  // 目前股價那一格只有選「股數法」才會出現 —— 先切過去再看。
  const priceAfter = await page.evaluate(async () => {
    document.querySelector('#view [data-calc-chip="method:share"]').click();
    await new Promise((x) => setTimeout(x, 400));
    return document.querySelector('#view [data-leg-field="0050:price"]')?.value ?? null;
  });
  eq(priceAfter, '107.7', '切到股數法之後，目前股價 ← 最後一次結算的收盤價 107.70');

  // **沒帶進來的是假設 —— 這兩格永遠空白**
  eq(pre.after.growthRate, '', '**年化價格成長率還是空的**');
  eq(pre.after.yieldRate, '', '**年化配息率還是空的**');
  eq(pre.after.years, '', '期間也沒有替他決定');
  ok(pre.notFilled.includes('年化價格成長率') && pre.notFilled.includes('年化配息率'),
    `而且畫面上明講哪兩格沒帶：「${pre.notFilled.slice(0, 60)}」`);
  ok(/只有你能決定|不會替你填/.test(pre.notFilled), '也講了為什麼不帶');

  // 帶入之後仍然不准出現任何建議值或方向字
  noneOf(['建議', '推薦', '合理', '常見', '歷史平均', '預期報酬', '殖利率'],
    (w) => pre.cardText.includes(w),
    '帶入卡片上沒有任何建議值或帶方向的字');
  // 對照：這張卡片真的有內容（不是因為空的才沒踩到）
  ok(pre.cardText.length > 60, `（對照）帶入卡片真的有 ${pre.cardText.length} 個字`);

  section('成長率與配息率：不給參考值，但要講清楚為什麼');
  //
  // 使用者要求「每檔自動帶出長期平均值供參考」。查證之後兩個都做不到
  // （FEASIBILITY §12），而且理由不同：
  //   配息率：官方資料只涵蓋上市公司、不含 ETF，而且只有兩個年度
  //   成長率：歷史收盤價未還原分割與配息 —— 0050 在 2025 年 1:4 分割，
  //           直接兩點相除算出來連正負號都相反
  //
  // 所以兩格都留白。**但留白一定要解釋**，否則他會以為是壞了或我們偷懶。
  // 而且要用具體實例講，不要用抽象的技術理由。
  const notes = await page.evaluate(() => ({
    growth: document.querySelector('#view [data-note="noGrowthReference"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    yieldNote: document.querySelector('#view [data-note="noYieldReference"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    fillButtons: [...document.querySelectorAll('#view button')]
      .filter((b) => /填入|套用|帶入這個數字/.test(b.textContent)).map((b) => b.textContent.trim()),
    page: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
  }));

  ok(notes.growth.length > 20, `成長率旁邊有說明（${notes.growth.length} 字）`);
  everyOf(['0050', '1:4', '188.65', '47.57'], (t) => notes.growth.includes(t),
    '而且是用 0050 那個實例講 —— 分割前後的價格都寫出來');
  ok(/正負號/.test(notes.growth), '講出後果：連正負號都會相反');

  ok(notes.yieldNote.length > 20, `配息率旁邊也有說明（${notes.yieldNote.length} 字）`);
  ok(/不含 ETF|只涵蓋上市公司/.test(notes.yieldNote),
    `講出資料範圍：「${notes.yieldNote.slice(0, 44)}」`);
  ok(/兩個年度|只有兩年/.test(notes.yieldNote), '也講出只有兩個年度');

  // **不准有填入按鈕。** 兩格都算不出來，沒有東西可以填；
  // 而把「他領到的錢」換算成百分比就是殖利率 —— 那是使用者明令禁止的。
  eq(notes.fillButtons, [], '沒有任何「填入這個數字」的按鈕');
  noneOf(['殖利率', '歷史平均', '合理', '預期報酬'], (w) => notes.page.includes(w),
    '整頁沒有殖利率、歷史平均、合理、預期報酬這些字');
  ok(notes.page.length > 400, `（對照）整頁真的有 ${notes.page.length} 個字 —— 上一條不是因為頁面是空的`);

  section('標的只列 ETF；選一檔就只剩那一檔');
  // 使用者：「只顯示 ETF 的就好」「選擇其中一檔的話，下方請只顯示選中的那檔」
  // 前面幾段動過 state.legs（選過某一檔、切過股數法），而 calc.js 的 state 是模組層級的。
  // 這一段要驗「打開時列出哪幾檔」，所以**重新載入頁面**拿一個乾淨的 state ——
  // 不重載的話量到的是上一段留下來的清單。
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#view [data-card="calcInputs"]');
  const scope = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    const plans = await import('./js/plans.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    for (const [c, sh] of [['0050', 3000], ['00878', 8000], ['2330', 1000], ['2317', 500]]) {
      await holdings.addOpening({ code: c, shares: sh, avgCost: 100, date: '2026-01-05' });
    }
    await plans.save({ code: '0050', amount: 6000, days: [6], feeRate: 0, reinvestDividend: false, active: true, startDate: '2026-01-05', createdAt: '2026-01-05T00:00:00.000Z' });
    // 「全部持股與計畫」那一顆只有在**算得出市值**時才會出現，所以要有結算紀錄
    await db.put('settle', {
      date: new Date().toLocaleDateString('sv'), dayPL: '0', marketValue: null, dividend: null,
      counted: 4, excludedUnsupported: 0, excludedMissing: 0,
      byCode: [['0050', 107.7], ['00878', 22.31], ['2330', 2410], ['2317', 248]]
        .map(([code, close]) => ({ code, close, basis: close, basisSource: 'prevClose', status: 'ok', pl: '0' })),
      settledAt: new Date().toISOString(),
    });
    const cv = await import('./js/views/calc.js');
    await cv.default();
    await new Promise((r) => setTimeout(r, 400));
    const listed = () => [...document.querySelectorAll('#view [data-leg]')].map((c) => c.dataset.leg);
    const all = listed();
    document.querySelector('#view [data-prefill="0050"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const one = listed();
    document.querySelector('#view [data-prefill="all"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const held = (await (await import('./js/holdings.js')).list()).map((h) => h.code);
    return { all, one, held, back: listed(), note: document.querySelector('#view [data-note="legsScope"]')?.textContent ?? '' };
  });
  // 母體是 2（0050、00878）—— 那是**正確的結果**，不是「有問題的那幾個」。
  // 但下面那條「個股不在裡面」只有在 fixture 真的種了個股時才有意義：
  // 哪天有人把 2330／2317 從 fixture 拿掉，它會變成恆真而且沒人會發現。
  eq(scope.held.sort(), ['0050', '00878', '2317', '2330'],
    '（前提）fixture 裡種了 4 檔：2 檔 ETF ＋ 2 檔個股');
  eq(scope.all.length, 2,
    `（前提）試算頁列出 2 檔 —— 剛好少了那 2 檔個股（實際列出 ${scope.all.join('、')}）`);
  everyOf(scope.all, (c) => c.startsWith('00'), `只列 ETF（${scope.all.join('、')}）`);
  noneOf(scope.all, (c) => c === '2330' || c === '2317', '個股不在裡面');
  ok(scope.all.length >= 2, '（對照）真的有列出東西，不是空的');
  eq(scope.one, ['0050'], '選了 0050 之後下面只剩 0050');
  eq(scope.back.sort(), scope.all.sort(), '按「全部」又回到原本那幾檔（不會把個股帶回來）');
  ok(scope.note.includes('ETF'), '畫面上講明只列 ETF');

  section('沒有頁面錯誤');
  eq(pageErrors.filter((t) => !/favicon|Failed to load resource/i.test(t)), [], '沒有未預期的錯誤');
} finally {
  await browser.close();
  srv.close();
}

// 這裡不是斷言 —— 「有跑到最後一行」這件事本來就由 done() 的斷言數反映。
// 以前寫成 everyOf([1], () => true, …)：述詞是常數、母體是寫死的，永遠不會失敗，
// 卻混進通過數裡，看起來像多驗了一件事。
note('測試跑完了');
done('calcviewtest');
