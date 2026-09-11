// 共用元件與版面慣例（npm run uikittest）。
//
// 起因：使用者實機回報「開關按鈕很不直覺」「修改／停用的樣式不一樣」「時間欄位跑版」。
// 追下去發現同一種互動在 App 裡有三套寫法（滿版主色按鈕／膠囊按鈕／底線文字連結），
// 而且「開關」其實是一顆會換字的按鈕 —— 寫「開啟」到底是目前開著、還是按了會開？
//
// 這支測試守的是**收斂之後不要再散開**：
//   1. 全 App 只有一套切換開關，而且它看起來像開關（軌道＋滑塊會動）
//   2. 沒有人再用底線文字連結當按鈕
//   3. 沒有人再用 <input type="time">（iOS 會拉滿整個卡片，而且空值顯示當下時間）
//   4. 所有可點的東西都 ≥ 44px

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { listen } from './serve.mjs';
import { stripComments } from './srcscan.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const viewFiles = fs.readdirSync(path.join(ROOT, 'js/views'))
  .filter((f) => f.endsWith('.js')).map((f) => `js/views/${f}`);
const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// ---------------------------------------------------------------------------
section('畫面文字裡不可以出現 markdown 記號');
// h() 全部是 textNode，不會渲染 markdown —— 寫 **粗體** 只會讓使用者看到兩個星號。
// 實際發生過：試算器的配息查詢卡片上直接印出「以下都是**過去實際發生的紀錄**」。
// 註解與系統提示不算（系統提示是給模型看的，那裡的 markdown 有意義）。
const uiStrings = (rel) => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const single = [...src.matchAll(/'([^'\n]{4,})'/g)].map((m) => m[1]);
  const tpl = [...src.matchAll(/`([^`]{4,}?)`/g)].map((m) => m[1]);
  return [...single, ...tpl];
};
const markdownish = viewFiles.flatMap((f) => uiStrings(f).filter((t) => /\*\*|^#{1,3} |\[.+\]\(.+\)/.test(t))
  .map((t) => `${f}: ${t.slice(0, 60)}`));
eq(markdownish, [], '畫面字串裡沒有 **粗體**、# 標題或 [連結](網址) 這類記號');
ok(viewFiles.flatMap(uiStrings).length > 50,
  `（母體）掃了 ${viewFiles.flatMap(uiStrings).length} 條畫面字串 —— 上面那條不是因為根本沒抓到字串`);

section('靜態：舊的三套寫法都清乾淨了');
noneOf(viewFiles, (f) => /type:\s*['"]time['"]/.test(read(f)),
  '沒有任何畫面還在用 <input type="time">（iOS 會拉滿整個卡片，空值還顯示當下時間）');
noneOf(viewFiles, (f) => /class:\s*['"]link-btn/.test(read(f)),
  '沒有任何畫面還在用底線文字連結當按鈕（點擊區太小、基線對不齊）');
noneOf(viewFiles, (f) => /role:\s*['"]switch['"]/.test(read(f)),
  '沒有任何畫面自己手刻切換開關 —— 一律用 ui.switchRow()');
ok(/role:\s*['"]switch['"]/.test(read('js/ui.js')),
  '（對照）ui.js 裡確實有那個共用元件 —— 上面那條不是因為整個 App 都沒有開關');
ok(viewFiles.length >= 6, `（母體）檢查了 ${viewFiles.length} 個畫面檔`);

const usesSwitch = viewFiles.filter((f) => /switchRow\(/.test(read(f)));
ok(usesSwitch.length >= 3,
  `而且有 ${usesSwitch.length} 個畫面在用它：${usesSwitch.map((f) => f.split('/').pop()).join('、')}`);

// ---------------------------------------------------------------------------
const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  section('切換開關看起來像開關，而且真的會動');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('#view .switch');

  const sw = await page.evaluate(async () => {
    const el = document.querySelector('#view .switch[data-pref="dayPLIncludeDividend"]');
    const knob = el.querySelector('.switch-knob');
    const before = {
      checked: el.getAttribute('aria-checked'),
      on: el.classList.contains('on'),
      knobX: knob.getBoundingClientRect().left,
      trackW: el.querySelector('.switch-track').getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
    };
    el.click();
    await new Promise((r) => setTimeout(r, 700));
    const el2 = document.querySelector('#view .switch[data-pref="dayPLIncludeDividend"]');
    const after = {
      checked: el2.getAttribute('aria-checked'),
      on: el2.classList.contains('on'),
      knobX: el2.querySelector('.switch-knob').getBoundingClientRect().left,
    };
    const prefs = await import('./js/prefs.js');
    return { before, after, stored: prefs.get('dayPLIncludeDividend') };
  });

  eq(sw.before.role, 'switch', '用的是 role="switch"，不是普通按鈕');
  ok(sw.before.label && sw.before.label.length > 1, `有 aria-label：「${sw.before.label}」`);
  ok(sw.before.height >= 44, `觸控區夠大（${Math.round(sw.before.height)}px ≥ 44px）`);
  ok(sw.before.trackW >= 40, `軌道看得見（寬 ${Math.round(sw.before.trackW)}px）`);
  ok(sw.before.checked !== sw.after.checked, 'aria-checked 有跟著切換');
  ok(sw.before.on !== sw.after.on, '外觀狀態（.on）也跟著切換');
  ok(Math.abs(sw.after.knobX - sw.before.knobX) >= 10,
    `**滑塊真的移動了**（${Math.round(Math.abs(sw.after.knobX - sw.before.knobX))}px）—— 不是只換了字`);
  eq(sw.stored, sw.after.checked === 'true', '而且存進設定了');

  section('時間門檻：時／分下拉，不會被拉滿');
  const time = await page.evaluate(() => {
    const card = document.querySelector('#view [data-card="threshold"]');
    const selects = [...card.querySelectorAll('select')];
    const cardW = card.getBoundingClientRect().width;
    return {
      selects: selects.length,
      timeInputs: card.querySelectorAll('input[type="time"]').length,
      widths: selects.map((s) => Math.round(s.getBoundingClientRect().width)),
      cardW: Math.round(cardW),
      heights: selects.map((s) => Math.round(s.getBoundingClientRect().height)),
      values: selects.map((s) => s.value),
    };
  });
  eq(time.timeInputs, 0, '沒有原生 time 欄位');
  eq(time.selects, 2, '改成時、分兩個下拉');
  everyOf(time.widths, (w) => w < time.cardW * 0.6,
    `每個下拉都不會被拉滿（卡片寬 ${time.cardW}px，下拉 ${time.widths.join('、')}px）`);
  everyOf(time.heights, (hh) => hh >= 44, `下拉夠高按得到（${time.heights.join('、')}px）`);
  eq(time.values, ['15', '00'], '預設值是 15:00（跟 DEFAULT_TODAY_THRESHOLD 一致）');

  section('定期定額：修改／停用是一般按鈕，不是文字連結');
  await page.evaluate(async () => {
    const plans = await import('./js/plans.js');
    const db = await import('./js/db.js');
    await db.clear('plans');
    await plans.save({ code: '2330', amount: 5000, days: [16], reinvest: false });
    location.hash = '#/';
    await new Promise((r) => setTimeout(r, 300));
    location.hash = '#/plans';
  });
  await page.waitForSelector('#view [data-plan-id]');
  const planBtns = await page.evaluate(() => {
    const row = document.querySelector('#view [data-plan-id]');
    const btns = [...row.querySelectorAll('button')];
    return {
      classes: btns.map((b) => b.className),
      labels: btns.map((b) => b.textContent),
      heights: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
      linkBtns: row.querySelectorAll('.link-btn').length,
    };
  });
  eq(planBtns.labels, ['修改', '停用'], '兩顆按鈕');
  everyOf(planBtns.classes, (c) => c.includes('btn'), '都是 .btn（跟「新增一檔」同一套）');
  eq(planBtns.linkBtns, 0, '沒有底線文字連結');
  everyOf(planBtns.heights, (hh) => hh >= 36, `按鈕高度 ${planBtns.heights.join('、')}px`);

  section('持股頁：目前持股在上，兩個入口在下');
  await page.evaluate(() => { location.hash = '#/holdings'; });
  await page.waitForSelector('#view [data-card="holdingsList"]');
  const order = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#view [data-card]')].map((e) => e.dataset.card);
    const entry = document.querySelector('#view [data-card="plansEntry"] a');
    const add = document.querySelector('#view [data-card="addHolding"] button');
    return {
      cards,
      entryClass: entry.className,
      addClass: add.className,
      entryH: Math.round(entry.getBoundingClientRect().height),
    };
  });
  ok(order.cards.indexOf('holdingsList') < order.cards.indexOf('addHolding'),
    `目前持股在「新增持股」上面（順序：${order.cards.join(' → ')}）`);
  ok(order.cards.indexOf('addHolding') < order.cards.indexOf('plansEntry'),
    '「新增持股」在「定期定額」上面');
  eq(order.entryClass, order.addClass,
    `「管理定期定額計畫」與「新增一檔」是同一套按鈕樣式（${order.entryClass}）`);
  ok(order.entryH >= 44, `而且夠大（${order.entryH}px）`);

  section('總覽頁不再放持股明細');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#view .big-number');
  const home = await page.evaluate(() => ({
    text: document.querySelector('#view').textContent,
    rows: document.querySelectorAll('#view .row').length,
  }));
  ok(!home.text.includes('持股明細'), '總覽沒有持股明細區塊');
  eq(home.rows, 0, '總覽上沒有任何持股列（持股頁本來就有，而且更完整）');
  ok(home.text.includes('當日損益'), '（對照）總覽該有的東西還在');

  section('持股頁每一列都看得到當日損益，而且標明是哪一天');
  //
  // 每天盤後最常走的那條路是「總覽看到當日損益 −18,450 → 那是哪一檔造成的？」。
  // 以前持股頁每一列只有股數與均價，要一檔一檔點進去才看得到 —— 路到這裡就斷了。
  const perRow = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    const iso = new Date().toLocaleDateString('sv');
    await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 890.5, date: '2026-01-05' });
    await holdings.addOpening({ code: '0050', shares: 3000, avgCost: 132.4, date: '2026-01-05' });
    await holdings.addOpening({ code: '2317', shares: 500, avgCost: null, date: '2026-01-05' });
    await db.put('settle', {
      date: iso, dayPL: '0', marketValue: null, dividend: null, counted: 2,
      excludedUnsupported: 0, excludedMissing: 1,
      byCode: [
        { code: '2330', shares: 1000, close: 2410, basis: 2430, basisSource: 'prevClose', status: 'ok', pl: '-20000000000' },
        { code: '0050', shares: 3000, close: 107.7, basis: 109.15, basisSource: 'prevClose', status: 'ok', pl: '-4350000000' },
        { code: '2317', shares: 500, close: null, basis: null, basisSource: 'none', status: 'noClose', pl: null },
      ],
      settledAt: new Date().toISOString(),
    });
    const hv = await import('./js/views/holdings.js');
    await hv.default();
    await new Promise((r) => setTimeout(r, 500));
    const card = document.querySelector('#view [data-card="holdingsList"]');
    return {
      head: card.textContent.replace(/\s+/g, ' ').slice(0, 90),
      rows: Object.fromEntries([...card.querySelectorAll('.row')]
        .map((r) => [r.dataset.code, r.textContent.replace(/\s+/g, ' ').trim()])),
      cards: [...document.querySelectorAll('#view [data-card]')].map((c) => c.dataset.card),
      iso,
    };
  });

  // 手算：(2410 − 2430) × 1000 = −20,000，(2410−2430)/2430 = −0.82%
  ok(perRow.rows['2330']?.includes('-20,000'), `2330 那一列看得到 −20,000：「${perRow.rows['2330']}」`);
  ok(perRow.rows['2330']?.includes('-0.82%'), '而且漲跌％是 −0.82%（手算 (2410−2430)/2430）');
  // 手算：(107.70 − 109.15) × 3000 = −4,350，(107.70−109.15)/109.15 = −1.33%
  ok(perRow.rows['0050']?.includes('-4,350'), `0050 那一列看得到 −4,350：「${perRow.rows['0050']}」`);
  ok(perRow.rows['0050']?.includes('-1.33%'), '而且漲跌％是 −1.33%');
  // 百分比是**百分比數字**不是比例：−1.33% 誤寫成 −0.01% 看起來很正常（踩過）
  noneOf(['-0.01%', '-0.00%', '-0.02%'], (v) => perRow.rows['0050']?.includes(v),
    '不是把比例當成百分比直接印（那會變成 −0.01%）');
  // 算不出來的那一檔：講原因，不留白也不寫 0
  ok(perRow.rows['2317']?.includes('尚未取得收盤價'),
    `算不出來的那一檔寫出原因：「${perRow.rows['2317']}」`);
  noneOf([perRow.rows['2317']], (t) => /[+-]?0\b|0%/.test(t.replace(/[0-9]{3,}/g, '')),
    '而且沒有拿 0 頂替');
  ok(perRow.head.includes(`${Number(perRow.iso.slice(5, 7))}/${Number(perRow.iso.slice(8, 10))}`),
    `卡片上標明這些數字是哪一天結算的：「${perRow.head.slice(0, 46)}」`);
  ok(perRow.cards.indexOf('holdingsList') < perRow.cards.indexOf('concentration'),
    `目前持股在產業分布**上面**（順序：${perRow.cards.join(' → ')}）`);

  section('累積已領股利不可以自相矛盾');
  // 「還沒有確認過任何一筆股利。」＋「另有 2 筆已確認但沒有填金額」同時出現過。
  const divCopy = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.clear('events');
    const iso = new Date().toLocaleDateString('sv');
    for (const [i, code] of ['2330', '0050'].entries()) {
      await db.put('events', {
        id: `${code}@x${i}`, code, name: code, exDate: iso, kind: 'cash',
        cashPerShare: 1, stockRate: 0, status: 'confirmed', sharesHeld: 1000,
        amountEst: null, amountActual: null,          // 確認了但沒有金額
      });
    }
    const dv = await import('./js/views/dividends.js');
    await dv.default();
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelector('#view [data-card="dividendSummary"]').textContent.replace(/\s+/g, ' ');
  });
  ok(!divCopy.includes('還沒有確認過任何一筆'),
    `確認過但沒填金額時，不會說「還沒有確認過任何一筆」：「${divCopy.slice(0, 70)}」`);
  ok(divCopy.includes('2 筆'), '而是講出「已經確認了 2 筆，但都還沒有填金額」');
  eq((divCopy.match(/2 筆/g) ?? []).length, 1, '而且只講一次，不是同一件事講兩遍');

  section('每一頁的每一個可點元素都 ≥ 44px（標準與特大字級各掃一次）');
  //
  // 這一條以前只寫在檔案開頭的註解裡，**實際上只驗了切換開關那一顆**。
  // 於是 .btn-sm 長期是 36px —— 而它正好用在最常按的那幾顆：
  // 確認扣款、確認股利、取消確認、修改、停用。實測量出來才發現。
  //
  // 種一份像真的資料再掃：沒有資料的話很多按鈕根本不會出現，掃了等於沒掃。
  const ROUTES_44 = ['/', '/holdings', '/plans', '/dividends', '/calc', '/settings', '/news'];
  const tooSmall = [];
  const counted = [];
  for (const scale of ['md', 'xl']) {
    await page.evaluate(async (sc) => {
      const prefs = await import('./js/prefs.js');
      await prefs.load();
      await prefs.set('fontScale', sc);
      prefs.applyFontScale(sc);
    }, scale);
    for (const route of ROUTES_44) {
      // 目標剛好是現在這一頁的話，設同一個 hash 不會重繪 —— 先去別的路由再回來
      await page.evaluate((r) => { location.hash = r === '/settings' ? '#/' : '#/settings'; }, route);
      await new Promise((r) => setTimeout(r, 350));
      await page.evaluate((r) => { location.hash = `#${r}`; }, route);
      await new Promise((r) => setTimeout(r, 1200));
      const found = await page.evaluate((info) => {
        const out = [];
        let n = 0;
        for (const el of document.querySelectorAll('#view a, #view button, #view select, #view input, #tabbar .tab')) {
          const r = el.getBoundingClientRect();
          if (r.height === 0) continue;             // 藏起來的不算
          n += 1;
          // 勾選框本身是 24px，但**整個 label 才是觸控區**（點文字也會勾）。
          // 有 label 包著就量 label。
          const target = el.type === 'checkbox' ? (el.closest('label') ?? el) : el;
          const h = target.getBoundingClientRect().height;
          if (h < 44) out.push({ ...info, label: (el.textContent.trim() || el.type || el.tagName).slice(0, 16), h: Math.round(h) });
        }
        return { out, n };
      }, { scale, route });
      tooSmall.push(...found.out);
      counted.push({ scale, route, n: found.n });
    }
  }
  await page.evaluate(async () => {
    const prefs = await import('./js/prefs.js');
    await prefs.set('fontScale', 'md');
    prefs.applyFontScale('md');
  });

  const totalClickable = counted.reduce((a, b) => a + b.n, 0);
  ok(totalClickable >= 100,
    `（對照）真的掃到東西了：${ROUTES_44.length} 頁 × 2 種字級，共 ${totalClickable} 個可點元素`);
  everyOf(counted, (c) => c.n >= 3, '每一頁每一種字級都至少掃到 3 個可點元素（沒有哪一頁是空的）');
  eq(tooSmall, [], '沒有任何可點元素低於 44px');

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('uikittest');
