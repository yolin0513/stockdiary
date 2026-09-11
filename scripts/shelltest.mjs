// PWA 殼的稽核（npm run shelltest）。
//
// 兩個部分：
//   A. 靜態稽核 —— 從 js/app.js 走完整個 import 圖，每一個模組都必須在 sw.js 的
//      SHELL_ASSETS 裡。漏一個的後果不是「載不到」，而是「線上載得到、離線就白畫面」，
//      而且只有換版當下才會炸（舊 app.js 動態 import 到不在快取裡的新 view）。
//      這一段有對照組：拿一份故意少一項的清單餵進同一個稽核器，它必須報錯。
//   B. 真的用瀏覽器開起來 —— h() 不接受 html: prop、網址屬性白名單、每條路由都畫得出東西。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { listen } from './serve.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------- A. 靜態稽核 ----------

/** 從 sw.js 取出 SHELL_ASSETS 清單。 */
export function shellAssetsOf(swSource) {
  const m = /const SHELL_ASSETS = \[([\s\S]*?)\];/.exec(swSource);
  if (!m) throw new Error('sw.js 裡找不到 SHELL_ASSETS');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 從一個 JS 檔取出它 import 的同專案模組（靜態與動態都算）。 */
export function importsOf(source) {
  const out = new Set();
  const patterns = [
    /\bimport\s+[^'"]*?from\s+'([^']+)'/g,   // import x from './y.js'
    /\bimport\s+'([^']+)'/g,                  // import './y.js'
    /\bimport\(\s*'([^']+)'\s*\)/g,           // await import('./y.js')
  ];
  for (const rx of patterns) {
    for (const m of source.matchAll(rx)) {
      if (m[1].startsWith('.')) out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * 從 entry 開始走完 import 圖，回傳所有會被載到的模組（相對於專案根目錄的路徑）。
 * readFile 是參數，測試才能用假的檔案系統驗證稽核器本身。
 */
export function reachableModules(entry, readFile) {
  const seen = new Set();
  const missing = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let src;
    try { src = readFile(rel); } catch { missing.push(rel); return; }
    for (const spec of importsOf(src)) {
      walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  };
  walk(entry);
  return { modules: [...seen], missing };
}

/** 稽核：每一個會被載到的模組都要在 SHELL 清單裡。回傳缺少的項目。 */
export function auditShell(modules, shellAssets) {
  const inShell = new Set(shellAssets.map((a) => path.posix.normalize(a.replace(/^\.\//, ''))));
  return modules.filter((m) => !inShell.has(m));
}

const swSource = read('sw.js');
const shellAssets = shellAssetsOf(swSource);
const readModule = (rel) => read(rel);

section('SHELL 清單本身');
ok(shellAssets.length > 5, `sw.js 列了 ${shellAssets.length} 個檔案`);
everyOf(shellAssets.filter((a) => a !== './'), (a) => fs.existsSync(path.join(ROOT, a)),
  'SHELL 清單裡的檔案都真的存在');
eq([...new Set(shellAssets)].length, shellAssets.length, 'SHELL 清單沒有重複項目');
const version = /const VERSION = '([^']+)'/.exec(swSource)?.[1];
ok(/^stockdiary-v\d+\.\d+\.\d+$/.test(String(version)), `VERSION 格式正常：${version}`);

section('import 圖 ⊆ SHELL 清單');
const { modules, missing } = reachableModules('js/app.js', readModule);
eq(missing, [], 'import 到的檔案都存在');
ok(modules.length >= 8, `從 app.js 走得到 ${modules.length} 個模組：${modules.join('、')}`);
const notInShell = auditShell(modules, shellAssets);
eq(notInShell, [], '每一個會被載到的模組都在 SHELL 清單裡');

// 對照組：稽核器若壞成「永遠回空陣列」，上面那條就永遠會過。
// 拿一份故意少掉 views/home.js 的清單餵進去，它必須報出來。
section('稽核器對照組');
const crippled = shellAssets.filter((a) => a !== './js/views/home.js');
eq(auditShell(modules, crippled), ['js/views/home.js'],
  '（對照）清單少了 views/home.js 時，稽核器確實會報出來');
detects(
  (asset) => auditShell(modules, shellAssets.filter((a) => a !== asset)).length > 0,
  {
    shouldHit: ['./js/ui.js', './js/router.js', './js/views/settings.js', './js/catalog.js'],
    shouldMiss: ['./index.html', './css/style.css', './icons/icon-192.png', './data/stocks.json'],
  },
  '稽核器只管 JS 模組，抽掉非模組資產不會誤報'
);

section('路由表與 view 檔');
const appSrc = read('js/app.js');
const routeDefs = [...appSrc.matchAll(/route\('([^']+)',[\s\S]{0,160}?import\('([^']+)'\)/g)]
  .map((m) => ({ pattern: m[1], view: path.posix.normalize(path.posix.join('js', m[2].replace(/^\.\//, ''))) }));
ok(routeDefs.length >= 2, `註冊了 ${routeDefs.length} 條路由：${routeDefs.map((r) => r.pattern).join('、')}`);
everyOf(routeDefs, (r) => fs.existsSync(path.join(ROOT, r.view)), '每條路由的 view 檔都存在');
const shellSet = new Set(shellAssets.map((a) => path.posix.normalize(a.replace(/^\.\//, ''))));
everyOf(routeDefs, (r) => shellSet.has(r.view), '每條路由的 view 檔都在 SHELL 清單裡');

section('index.html 引用的資源');
const html = read('index.html');
const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
ok(refs.length >= 5, `index.html 引用了 ${refs.length} 個本地資源`);
everyOf(refs, (r) => fs.existsSync(path.join(ROOT, r)), 'index.html 引用的檔案都存在');
everyOf(refs, (r) => shellSet.has(path.posix.normalize(r.replace(/^\.\//, ''))),
  'index.html 引用的檔案都在 SHELL 清單裡');

section('sw.js 不會快取外部請求');
ok(/url\.origin !== self\.location\.origin/.test(swSource) &&
  /if \(url\.origin !== self\.location\.origin\) return;/.test(swSource),
  '跨網域請求直接走網路，不進快取（拿舊收盤價冒充今天比拿不到更糟）');
ok(/cache: 'reload'/.test(swSource), 'install 時用 cache:reload 預快取，避免存進舊版 JS');

// ---------- B. 瀏覽器 ----------
const { srv, port } = await listen(0);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card', { timeout: 10000 });

  section('開得起來');
  eq(pageErrors, [], '沒有未攔截的例外');
  eq(consoleErrors.filter((t) => !/favicon|sw\.js/i.test(t)), [], '主控台沒有錯誤');
  ok((await page.$$('#tabbar .tab')).length >= 2, '底部分頁畫出來了');
  const title = await page.$eval('#topTitle', (el) => el.textContent);
  ok(title.includes('StockDiary'), `頂列標題：「${title}」`);

  section('h() 不接受 html: prop');
  const hRes = await page.evaluate(async () => {
    const { h } = await import('./js/ui.js');
    const payload = '<img src=x onerror="window.__pwned=1"><b>粗體</b>';

    const viaProp = h('div', { html: payload });
    const viaChild = h('div', {}, payload);
    const nested = h('div', {}, h('span', {}, payload));

    document.body.append(viaProp, viaChild, nested);
    await new Promise((r) => setTimeout(r, 50));

    return {
      pwned: !!window.__pwned,
      propChildElements: viaProp.querySelectorAll('*').length,
      propText: viaProp.textContent,
      propHasImg: !!viaProp.querySelector('img'),
      childChildElements: viaChild.querySelectorAll('*').length,
      childText: viaChild.textContent,
      nestedText: nested.textContent,
      imgsInBody: document.querySelectorAll('img').length,
    };
  });
  eq(hRes.pwned, false, 'onerror 沒有被執行');
  eq(hRes.propHasImg, false, 'html: prop 沒有生出 <img> 節點');
  eq(hRes.propChildElements, 0, 'html: prop 沒有生出任何子元素');
  eq(hRes.propText, '', 'html: prop 連文字都沒有進來（它只會變成一個屬性）');
  // 對照組：同一串字當成 child 傳，必須原封不動變成文字。
  // 少了這一條，上面那些「等於 0」的斷言在 h() 整個壞掉時也會過。
  eq(hRes.childChildElements, 0, '（對照）同一串字當 child 傳，也不會變成元素');
  eq(hRes.childText, '<img src=x onerror="window.__pwned=1"><b>粗體</b>',
    '（對照）當 child 傳的時候，這串字原封不動顯示出來 —— 證明測試看得到差別');
  eq(hRes.nestedText, '<img src=x onerror="window.__pwned=1"><b>粗體</b>', '巢狀節點也是文字');
  eq(hRes.imgsInBody, 0, '整個頁面沒有多出 <img>');
  ok(!/\bhtml\b\s*:/.test(read('js/ui.js').replace(/\/\/.*$/gm, '')) || !/innerHTML/.test(read('js/ui.js')),
    'ui.js 裡沒有把 html prop 寫進 innerHTML 的程式碼');

  section('網址屬性白名單');
  const urlRes = await page.evaluate(async () => {
    const { h } = await import('./js/ui.js');
    const mk = (href) => h('a', { href }).getAttribute('href');
    return {
      js: mk('javascript:alert(1)'),
      dataHtml: mk('data:text/html,<script>alert(1)</script>'),
      vb: mk('vbscript:msgbox(1)'),
      https: mk('https://www.twse.com.tw/'),
      hash: mk('#/settings'),
      rel: mk('./data/stocks.json'),
      dataImg: mk('data:image/png;base64,iVBORw0KGgo='),
    };
  });
  noneOf([urlRes.js, urlRes.dataHtml, urlRes.vb], (v) => v != null,
    '危險的協定全部被丟掉（href 屬性根本不存在）');
  everyOf([urlRes.https, urlRes.hash, urlRes.rel, urlRes.dataImg], (v) => typeof v === 'string' && v.length > 0,
    '（對照）正常的網址留得下來 —— 證明白名單不是「全部都丟」');

  section('每條路由都畫得出東西');
  for (const r of routeDefs) {
    await page.evaluate((p) => { location.hash = '#' + p; }, r.pattern);
    await page.waitForFunction(() => document.querySelector('#view')?.textContent?.trim().length > 0,
      { timeout: 8000 });
    const text = await page.$eval('#view', (el) => el.textContent.trim());
    ok(text.length > 10, `${r.pattern} 有內容（${text.length} 字）`);
  }
  eq(pageErrors, [], '走完所有路由之後仍然沒有例外');

  section('不認得的網址退回首頁，不是白畫面');
  await page.evaluate(() => { location.hash = '#/沒有這一頁'; });
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '', { timeout: 5000 });
  ok(await page.$('#view .card') != null, '退回首頁而且畫得出來');

  section('尚未結算時顯示「—」，不顯示 0');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#view .big-number', { timeout: 5000 });
  const dayPL = await page.$eval('#view .big-number', (el) => el.textContent.trim());
  eq(dayPL, '—', '當日損益在還沒結算時是「—」');
  ok(dayPL !== '0' && dayPL !== '0.00', '而且絕對不是 0', `實際「${dayPL}」`);
} finally {
  await browser.close();
  srv.close();
}

done('shelltest');
