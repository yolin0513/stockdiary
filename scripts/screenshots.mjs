// 功能截圖（npm run screenshots）。
//   預設      打本機、空資料
//   --demo    本機 ＋ 塞一組示範持股與假的證交所回應（截圖用，不會寫到任何真實環境）
//   --live    打線上
//
// 示範資料用真實代號與真實價格結構，但**它是示範**，檔名放在 screenshots/features/ 下。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { listen } from './serve.mjs';
import { makeCalendar, latestPublishedTradingDay, DEFAULT_TODAY_THRESHOLD } from '../js/market.js';
import { isoToRocCompact } from '../js/roc.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'screenshots', 'features');
const live = process.argv.includes('--live');
const demo = process.argv.includes('--demo');

fs.mkdirSync(OUT, { recursive: true });

// ---- 示範用的假證交所回應 ----
const calJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'calendar.json'), 'utf8'));
const EXPECTED = latestPublishedTradingDay(makeCalendar(calJson), new Date(), DEFAULT_TODAY_THRESHOLD);
// calendar.json 是多年格式，沒有頂層 tradingDays；makeCalendar 新舊格式都讀得懂。
const ALL_TRADING_DAYS = makeCalendar(calJson).days;
const CSV = [
  '日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數',
  ...[
    ['2330', '台積電', '2450.00', '-15.0000'],
    ['2317', '鴻海', '251.00', '0.5000'],
    ['0050', '元大台灣50', '109.15', '-0.5000'],
  ].map(([c, n, close, chg]) =>
    `"${isoToRocCompact(EXPECTED)}","${c}","${n}","1000","1000","${close}","${close}","${close}","${close}","${chg}","10"`),
].join('\n') + '\n';

const DEMO_HOLDINGS = [
  { code: '2330', shares: 1000, avgCost: 1000, date: '2026-01-05' },
  { code: '2317', shares: 2000, date: '2026-02-10' },
  { code: '6488', shares: 500, date: '2026-03-02' },
];

const rocChars = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${Number(y) - 1911}年${m}月${d}日`;
};
const TWT48U = {
  stat: 'OK',
  fields: ['除權除息日期', '股票代號', '名稱', '除權息', '無償配股率', '現金增資配股率', '現金增資認購價', '現金股利',
    '詳細資料', '參考價<br>試算', '最近一次申報資料 季別/日期', '最近一次申報每股 (單位)淨值', '最近一次申報每股 (單位)盈餘'],
  data: [
    [rocChars(EXPECTED), '2330', '台積電', '息', '0.00000000', '0.00000000', '0.00000000', '5.00000000', '', '', '', '', ''],
    ['115年10月16日', '2317', '鴻海', '息', '0.00000000', '0.00000000', '0.00000000', '5.80000000', '', '', '', '', ''],
  ],
};
const TWT49U = {
  stat: 'OK',
  fields: ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息',
    '漲停價格', '跌停價格', '開盤競價基準', '減除股利參考價', '詳細資料',
    '最近一次申報資料 季別/日期', '最近一次申報每股 (單位)淨值', '最近一次申報每股 (單位)盈餘'],
  data: [[rocChars(EXPECTED), '2330', '台積電', '2455.00', '2450.00', '5.000000', '息', '2700.00', '2210.00', '2450.00', '2450.00', '', '', '', '']],
};

const SHOTS = demo
  ? [
    { name: 'home', hash: '#/', wait: '#view .big-number' },
    { name: 'holdings', hash: '#/holdings', wait: '#view .rows' },
    { name: 'holding-detail', hash: '#/holdings/2330', wait: '#view .card' },
    { name: 'holding-unsupported', hash: '#/holdings/6488', wait: '#view .card' },
    { name: 'dividends', hash: '#/dividends', wait: '#view .card' },
    { name: 'plans', hash: '#/plans', wait: '#view .card' },
    { name: 'calc', hash: '#/calc', wait: '#view [data-card="calcInputs"]', fillCalc: true },
    { name: 'calc-result', hash: '#/calc', wait: '#view [data-card="calcInputs"]', fillCalc: true, scrollTo: '[data-card="calcResult"]' },
    { name: 'settings', hash: '#/settings', wait: '#view .chip-row' },
  ]
  : [
    { name: 'home', hash: '#/', wait: '#view .card' },
    { name: 'settings', hash: '#/settings', wait: '#view .chip-row' },
  ];

let srv = null;
let base;
if (live) {
  base = 'https://yolin0513.github.io/stockdiary/';
} else {
  const s = await listen(0);
  srv = s.srv;
  base = `http://localhost:${s.port}/`;
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  if (demo) {
    await page.evaluateOnNewDocument((csv, f48, f49, tradingDays) => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = String(input && input.url ? input.url : input);
        if (!url.includes('twse.com.tw')) return real(input, init);
        if (url.includes('STOCK_DAY_ALL')) return new Response(csv, { status: 200 });
        if (url.includes('TWT48U')) return new Response(JSON.stringify(f48), { status: 200 });
        if (url.includes('TWT49U')) return new Response(JSON.stringify(f49), { status: 200 });
        if (url.includes('STOCK_DAY?')) {
          // 個股當月逐日：定期定額要用扣款日的收盤價估股數，沒有這個就只能顯示「股數待填」
          const d = new URL(url).searchParams.get('date');
          const month = `${d.slice(0, 4)}-${d.slice(4, 6)}`;
          const rows = tradingDays.filter((x) => x.startsWith(month)).map((x) => {
            const [y, m, dd] = x.split('-');
            return [`${Number(y) - 1911}/${m}/${dd}`, '1,000', '100,000', '100.00', '100.00', '100.00', '100.00', '+0.00', '10', ''];
          });
          return new Response(JSON.stringify({
            stat: 'OK', title: '月報',
            fields: ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數', '註記'],
            data: rows,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }), { status: 200 });
      };
    }, CSV, TWT48U, TWT49U, ALL_TRADING_DAYS);
  }

  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view', { timeout: 60000 });

  if (demo) {
    await page.evaluate(async (list) => {
      const db = await import('./js/db.js');
      for (const s of db.STORE_NAMES) await db.clear(s);
      const hd = await import('./js/holdings.js');
      for (const x of list) await hd.addOpening(x);
      const plans = await import('./js/plans.js');
      await plans.save({
        code: '0050', amount: 3000, days: [16], feeRate: 0.001425,
        reinvestDividend: true, active: true,
        startDate: '2026-06-01', createdAt: '2026-06-01T00:00:00.000Z',
      });
      const store = await import('./js/store.js');
      await store.update({ force: true });
    }, DEMO_HOLDINGS);
  }

  for (const shot of SHOTS) {
    // 每一張都真的重新載入。注意：只差 hash 的 goto 是「同文件導覽」，Chrome 不會重載，
    // 畫面會停在上一次渲染的結果（剛塞進去的資料就看不到）。所以 goto 之後再 reload 一次。
    // IndexedDB 會跨重載留著。
    await page.goto(base + shot.hash, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector(shot.wait, { timeout: 60000 });
    if (shot.fillCalc) {
      // 試算器要先填假設才看得到結果。這些是**示範用的假設**，不是建議值 ——
      // App 本身的欄位永遠是空的（scripts/calcviewtest.mjs 盯著這件事）。
      await page.evaluate(() => {
        const set = (k, v) => {
          const el = document.querySelector(`#view [data-calc-field="${k}"]`);
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('amount', 5000); set('years', 20); set('growthRate', 6); set('yieldRate', 4);
        [...document.querySelectorAll('#view .chip')].find((b) => b.textContent === '每季')?.click();
      });
      await page.evaluate(() => {
        [...document.querySelectorAll('#view .btn-primary')].find((b) => b.textContent === '算一次').click();
      });
      await page.waitForSelector('#view [data-card="calcResult"]', { timeout: 60000 });
    }
    if (shot.scrollTo) {
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ block: 'start' });
      }, shot.scrollTo);
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 600));
    // 線上截圖用不同檔名，才不會蓋掉示範資料的那組
    const file = path.join(OUT, `${live ? 'live-' : ''}${shot.name}.png`);
    await page.screenshot({ path: file, captureBeyondViewport: false });
    console.log(`${shot.name} → ${path.relative(ROOT, file)}`);
  }

  if (errors.length) {
    console.log(`\n⚠ 頁面有 ${errors.length} 則錯誤：`);
    for (const e of errors.slice(0, 5)) console.log('   ' + e.slice(0, 200));
    process.exitCode = 1;
  } else {
    console.log(`\n沒有頁面錯誤（${live ? '線上' : demo ? '本機示範資料' : '本機'}：${base}）`);
  }
} finally {
  await browser.close();
  if (srv) srv.close();
}
