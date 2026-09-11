// 重現使用者回報的 bug：點「管理定期定額計畫」直接跳回主頁。
// 打**線上版**，不是本機 —— 使用者是在線上遇到的。

import puppeteer from 'puppeteer';

const BASE = process.argv.includes('--local')
  ? process.argv[process.argv.indexOf('--local') + 1]
  : 'https://yolin0513.github.io/stockdiary/';

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(60000);
page.setDefaultNavigationTimeout(60000);
await page.setViewport({ width: 390, height: 844 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });

console.log(`開 ${BASE}`);
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('#view .card');

// 線上版的版本號
const swText = await (await fetch(`${BASE}sw.js`)).text();
console.log('線上 sw.js VERSION =', /const VERSION = '([^']+)'/.exec(swText)?.[1]);

// 註冊起來的路由
const routes = await page.evaluate(async () => {
  const r = await import('./js/router.js');
  return r.routePatterns ? r.routePatterns() : '(這一版沒有 routePatterns)';
});
console.log('註冊的路由 =', JSON.stringify(routes));

// 到持股頁，找那顆按鈕
await page.goto(`${BASE}#/holdings`, { waitUntil: 'networkidle0' });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('#view .card');

const link = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#view a, #view button')]
    .find((x) => x.textContent.includes('管理定期定額計畫'));
  return el ? { tag: el.tagName, href: el.getAttribute('href'), text: el.textContent.trim() } : null;
});
console.log('按鈕 =', JSON.stringify(link));

if (!link) {
  console.log('✗ 線上版根本沒有這顆按鈕 —— 使用者可能在舊版或別的畫面');
} else {
  console.log(`點下去（href=${link.href}）…`);
  await page.evaluate(() => {
    [...document.querySelectorAll('#view a, #view button')]
      .find((x) => x.textContent.includes('管理定期定額計畫')).click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.evaluate(() => ({
    hash: location.hash,
    title: document.getElementById('topTitle')?.textContent,
    firstCard: document.querySelector('#view .card-title')?.textContent,
    viewLen: document.querySelector('#view')?.textContent.trim().length,
  }));
  console.log('點完之後 =', JSON.stringify(after));
  console.log(after.hash === '#/plans' ? '✓ 有進到定期定額頁' : `✗ **重現了**：跑到 ${after.hash}`);
}

// 直接用網址進去也試一次
await page.goto(`${BASE}#/plans`, { waitUntil: 'networkidle0' });
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2500));
const direct = await page.evaluate(() => ({
  hash: location.hash,
  title: document.getElementById('topTitle')?.textContent,
  firstCard: document.querySelector('#view .card-title')?.textContent,
}));
console.log('直接開 #/plans =', JSON.stringify(direct));

console.log('\n--- 主控台與網路 ---');
for (const l of logs) console.log(l.slice(0, 500));

await browser.close();
