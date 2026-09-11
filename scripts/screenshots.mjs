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

const SHOTS = demo
  ? [
    { name: 'home', hash: '#/', wait: '#view .big-number' },
    { name: 'holdings', hash: '#/holdings', wait: '#view .rows' },
    { name: 'holding-detail', hash: '#/holdings/2330', wait: '#view .card' },
    { name: 'holding-unsupported', hash: '#/holdings/6488', wait: '#view .card' },
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
    await page.evaluateOnNewDocument((csv) => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = String(input && input.url ? input.url : input);
        if (!url.includes('twse.com.tw')) return real(input, init);
        if (url.includes('STOCK_DAY_ALL')) return new Response(csv, { status: 200 });
        return new Response(JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }), { status: 200 });
      };
    }, CSV);
  }

  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view', { timeout: 60000 });

  if (demo) {
    await page.evaluate(async (list) => {
      const db = await import('./js/db.js');
      for (const s of db.STORE_NAMES) await db.clear(s);
      const hd = await import('./js/holdings.js');
      for (const x of list) await hd.addOpening(x);
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
    await new Promise((r) => setTimeout(r, 600));
    const file = path.join(OUT, `${shot.name}.png`);
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
