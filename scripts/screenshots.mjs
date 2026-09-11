// 功能截圖（npm run screenshots）。預設打本機，--live 打線上。
// 截圖放 screenshots/features/，每版流程的最後一步。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { listen } from './serve.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'screenshots', 'features');
const live = process.argv.includes('--live');

const SHOTS = [
  { name: 'home', hash: '#/', wait: '#view .card' },
  { name: 'settings', hash: '#/settings', wait: '#view .chip-row' },
];

fs.mkdirSync(OUT, { recursive: true });

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
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(base, { waitUntil: 'networkidle0' });
  for (const shot of SHOTS) {
    await page.evaluate((hs) => { location.hash = hs; }, shot.hash);
    await page.waitForSelector(shot.wait, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 250));
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`${shot.name} → ${path.relative(ROOT, file)}`);
  }
  if (errors.length) {
    console.log(`\n⚠ 頁面有 ${errors.length} 則錯誤：`);
    for (const e of errors.slice(0, 5)) console.log('   ' + e.slice(0, 200));
    process.exitCode = 1;
  } else {
    console.log(`\n沒有頁面錯誤（${live ? '線上' : '本機'}：${base}）`);
  }
} finally {
  await browser.close();
  if (srv) srv.close();
}
