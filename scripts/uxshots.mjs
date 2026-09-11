// 介面走查用的截圖工具（`node scripts/uxshots.mjs`）。**不是測試**，不進 npm test。
//
// 目的：用**一份像真的資料**把七頁都畫出來，標準字級與特大字級各一張，
// 然後人（或我）真的去看。讀程式碼看不出「找不找得到、按不按得到、
// 看不看得懂現在發生什麼事」。
//
// 產出在 .logs/ux/，那個目錄不進版控。

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listen } from './serve.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, '.logs/ux');
fs.mkdirSync(OUT, { recursive: true });

const SCALE = process.argv[2] || 'md';     // md ｜ xl
const ROUTES = [
  ['/', 'home'],
  ['/holdings', 'holdings'],
  ['/plans', 'plans'],
  ['/dividends', 'dividends'],
  ['/calc', 'calc'],
  ['/settings', 'settings'],
  ['/news', 'news'],
];

const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .card');

  page.on("pageerror", (e) => process.stdout.write(`  ⚠ pageerror: ${e.message}
`));
  // ---- 一份像真的資料 ----
  const seedResult = await page.evaluate(async (scale) => {
    const db = await import('./js/db.js');
    const prefs = await import('./js/prefs.js');
    const holdings = await import('./js/holdings.js');
    const iso = new Date().toLocaleDateString('sv');
    const d = (n) => {
      const x = new Date(); x.setDate(x.getDate() - n); return x.toLocaleDateString('sv');
    };

    const problems = [];
    for (const s of db.STORE_NAMES) await db.clear(s);
    await prefs.load();
    await prefs.set('fontScale', scale);
    await prefs.set('insightConsent', true);

    try { await holdings.addOpening({ code: '2330', shares: 1000, avgCost: 890.5, date: d(400) }); } catch (e) { problems.push(`addOpening: ${e.message}`); }
    try { await holdings.addOpening({ code: '0050', shares: 3000, avgCost: 132.4, date: d(300) }); } catch (e) { problems.push(`addOpening: ${e.message}`); }
    try { await holdings.addOpening({ code: '00878', shares: 8000, avgCost: 20.15, date: d(200) }); } catch (e) { problems.push(`addOpening: ${e.message}`); }
    try { await holdings.addOpening({ code: '2317', shares: 500, avgCost: null, date: d(100) }); } catch (e) { problems.push(`addOpening: ${e.message}`); }
    try { await holdings.addOpening({ code: '6488', shares: 200, avgCost: 210, date: d(90) }); } catch (e) { problems.push(`addOpening: ${e.message}`); }

    // 結算（今天）
    await db.put('settle', {
      date: iso, dayPL: '-18450000000', marketValue: '3084500000000', dividend: '4000000000',
      counted: 4, excludedUnsupported: 1, excludedMissing: 0, includeDividend: true,
      byCode: [
        { code: '2330', shares: 1000, close: 2410, basis: 2430, basisSource: 'prevClose', status: 'ok', pl: '-20000000000' },
        { code: '0050', shares: 3000, close: 107.7, basis: 109.15, basisSource: 'prevClose', status: 'ok', pl: '-4350000000' },
        { code: '00878', shares: 8000, close: 22.31, basis: 21.81, basisSource: 'refPrice', status: 'ok', pl: '4000000000' },
        { code: '2317', shares: 500, close: 248, basis: 244.2, basisSource: 'prevClose', status: 'ok', pl: '1900000000' },
        { code: '6488', shares: 200, close: null, basis: null, basisSource: 'none', status: 'unsupported', pl: null },
      ],
      settledAt: new Date().toISOString(),
    });

    // 定期定額：兩檔啟用、一檔停用
    const plans = await import('./js/plans.js');
    try { await plans.save({ code: '0050', amount: 5000, days: [6], feeRate: 0.001425, reinvestDividend: false, active: true, startDate: d(300), createdAt: `${d(300)}T00:00:00.000Z` }); } catch (e) { problems.push(`plans.save: ${e.message}`); }
    try { await plans.save({ code: '00878', amount: 3000, days: [6, 16], feeRate: 0.001425, reinvestDividend: true, active: true, startDate: d(200), createdAt: `${d(200)}T00:00:00.000Z` }); } catch (e) { problems.push(`plans.save: ${e.message}`); }
    try { await plans.save({ code: '2330', amount: 10000, days: [1], feeRate: 0.001425, reinvestDividend: false, active: false, startDate: d(400), createdAt: `${d(400)}T00:00:00.000Z` }); } catch (e) { problems.push(`plans.save: ${e.message}`); }

    // 待確認的扣款
    await db.put('changes', {
      id: `dca-0050-${d(2)}`, code: '0050', date: d(2), deltaShares: 46, price: null,
      estimatePrice: 107.7, kind: 'dca', status: 'pending', planId: (await db.getAll('plans'))[0]?.id,
      amount: 5000, note: '定期定額 5,000 元',
      estimate: { amount: 5000, fee: 7, shares: 46, price: 107.7 },
    });

    // 除權息：一筆待確認、兩筆已確認
    await db.put('events', {
      id: `00878@${d(5)}`, code: '00878', name: '國泰永續高股息', exDate: d(5),
      kind: 'cash', cashPerShare: 0.5, stockRate: 0, status: 'pending', sharesHeld: 8000,
      amountEst: '4000000000', amountActual: null, refPrice: 21.81, refPriceSource: 'twse',
    });
    await db.put('events', {
      id: `0050@${d(70)}`, code: '0050', name: '元大台灣50', exDate: d(70),
      kind: 'cash', cashPerShare: 1.8, stockRate: 0, status: 'confirmed', sharesHeld: 3000,
      amountEst: '5400000000', amountActual: '5400000000', payDate: d(45),
    });
    await db.put('events', {
      id: `2330@${d(120)}`, code: '2330', name: '台積電', exDate: d(120),
      kind: 'cash', cashPerShare: 4, stockRate: 0, status: 'confirmed', sharesHeld: 1000,
      amountEst: '4000000000', amountActual: '4000000000', payDate: d(95),
    });

    // 新聞與今日觀察
    await db.put('news', {
      date: iso,
      items: [
        { id: 'n1', title: '台積電法說會登場，資本支出上調', link: 'https://example.com/1', source: 'cna', publishedAt: new Date().toISOString() },
        { id: 'n2', title: '台股收黑 755 點，權值股全面走弱', link: 'https://example.com/2', source: 'cnyes', publishedAt: new Date().toISOString() },
        { id: 'n3', title: '高股息 ETF 規模再創高', link: 'https://example.com/3', source: 'ltn', publishedAt: new Date().toISOString() },
        { id: 'n4', title: 'Fed officials signal caution on rate path', link: 'https://example.com/4', source: 'cnbc', publishedAt: new Date().toISOString() },
        { id: 'n5', title: 'Chip stocks slide as demand worries mount', link: 'https://example.com/5', source: 'marketwatch', publishedAt: new Date().toISOString() },
      ],
      fetchedAt: Object.fromEntries(['cna', 'cnyes', 'ltn', 'yahoo', 'cnbc', 'marketwatch']
        .map((k) => [k, new Date().toISOString()])),
    });
    await db.put('insights', {
      date: iso, model: 'claude-sonnet-5',
      json: {
        summary: '今天市場整體走弱，權值股帶頭下跌；你的持股裡半導體與市值型 ETF 同步回檔，高股息 ETF 剛除息。',
        sections: [
          { theme: '半導體', newsIds: ['n1', 'n5'], relatedCodes: ['2330'], observation: '法說會提到資本支出上調，同一天國際市場對需求的疑慮升高。兩則消息方向相反，短期波動可能加大。過去不代表未來。' },
          { theme: '高股息 ETF 除息', newsIds: ['n3'], relatedCodes: ['00878'], observation: '你持有的 00878 在本週除息，參考價已反映息值，帳面市值的變化有一部分來自這件事而不是漲跌。' },
        ],
        watchDates: [{ date: iso, what: '00878 除息' }, { date: iso, what: '台積電法說會' }],
      },
      usage: { inputTokens: 4200, outputTokens: 620 },
      createdAt: new Date().toISOString(),
    });

    // 金鑰（假的，只是讓設定頁與今日觀察顯示成已設定的樣子）
    await db.put('secrets', { provider: 'anthropic', key: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE', model: 'claude-sonnet-5', capMicroUsd: 2000000, usage: {} });

    prefs.applyFontScale(scale);
    return { iso, problems };
  }, SCALE);
  const today = seedResult.iso;
  for (const p2 of seedResult.problems) process.stdout.write(`  ⚠ ${p2}
`);

  for (const [route, name] of ROUTES) {
    // 先去一個**不一樣**的路由再回來 —— 目標剛好就是 '#/' 的話，設同一個 hash
    // 不會觸發任何重繪，畫面會留在開機當下（種資料之前）那一版。（踩過。）
    await page.evaluate((r) => { location.hash = r === '/settings' ? '#/' : '#/settings'; }, route);
    await new Promise((r) => setTimeout(r, 450));
    await page.evaluate((r) => { location.hash = `#${r}`; }, route);
    await new Promise((r) => setTimeout(r, 1800));
    const file = path.join(OUT, `${name}-${SCALE}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const info = await page.evaluate(() => ({
      title: document.getElementById('topTitle')?.textContent,
      h: document.querySelector('#view')?.scrollHeight,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    process.stdout.write(`${name.padEnd(10)} ${String(info.title).padEnd(14)} 高 ${info.h}px`
      + `${info.overflowX ? '  ⚠ 橫向爆版' : ''}\n`);
  }
  process.stdout.write(`\n截圖在 .logs/ux/（字級 ${SCALE}，資料日 ${today}）\n`);
} finally {
  await browser.close();
  srv.close();
}
