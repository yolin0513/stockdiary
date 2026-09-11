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
import { stripComments } from './srcscan.mjs';

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
export function importsOf(rawSource) {
  const source = stripComments(rawSource);
  const out = new Set();
  const patterns = [
    /\bimport\s+[^'"]*?from\s+'([^']+)'/g,   // import x from './y.js'
    /\bimport\s+'([^']+)'/g,                  // import './y.js'
    /\bimport\(\s*'([^']+)'\s*\)/g,           // await import('./y.js')
    // 動態 import 會帶版本參數：import(`./views/x.js${V}`)
    // 只取到 ${ 為止 —— 路徑本身仍是字面值，SHELL 稽核才走得下去。
    /\bimport\(\s*`([^`$]+)/g,
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

section('import 稽核器本身');
// 稽核器把註解裡的 import 也算進去的話，會逼著你把根本沒用到的檔案放進 SHELL
// 清單（實際發生過：shell.js 的註解裡寫了 `from '../app.js'`）。
detects((src) => importsOf(src).includes('./x.js'), {
  shouldHit: [
    "import { a } from './x.js';",
    "await import('./x.js');",
    "import './x.js';",
  ],
  shouldMiss: [
    "// import { a } from './x.js';",
    "/* import { a } from './x.js'; */",
    "import { a } from './y.js';",
  ],
}, 'import 稽核器認得真的 import，也不會把註解裡的當真');

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

section('版本號三個地方必須一致');
// 這是「按按鈕跳回首頁」那個 bug 的結構性防線：
// js/version.js（程式看得到的版本）、sw.js（快取名稱）、index.html（HTTP 快取鍵）
// 只要有一個沒跟上，瀏覽器就可能把新舊檔案湊在一起。
const appVersion = /export const APP_VERSION = '([^']+)';/.exec(read('js/version.js'))?.[1];
const APP_VERSION_IN_SRC = appVersion;
const swVersion = /const VERSION = '([^']+)';/.exec(read('sw.js'))?.[1];
const htmlStamps = [...read('index.html').matchAll(/\?v=([^"'&]+)/g)].map((m) => m[1]);
ok(/^stockdiary-v\d+\.\d+\.\d+$/.test(String(appVersion)), `js/version.js 的版本：${appVersion}`);
eq(swVersion, appVersion, 'sw.js 的 VERSION 與 js/version.js 一致');
ok(htmlStamps.length >= 2, `index.html 有 ${htmlStamps.length} 個帶版本的資源網址`);
everyOf(htmlStamps, (v) => v === appVersion, 'index.html 每一個 ?v= 都是同一個版本');
// 對照組：版本比對真的分得出不一樣的字串
detects((v) => v !== appVersion, {
  shouldHit: ['stockdiary-v0.0.1', 'stockdiary-v9.9.9', ''],
  shouldMiss: [appVersion],
}, '版本比對有對照組');

// 上面那條只檢查「有帶版本的那些都一致」—— 少帶的那個它看不到。
// 把 <script src="./js/app.js?v=..."> 的版本單獨拿掉，7 個 modulepreload 還帶著版本，
// 一致性檢查照樣全綠（實測過，這條突變曾經無聲無息地過關）。
// 而 app.js 正是最不能漏的那一個：它是進入點，舊的 app.js 配新的 view 就是那個 bug。
// 所以要反過來問：**每一個** .js 引用都帶版本了嗎。
//
// 規則不是「全部都要帶版本」，是**帶不帶要跟模組圖實際請求的網址一致**：
//   · js/app.js      index.html 自己載入，帶版本 → preload 也要帶
//   · js/views/*.js  動態 import 帶 ${V} → preload 也要帶
//   · 其他模組       被 app.js 用 './x.js' 靜態 import，沒帶版本 → preload 不能帶
// 不一致的後果是「preload 了一個根本不會被用到的網址」：每次開頁多抓一份，
// 而且真正要用的那一份完全沒被預熱（實測過 shell.js 被抓了兩次）。
const stamped = (u) => u.includes('?');
const shouldBeStamped = (u) => {
  const p0 = u.split('?')[0];
  return p0 === './js/app.js' || p0.startsWith('./js/views/');
};
const htmlJsRefs = [...read('index.html').matchAll(/(?:src|href)="(\.\/[^"]+\.js[^"]*)"/g)].map((m) => m[1]);
ok(htmlJsRefs.length >= 5, `index.html 引用了 ${htmlJsRefs.length} 個本地 .js`);
ok(htmlJsRefs.some((u) => u.split('?')[0] === './js/app.js'), 'index.html 確實有載入進入點 app.js');
everyOf(htmlJsRefs, (u) => (shouldBeStamped(u) ? u.endsWith(`?v=${appVersion}`) : !stamped(u)),
  `index.html 每個 .js 引用的網址都跟模組圖實際請求的一致（該帶版本的帶 ?v=${appVersion}，不該帶的不帶）`);
detects((u) => !(shouldBeStamped(u) ? u.endsWith(`?v=${appVersion}`) : !stamped(u)), {
  shouldHit: [
    './js/app.js',                                  // 進入點漏了版本 —— 就是那個 bug 的成因
    './js/app.js?v=stockdiary-v0.0.1',              // 版本對不上
    `./js/router.js?v=${appVersion}`,               // 不該帶卻帶了 —— preload 白抓一份
    `./js/views/home.js`,                           // view 漏了版本
  ],
  shouldMiss: [
    `./js/app.js?v=${appVersion}`,
    `./js/views/home.js?v=${appVersion}`,
    './js/router.js',
    './js/shell.js',
  ],
}, '「網址該不該帶版本」的檢查器有對照組');

section('app.js 的動態 import 都帶版本參數');
// 帶了版本，「新版 app.js 配上瀏覽器快取裡的舊 view」就不可能發生 ——
// 不同的版本參數就是不同的 HTTP 快取鍵。
const appSrc = read('js/app.js');
const dynamicImports = [...appSrc.matchAll(/await import\(([^)]+)\)/g)].map((m) => m[1].trim());
ok(dynamicImports.length >= 5, `找到 ${dynamicImports.length} 個動態 import`);
everyOf(dynamicImports, (s) => s.includes('${V}'), '每一個動態 import 都帶 ${V} 版本參數');
noneOf(dynamicImports, (s) => /^'\.\/views\/[a-z]+\.js'$/.test(s), '沒有任何一個是沒帶版本的字面字串');

section('路由表與 view 檔');
const routeDefs = [...appSrc.matchAll(/route\('([^']+)',[\s\S]{0,200}?import\(`([^`$]+)/g)]
  .map((m) => ({ pattern: m[1], view: path.posix.normalize(path.posix.join('js', m[2].replace(/^\.\//, ''))) }));
ok(routeDefs.length >= 2, `註冊了 ${routeDefs.length} 條路由：${routeDefs.map((r) => r.pattern).join('、')}`);
everyOf(routeDefs, (r) => fs.existsSync(path.join(ROOT, r.view)), '每條路由的 view 檔都存在');
const shellSet = new Set(shellAssets.map((a) => path.posix.normalize(a.replace(/^\.\//, ''))));
everyOf(routeDefs, (r) => shellSet.has(r.view), '每條路由的 view 檔都在 SHELL 清單裡');

section('index.html 引用的資源');
const html = read('index.html');
// 網址上的 ?v=<版本> 只是 HTTP 快取鍵，比對檔案存不存在時要去掉
const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1].split('?')[0]);
ok(refs.length >= 5, `index.html 引用了 ${refs.length} 個本地資源`);
everyOf(refs, (r) => fs.existsSync(path.join(ROOT, r)), 'index.html 引用的檔案都存在');
everyOf(refs, (r) => shellSet.has(path.posix.normalize(r.replace(/^\.\//, ''))),
  'index.html 引用的檔案都在 SHELL 清單裡');

/**
 * 稽核：有沒有哪一頁繞過 render() 自己去寫 #view。
 *
 * render()（js/app.js）裡面有一道守門：畫面是 async 的，畫到一半使用者換頁的話，
 * 這一份就不准畫上去。繞過它直接 mount #view 就沒有這道守門 ——
 * 網址是新的、畫面是舊的，看起來就是「按了按鈕跳到別頁」。使用者回報過這個症狀。
 *
 * 這裡用靜態稽核而不是一頁一頁跑，因為跑測試抓不到「以後才寫的那一頁」。
 */
export function viewsWritingViewDirectly(source) {
  return /getElementById\(\s*['"]view['"]\s*\)/.test(source) || /mount\(\s*view/.test(source);
}

section('沒有任何模組 import 進入點 app.js');
// index.html 載入的是 `./js/app.js?v=<版本>`。只要有人用 './app.js'（沒帶參數）
// import 它，瀏覽器就當成另一個網址再求值一次 —— boot() 跑兩次、路由註冊兩次、
// **TWSE 被打兩輪**。實測確認過真的會發生，所以用稽核擋死。
const nonEntryModules = ['sw.js', ...fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'js/views')).filter((f) => f.endsWith('.js')).map((f) => `js/views/${f}`)]
  .filter((f) => f !== 'js/app.js');
noneOf(nonEntryModules, (f) => importsOf(read(f)).some((spec) => spec.split('?')[0].endsWith('/app.js')),
  '沒有任何模組 import app.js（view 要的東西在 js/shell.js）');

section('沒有任何一頁繞過 render() 直接寫 #view');
const viewFiles = fs.readdirSync(path.join(ROOT, 'js/views')).filter((f) => f.endsWith('.js'));
noneOf(viewFiles, (f) => viewsWritingViewDirectly(read(`js/views/${f}`)),
  '每一頁都透過 app.js 的 render() 上畫面（那裡才有「畫面過期就不畫」的守門）');
detects(viewsWritingViewDirectly, {
  shouldHit: [
    "mount(document.getElementById('view'), x);",
    'mount(document.getElementById("view"), x);',
    'const el = document.getElementById( "view" );',
  ],
  shouldMiss: [
    'render([a, b]);',
    "document.getElementById('modalRoot')",
    'mount(bar, ...tabs);',
  ],
}, '這個稽核器抓得到繞過去的寫法，也不會亂抓');

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
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 390, height: 844 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .card', { timeout: 60000 });

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
  // 只等「#view 有東西」是不夠的：上一頁的內容本來就還在，那樣等於什麼都沒等到，
  // 量到的是上一頁。要等到頂列標題換成這一頁自己的，才算真的畫出來了。
  // （/holdings/:code 帶的是假代號，那一頁會自己退回 /holdings，所以標題是「持股」。）
  const EXPECT_TITLE = {
    '/': 'StockDiary 股息日記',
    '/holdings': '持股',
    '/holdings/:code': '持股',
    '/plans': '定期定額',
    '/dividends': '股利',
    '/calc': '定期定額試算',
    '/settings': '設定',
  };
  everyOf(routeDefs, (r) => EXPECT_TITLE[r.pattern] != null,
    '每條路由都列了它應該出現的標題（新增路由時不准漏掉）');
  const titleIs = (want) => page.waitForFunction(
    (t) => document.getElementById('topTitle').textContent === t, { timeout: 60000 }, want);
  const goto = async (hash) => { await page.evaluate((x) => { location.hash = x; }, hash); };

  for (const r of routeDefs) {
    const want = EXPECT_TITLE[r.pattern];
    // 每一條都先繞去一個標題**不一樣**的畫面再過去。不繞的話，上一頁剛好同標題時
    // （例如 /holdings 之後接 /holdings/:code）等待會立刻成立，等於什麼都沒等到。
    const via = want === EXPECT_TITLE['/settings'] ? '#/' : '#/settings';
    await goto(via);
    await titleIs(EXPECT_TITLE[via === '#/' ? '/' : '/settings']);

    await goto('#' + r.pattern);
    let landed = true;
    try { await titleIs(want); } catch { landed = false; }
    const got = await page.evaluate(() => ({
      title: document.getElementById('topTitle').textContent,
      text: document.querySelector('#view').textContent.trim(),
    }));
    ok(landed && got.text.length > 10,
      `${r.pattern} 真的畫出來了（標題「${want}」，${got.text.length} 字）`,
      landed ? '' : `標題停在「${got.title}」`);
    if (r.pattern === '/holdings/:code') {
      // 帶的是不存在的代號（字面的「:code」），它必須把使用者退回持股頁。
      // 有這一條，上面那個「標題是持股」才不會是「根本沒轉過去」也成立。
      eq(await page.evaluate(() => location.hash), '#/holdings',
        '查不到的代號會退回 #/holdings');
    }
  }
  eq(pageErrors, [], '走完所有路由之後仍然沒有例外');

  section('不認得的網址：講清楚原因，不靜默跳回首頁');
  // 使用者回報過的症狀：按「管理定期定額計畫」直接跳回主頁，什麼都沒說。
  // 根因是版本混搭（新版畫面配舊版路由表），但不管根因是什麼，
  // **fallback 都不該靜默** —— 使用者要看得到發生什麼事、可以做什麼。
  // 先回到一個穩定的畫面再測。上一段走過 /holdings/:code，那條路由自己會
  // location.replace 轉走，跟接下來設定的 hash 會互相追撞（實測三次有一次逾時）。
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#view .big-number', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 400));

  await page.evaluate(() => { location.hash = '#/沒有這一頁'; });
  await page.waitForSelector('#view [data-card="versionMismatch"]', { timeout: 60000 });
  const mismatch = await page.evaluate(() => ({
    hash: location.hash,
    text: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
    hasUpdateButton: [...document.querySelectorAll('#view button')].some((b) => b.textContent.includes('更新到最新版')),
    hasHomeLink: [...document.querySelectorAll('#view a')].some((a) => a.getAttribute('href') === '#/'),
  }));
  ok(mismatch.hasUpdateButton, '有「更新到最新版」的按鈕');
  ok(mismatch.hasHomeLink, '也留了一條回總覽的路');
  ok(mismatch.text.includes('沒有這一頁'), '把打不開的那條路徑寫出來');
  ok(mismatch.text.includes(APP_VERSION_IN_SRC), `寫出目前執行的版本 ${APP_VERSION_IN_SRC}`);
  ok(mismatch.hash !== '#/', `網址留在原地（${mismatch.hash}），更新之後才接得上`);
  ok(await page.$('#tabbar .tab') != null, '底部分頁還在，沒有把使用者困住');

  section('尚未結算時顯示「—」，不顯示 0');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#view .big-number', { timeout: 60000 });
  const dayPL = await page.$eval('#view .big-number', (el) => el.textContent.trim());
  eq(dayPL, '—', '當日損益在還沒結算時是「—」');
  ok(dayPL !== '0' && dayPL !== '0.00', '而且絕對不是 0', `實際「${dayPL}」`);
} finally {
  await browser.close();
  srv.close();
}

done('shelltest');
