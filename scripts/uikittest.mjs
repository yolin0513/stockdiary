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
import { ok, eq, section, done, noneOf, everyOf, note } from './tap.mjs';
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

  section('賣出的對話框要講「不記錄已實現損益」');
  // UI 提供了賣出（股數填負數），但 PLAN 第 23 行把已實現損益列為不做的指標。
  // 提供了一個動作卻不說它的後果，使用者賣完找不到賺賠只會以為 App 壞了。
  const sellNote = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 500, date: '2026-01-05' });
    const dv = await import('./js/views/holding.js');
    await dv.default('2330');
    await new Promise((r) => setTimeout(r, 400));
    [...document.querySelectorAll('#view button')].find((b) => b.textContent.includes('新增一筆變動')).click();
    await new Promise((r) => setTimeout(r, 500));
    const m = document.querySelector('#modalRoot')?.firstElementChild;
    const text = m?.textContent.replace(/s+/g, ' ').trim() ?? '';
    [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消').click();
    return text;
  });
  ok(/賣出填負數/.test(sellNote), '講得出怎麼賣出');
  ok(/不會改變平均成本/.test(sellNote), '講明賣出不改均價（平均成本法）');
  ok(/不記錄已實現損益/.test(sellNote),
    `而且明講不記錄已實現損益：「${/這個 App 不記錄[^。]*。/.exec(sellNote)?.[0]}」`);
  ok(/自己另外記/.test(sellNote), '也講了他該怎麼辦');
  // 不可以承諾一個不存在的欄位（寫過「在下面的備註欄寫下來」，但那個對話框根本沒有備註欄）
  noneOf([sellNote], (t) => /備註欄/.test(t), '沒有提到一個不存在的備註欄');
  section('對帳會差在哪，畫面上要先講');
  //
  // 兩句話，都是「不講他就會以為 App 壞了」的那種：
  //
  //   成本不含手續費：使用者拿國泰 App 對帳，成本差 252 元。實算下來那大約是
  //     2 折的買進手續費（858,685 × 0.1425% × 0.2 ≈ 245）。我們的成本只有
  //     成交價 × 股數（js/avgcost.js 沒有任何 fee 項，PLAN 第 23 行也把手續費
  //     列為「不做的指標」）—— 是定義不同，不是算錯。但不講他每次都會再懷疑一次。
  //
  //   主畫面 App 與 Safari 的儲存是分開的：在 Safari 匯出、到主畫面 App 匯入，
  //     資料會不見。而匯出／匯入是這個 App 換機與救援的**唯一**路徑。
  const disclose = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    const iso = new Date().toLocaleDateString('sv');
    await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 890.5, date: '2026-01-05' });
    await db.put('settle', {
      date: iso, dayPL: '0', marketValue: '2410000000000', dividend: null, counted: 1,
      excludedUnsupported: 0, excludedMissing: 0,
      byCode: [{ code: '2330', shares: 1000, close: 2410, basis: 2410, basisSource: 'prevClose', status: 'ok', pl: '0' }],
      settledAt: new Date().toISOString(),
    });
    const home = await import('./js/views/home.js');
    await home.default();
    await new Promise((r) => setTimeout(r, 400));
    const cost = document.querySelector('#view [data-note="costExcludesFee"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    const unrealCard = document.querySelector('#view [data-card="unrealized"]')?.textContent.replace(/\s+/g, ' ') ?? '';

    const sv = await import('./js/views/settings.js');
    await sv.default();
    await new Promise((r) => setTimeout(r, 400));
    const backup = document.querySelector('#view [data-card="backup"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    const split = document.querySelector('#view [data-note="storageSplit"]')?.textContent.trim() ?? '';
    return { cost, unrealCard, backup, split };
  });

  // ---- A2：成本不含手續費 ----
  ok(disclose.cost.length > 20, `未實現損益卡片上有說明（${disclose.cost.length} 字）`);
  everyOf(['手續費', '券商'], (t) => disclose.cost.includes(t),
    `講出「我們沒加手續費、券商有加」：「${disclose.cost.slice(0, 46)}」`);
  ok(/高一點|低一點/.test(disclose.cost), '而且講出方向（券商的成本會比較高）');
  // 用白話講，不要丟術語
  noneOf(['加權平均成本法', '成本基礎', 'cost basis'], (t) => disclose.cost.includes(t),
    '沒有丟術語');
  ok(disclose.unrealCard.includes('未實現損益'), '（對照）那張卡真的是未實現損益');

  // ---- A1：主畫面 App 與 Safari 不共用 ----
  ok(disclose.split.length > 10, '備份區塊有「只存在這台手機」的說明');
  everyOf(['主畫面', 'Safari', '不共用'], (t) => disclose.backup.includes(t),
    `講出兩邊的儲存是分開的：「${/iPhone[^。]*。/.exec(disclose.backup)?.[0]?.slice(0, 50)}」`);
  ok(/在哪一邊匯出，就要在哪一邊匯入/.test(disclose.backup), '而且講得出該怎麼辦');
  ok(/換手機|清掉瀏覽器資料|移除/.test(disclose.backup), '也講了什麼情況會失去資料');
  ok(disclose.backup.includes('不含 API 金鑰'), '（對照）原本就有的說明還在');

  section('每天盤後的兩條路徑：提示列、入口、確認之後的回饋');
  //
  // 走查發現的四件事，每一條都是他每天會踩到的：
  //   A 提示列答應兩件事只給一件（合併成一條、只帶去股利頁，而股利頁上
  //     一個通往定期定額的連結都沒有）
  //   B 除息日被當成入帳日（證交所沒有公布發放日，四個官方端點都實測過）
  //   C 確認之後只說「已確認」，沒說確認了什麼 —— 他手上正拿著券商通知在對
  //   D 總覽答不出「是哪一檔」，整頁沒有代號也沒有通往持股頁的連結
  const daily = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    const plans = await import('./js/plans.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toLocaleDateString('sv'); };
    const iso = new Date().toLocaleDateString('sv');
    await holdings.addOpening({ code: '0050', shares: 3000, avgCost: 132.4, date: d(300) });
    await holdings.addOpening({ code: '00878', shares: 8000, avgCost: 20.15, date: d(200) });
    await plans.save({ code: '0050', amount: 6000, days: [6], feeRate: 0.001425, reinvestDividend: false, active: true, startDate: d(300), createdAt: `${d(300)}T00:00:00.000Z` });
    await db.put('settle', {
      date: iso, dayPL: '-6750000000', marketValue: '500000000000', dividend: null, counted: 2,
      excludedUnsupported: 0, excludedMissing: 0, includeDividend: true,
      byCode: [
        { code: '0050', shares: 3000, close: 107.7, basis: 109.15, basisSource: 'prevClose', status: 'ok', pl: '-4350000000' },
        { code: '00878', shares: 8000, close: 22.31, basis: 22.61, basisSource: 'prevClose', status: 'ok', pl: '-2400000000' },
      ],
      settledAt: new Date().toISOString(),
    });
    const planId = (await db.getAll('plans'))[0].id;
    await db.put('changes', {
      id: `dca-0050-${d(2)}`, code: '0050', date: d(2), deltaShares: 55, price: null,
      estimatePrice: 107.7, kind: 'dca', status: 'pending', planId, amount: 6000, note: '定期定額 6,000 元',
      estimate: { amount: 6000, fee: 9, shares: 55, price: 107.7, remainder: '377500000' },
    });
    await db.put('events', {
      id: `00878@${d(5)}`, code: '00878', name: '國泰永續高股息', exDate: d(5), kind: 'cash',
      cashPerShare: 0.55, stockRate: 0, status: 'pending', sharesHeld: 8000,
      amountEst: '4400000000', amountActual: null, refPrice: 22.61, refPriceSource: 'twse',
    });

    const home = await import('./js/views/home.js');
    await home.default();
    await new Promise((r) => setTimeout(r, 400));
    const banners = [...document.querySelectorAll('#view a.banner')].map((x) => ({
      card: x.dataset.card, href: x.getAttribute('href'),
      text: x.textContent.replace(/\s+/g, ' ').trim(),
      h: Math.round(x.getBoundingClientRect().height),
    }));
    const perHolding = (() => {
      const a = document.querySelector('#view [data-link="perHolding"]');
      return a ? { href: a.getAttribute('href'), h: Math.round(a.getBoundingClientRect().height), text: a.textContent.trim() } : null;
    })();
    const newsBtn = (() => {
      const a = document.querySelector('#view [data-link="news"]');
      return a ? { href: a.getAttribute('href'), h: Math.round(a.getBoundingClientRect().height), text: a.textContent.trim() } : null;
    })();
    const homeText = document.querySelector('#view').textContent.replace(/\s+/g, ' ');
    const tabs = [...document.querySelectorAll('#tabbar .tab')].map((t) => t.textContent.trim());

    // 確認扣款
    const pv = await import('./js/views/plans.js');
    await pv.default();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#view [data-card="pendingChanges"] .row button').click();
    await new Promise((r) => setTimeout(r, 500));
    const m1 = document.querySelector('#modalRoot').firstElementChild;
    [...m1.querySelectorAll('button')].find((x) => x.textContent.trim() === '確認').click();
    await new Promise((r) => setTimeout(r, 500));
    const dcaToast = (() => { const e = document.getElementById('toast'); return e && !e.hidden ? e.textContent.trim() : ''; })();
    const hd = await db.get('holdings', '0050');

    // 確認股利
    const dv = await import('./js/views/dividends.js');
    await dv.default();
    await new Promise((r) => setTimeout(r, 400));
    const divCard = document.querySelector('#view [data-card="pendingEvents"]');
    const divCardText = divCard.textContent.replace(/\s+/g, ' ').trim();
    const divRowDate = divCard.querySelector('.row-code').textContent.trim();
    divCard.querySelector('.row button').click();
    await new Promise((r) => setTimeout(r, 500));
    const m2 = document.querySelector('#modalRoot').firstElementChild;
    const divModalText = m2.textContent.replace(/\s+/g, ' ').trim();
    [...m2.querySelectorAll('button')].find((x) => x.textContent.trim() === '確認').click();
    await new Promise((r) => setTimeout(r, 500));
    const divToast = (() => { const e = document.getElementById('toast'); return e && !e.hidden ? e.textContent.trim() : ''; })();

    return { banners, perHolding, newsBtn, homeText, tabs, dcaToast, divToast, shares: hd.shares, avgCost: hd.avgCost, divCardText, divRowDate, divModalText };
  });

  // ---- A：一種一條，各自帶到自己那一頁 ----
  eq(daily.banners.length, 2, `兩種待確認 → **兩條**提示列（${daily.banners.map((b2) => b2.card).join('、')}）`);
  eq(daily.banners.map((b2) => b2.href).sort(), ['#/dividends', '#/plans'],
    '一條帶去股利、一條帶去定期定額 —— 沒有哪一種是沒有路的');
  everyOf(daily.banners, (b2) => b2.h >= 44, `兩條都夠大（${daily.banners.map((b2) => `${b2.h}px`).join('、')}）`);
  ok(daily.banners.some((b2) => /除權息/.test(b2.text) && b2.href === '#/dividends'),
    '講除權息的那一條帶去股利頁');
  ok(daily.banners.some((b2) => /扣款/.test(b2.text) && b2.href === '#/plans'),
    '講扣款的那一條帶去定期定額頁');
  noneOf(daily.banners, (b2) => /除權息/.test(b2.text) && /扣款/.test(b2.text),
    '**沒有任何一條同時答應兩件事**（那正是以前只給一件的原因）');

  // ---- 總覽**不要**「看每一檔的當日損益」那顆按鈕 ----
  //
  // 那顆是 v0.7.10 加的（走查發現總覽答不出「是哪一檔」），
  // 使用者在 v0.7.11 之後**明確說不要** —— 底部的「持股」分頁本來就到得了。
  // 這條斷言是為了**不要再自動加回來**：下次有人（包括我）又覺得
  // 「總覽應該有一條路過去」的時候，這裡會紅，並且看到這段註解。
  eq(daily.perHolding, null, '總覽上沒有「看每一檔的當日損益」按鈕（使用者明確決定移除）');
  // 對照：那條路其實一直都在 —— 底部分頁的「持股」
  ok(daily.tabs.some((t) => t.includes('持股')), `（對照）底部分頁還是到得了持股（${daily.tabs.join('、')}）`);
  // 資料狀態也搬走了。
  // 母體是一個字串 —— 總覽沒渲染時 homeText 會是空的，這條就變成一句空話。
  ok(daily.homeText.length > 50,
    `（前提）總覽真的畫出來了，共 ${daily.homeText.length} 字`,
    daily.homeText.slice(0, 200));
  noneOf([daily.homeText], (t) => t.includes('資料狀態'),
    '總覽上也沒有「資料狀態」那張卡（已併進設定頁的「資料來源與狀態」）');
  ok(daily.newsBtn?.href === '#/news' && daily.newsBtn.h >= 44,
    `新聞有一顆明顯的按鈕：「${daily.newsBtn?.text}」${daily.newsBtn?.h}px`);

  // ---- C：確認之後講得出確認了什麼 ----
  // 手算：3,000 ＋ 55 ＝ 3,055 股
  eq(daily.shares, 3055, '（前提）扣款真的記進去了：3,000 ＋ 55 ＝ 3,055 股');
  everyOf(['0050', '55', '3,055'], (t) => daily.dcaToast.includes(t),
    `確認扣款的回饋講得出代號、加了幾股、現在有幾股：「${daily.dcaToast}」`);
  ok(/131\.9[56]/.test(daily.dcaToast), '也講得出加權後的均價 —— 他手上正拿著券商通知在對');
  ok(daily.dcaToast !== '已確認', '**不是只說「已確認」**');

  // ---- B：除息日不是入帳日 ----
  ok(daily.divRowDate.startsWith('除息'),
    `待確認那一列的日期標成「除息」：「${daily.divRowDate}」`);
  everyOf(['除息日，不是入帳日', '沒有公布發放日', '不會消失'],
    (t) => daily.divCardText.includes(t),
    '卡片講清楚：那是除息日、證交所沒有發放日、這筆不會消失');
  everyOf(['00878', '4,400'], (t) => daily.divToast.includes(t),
    `確認股利的回饋講得出代號與記入的金額：「${daily.divToast}」`);
  ok(/還沒收到通知/.test(daily.divModalText),
    '確認對話框也講了「還沒收到通知就先取消」');
  // 不可以憑空生出一個入帳日
  noneOf(['入帳日：', '預計入帳', '發放日：'], (t) => daily.divCardText.includes(t),
    '**沒有編出一個入帳日** —— 四個官方端點都沒有這個欄位');

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

  section('設定頁每一個控制項都點得到，而且點了有反應');
  //
  // 使用者回報（v0.7.17）：「設定頁無法點擊」。桌面、手機視口、有無金鑰、換版路徑
  // 全部重現不出來 —— 但這個 App 到那時為止**沒有任何一條斷言**在守「設定頁的每個
  // 控制項都真的點得到」。有沒有 overlay 蓋住、有沒有例外讓整頁事件失效、
  // 點下去狀態有沒有變 —— 這三件事分開驗。
  //
  // 「點得到」用 elementFromPoint 驗：那是瀏覽器自己的命中測試，
  // 任何 z-index／pointer-events／位移造成的遮蔽都逃不過它。
  // 「有反應」用真的 click 驗：狀態（aria-checked、location.hash）要真的變。
  {
    const errsBefore = pageErrors.length;
    const r = await page.evaluate(async () => {
      const secrets = await import('./js/secrets.js');
      const prefs = await import('./js/prefs.js');
      const settings = await import('./js/views/settings.js');
      // 種一把假金鑰：有金鑰才會畫「AI 金鑰」那張卡（用量上限欄位在那裡）
      if (!(await secrets.hasKey())) await secrets.save({ key: 'sk-ant-api03-' + 'A'.repeat(50) });

      const scan = async () => {
        location.hash = '#/settings';
        await settings.default();
        await new Promise((z) => setTimeout(z, 300));
        const els = [...document.querySelectorAll(
          '#view button, #view [role="switch"], #view input, #view select, #tabbar .tab')];
        const blocked = [];
        const noPointer = [];
        for (const el of els) {
          el.scrollIntoView({ block: 'center' });
          await new Promise((z) => setTimeout(z, 15));
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          const label = (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 14);
          if (!(hit && (hit === el || el.contains(hit)))) {
            blocked.push({ label, hit: hit ? `${hit.tagName}.${hit.className}` : null });
          }
          for (let a = el; a; a = a.parentElement) {
            if (getComputedStyle(a).pointerEvents === 'none') { noPointer.push(label); break; }
          }
        }
        window.scrollTo(0, 0);
        return { count: els.length, blocked, noPointer,
          cards: [...document.querySelectorAll('#view .card')].map((c) => c.dataset.card ?? c.querySelector('.card-title')?.textContent ?? '?') };
      };

      const md = await scan();
      await prefs.set('fontSize', 'xl');
      const xl = await scan();
      await prefs.set('fontSize', 'md');
      await settings.default();
      await new Promise((z) => setTimeout(z, 300));

      // 真的點：開關要翻、分頁要走
      const sw = document.querySelector('#view [role="switch"]');
      const swBefore = sw.getAttribute('aria-checked');
      sw.click();
      await new Promise((z) => setTimeout(z, 300));
      const swAfter = document.querySelector('#view [role="switch"]').getAttribute('aria-checked');
      sw.click();   // 翻回去，不留副作用
      await new Promise((z) => setTimeout(z, 200));

      const capField = document.querySelector('#view [data-field="aiCap"]');
      const capBtn = [...document.querySelectorAll('#view button')].find((b) => b.textContent === '儲存上限');
      const capBefore = (await secrets.status()).capMicroUsd;
      capField.value = '3.25';
      capBtn.click();
      await new Promise((z) => setTimeout(z, 400));
      const capAfter = (await secrets.status()).capMicroUsd;
      await secrets.setCap(capBefore);

      const homeTab = document.querySelector('#tabbar .tab[href="#/"]');
      homeTab.click();
      await new Promise((z) => setTimeout(z, 500));
      const hashAfterTab = location.hash;

      return { md, xl, swBefore, swAfter, capBefore, capAfter, hashAfterTab };
    });

    ok(r.md.cards.includes('aiKeyConfigured'),
      `（前提）有金鑰，所以「AI 金鑰」那張卡在畫面上（${r.md.cards.join('、')}）`);
    ok(r.md.count >= 20, `（前提）設定頁＋分頁列掃到 ${r.md.count} 個控制項`);
    eq(r.md.blocked, [], '標準字級：每一個控制項的中心點，命中測試都打到它自己（沒有東西蓋在上面）');
    eq(r.md.noPointer, [], '標準字級：沒有任何控制項或它的祖先被設成 pointer-events: none');
    eq(r.xl.count, r.md.count, '特大字級下控制項數量一樣（沒有哪個因為版面擠掉而消失）');
    eq(r.xl.blocked, [], '特大字級：命中測試一樣全部打到自己');
    eq(r.xl.noPointer, [], '特大字級：一樣沒有 pointer-events: none');

    ok(r.swBefore !== r.swAfter, `真的點開關，狀態真的翻了（${r.swBefore} → ${r.swAfter}）`);
    eq(r.capAfter, 3250000, `真的點「儲存上限」，設定真的存進去了（${r.capBefore} → ${r.capAfter} 微美金）`);
    eq(r.hashAfterTab, '#/', '從設定頁點底部的「總覽」分頁，真的走得出去');
    eq(pageErrors.length, errsBefore, '整段沒有新的頁面例外（例外會讓整頁事件失效，那正是「無法點擊」的一種成因）');
  }

  section('對話框：焦點關在裡面、關掉還回去、後面的頁面 inert（A3）');
  //
  // 鍵盤與讀屏使用者按 Tab 會跑到對話框後面那一頁，畫面上什麼都看不出來 ——
  // 只有他們知道自己迷路了。四件事分開驗：焦點在卡片內、Tab 循環、#app inert、關閉後還原。
  {
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForFunction(() => document.getElementById('topTitle')?.textContent === '設定');
    const opened = await page.evaluate(async () => {
      const ui = await import('./js/ui.js');
      // 自己放一顆觸發鈕並聚焦，才有「打開它的是誰」可以還原
      const trigger = ui.h('button', { class: 'btn', id: '__trigger' }, '開對話框');
      document.querySelector('#view').prepend(trigger);
      trigger.focus();
      window.__dlg = ui.modal({
        title: '測試用對話框',
        body: ui.h('p', {}, '內容'),
        actions: [{ label: '取消', value: false }, { label: '確定', value: true, primary: true }],
      });
      await new Promise((r) => setTimeout(r, 120));
      const card = document.querySelector('.modal-card');
      return {
        activeInCard: !!card && card.contains(document.activeElement),
        appInert: document.getElementById('app').inert === true,
        labelledby: card?.getAttribute('aria-labelledby') ?? null,
        titleId: card?.querySelector('.modal-title')?.id ?? null,
        focusables: card ? card.querySelectorAll('button, input, select, textarea, a[href]').length : 0,
      };
    });
    ok(opened.activeInCard, '打開之後焦點在卡片裡');
    eq(opened.appInert, true, '對話框開著時 #app 是 inert（後面的東西走不到、唸不到、點不到）');
    ok(opened.labelledby && opened.labelledby === opened.titleId,
      `aria-labelledby 指向標題（${opened.labelledby}）—— 讀屏開啟時會唸出這是什麼對話框`);
    ok(opened.focusables >= 2, `（前提）卡片裡有 ${opened.focusables} 個可聚焦的東西，Tab 循環才有意義`);

    // 連按 Tab 十次：每一次焦點都還在卡片內
    const trail = [];
    for (let i = 0; i < 10; i += 1) {
      // puppeteer 不認 'Shift+Tab' 這種組合寫法，要自己按住 Shift
      if (i % 3 === 2) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
      } else {
        await page.keyboard.press('Tab');
      }
      trail.push(await page.evaluate(() => {
        const card = document.querySelector('.modal-card');
        return { inCard: !!card && card.contains(document.activeElement), tag: document.activeElement?.textContent?.trim().slice(0, 6) };
      }));
    }
    everyOf(trail, (t) => t.inCard, `連按 Tab／Shift+Tab 十次，焦點都關在卡片裡（${trail.map((t) => t.tag).join('→')}）`);
    ok(new Set(trail.map((t) => t.tag)).size >= 2, '（對照）焦點真的有在卡片內移動，不是卡在同一顆');

    const closed = await page.evaluate(async () => {
      [...document.querySelectorAll('.modal-card button')].find((b) => b.textContent === '取消').click();
      const val = await window.__dlg;
      await new Promise((r) => setTimeout(r, 60));
      const out = {
        value: val,
        overlayGone: !document.querySelector('.modal-overlay'),
        appInert: document.getElementById('app').inert === true,
        focusBackOnTrigger: document.activeElement?.id === '__trigger',
      };
      document.getElementById('__trigger')?.remove();
      return out;
    });
    eq(closed.overlayGone, true, '（前提）對話框關掉了');
    eq(closed.appInert, false, '關掉之後 #app 不再 inert');
    eq(closed.focusBackOnTrigger, true, '焦點回到打開它的那顆按鈕（讀屏不會掉回頁面頂端）');
  }

  section('讀屏：圖示不朗讀、分頁有名稱、開關不重複唸（A4）');
  {
    const a11y = await page.evaluate(() => ({
      tabIcons: [...document.querySelectorAll('#tabbar .tab-icon')].map((e) => e.getAttribute('aria-hidden')),
      tabLabels: [...document.querySelectorAll('#tabbar .tab .tab-label')].map((e) => e.textContent.trim()),
      switchStates: [...document.querySelectorAll('#view .switch-state')].map((e) => e.getAttribute('aria-hidden')),
      switchLabels: [...document.querySelectorAll('#view [role="switch"]')].map((e) => e.getAttribute('aria-label') || ''),
      viewLive: document.getElementById('view').getAttribute('aria-live'),
    }));
    ok(a11y.tabIcons.length >= 4, `（前提）分頁列有 ${a11y.tabIcons.length} 個圖示`);
    everyOf(a11y.tabIcons, (v) => v === 'true', '每個分頁圖示都 aria-hidden（emoji 對讀屏是「圖形」不是字）');
    everyOf(a11y.tabLabels, (t) => t.length > 0, `每個分頁的名稱都是文字（${a11y.tabLabels.join('、')}）—— 以前無障礙樹裡這些連結沒有名字`);
    ok(a11y.switchStates.length >= 1, `（前提）設定頁有 ${a11y.switchStates.length} 個開關的「開／關」字`);
    everyOf(a11y.switchStates, (v) => v === 'true', '開關旁的「開／關」字 aria-hidden（aria-checked 已經表達了，再唸是重複）');
    everyOf(a11y.switchLabels, (t) => t.length > 0, '（對照）每個開關仍然有 aria-label，讀屏唸得出是哪個設定');
    eq(a11y.viewLive, null, '#view 不是 aria-live（不然每次換頁讀屏會把整頁唸一遍）');
  }

  section('鍵盤焦點看得見（A5）');
  //
  // 以前一筆 focus 樣式都沒有：自訂外觀把瀏覽器預設 outline 蓋掉，在深色底上等於隱形。
  // 用鍵盤真的 Tab 過去（:focus-visible 只在鍵盤聚焦時亮），量 computed outline。
  {
    const samples = [];
    for (const [hash, waitTitle] of [['#/settings', '設定'], ['#/holdings', '持股'], ['#/', 'StockDiary 股息日記']]) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForFunction((t) => document.getElementById('topTitle')?.textContent === t, {}, waitTitle);
      await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        const st = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          return { tag: el.tagName, cls: el.className, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 10),
            style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, matches: el.matches(':focus-visible') };
        });
        if (st) samples.push({ page: hash, ...st });
      }
    }
    ok(samples.length >= 6, `（前提）三頁用鍵盤 Tab 取樣到 ${samples.length} 個聚焦元素`);
    const visible = samples.filter((x) => x.matches);
    ok(visible.length >= 6, `（前提）其中 ${visible.length} 個處於 :focus-visible（鍵盤聚焦）`);
    everyOf(visible, (x) => x.style !== 'none' && parseFloat(x.width) >= 2,
      `每一個鍵盤聚焦的元素都有 ≥2px 的 outline（${visible.map((x) => `${x.text || x.tag}:${x.width}`).join('、')}）`);
    everyOf(visible, (x) => !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(x.color),
      'outline 的顏色不是透明');
    // 對照：滑鼠點的不該亮（:focus-visible 語意）—— 用 click 聚焦一顆按鈕再量
    const mouse = await page.evaluate(async () => {
      const b = document.querySelector('#tabbar .tab');
      b.click();
      await new Promise((r) => setTimeout(r, 50));
      const el = document.activeElement;
      return { isTab: el === b, fv: el?.matches(':focus-visible') ?? null };
    });
    note(`（對照）滑鼠點分頁：聚焦=${mouse.isTab}，focus-visible=${mouse.fv}（滑鼠點不亮框是刻意的，但各瀏覽器判準不同，只記錄不斷言）`);
  }

  eq(pageErrors, [], '整段沒有未攔截的例外');
} finally {
  await browser.close();
  srv.close();
}

done('uikittest');
