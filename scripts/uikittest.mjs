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

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('uikittest');
