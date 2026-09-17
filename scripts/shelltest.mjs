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
import { selectAffected, moduleClosure, moduleRefsOf } from './affected.mjs';

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

section('沒有跳脫壞掉的 regex');
//
// **這一批假斷言的根因。** 用 shell heredoc 產生測試程式碼時，`\\s` 常常
// 原樣留在檔案裡 —— 而在 regex 裡那不是「空白」，是「一個反斜線接著字母 s」。
//
// 最惡劣的地方是**它不會報錯**：程式跑得過、測試是綠的，那條斷言只是
// 從此再也不會命中任何東西。實際發生過兩條，而且守的都是最重要的事：
//   · scenariotest 「畫面上的當日損益沒有生出一個數字」
//   · holdingtest  「畫面上沒有『報酬率』後面接著一個值」
//
// 所以改成靜態擋掉。判準：**regex 字面值裡出現兩個反斜線 ＋ 類別字元**。
// 字串與樣板字串裡的 `\\s` 是對的（那是給 new RegExp() 或給突變用的原始碼），
// 所以只掃 /…/ 這種字面值。
const scanDirs = ['js', 'js/views', 'scripts'];
const sourceFiles = scanDirs.flatMap((d) => fs.readdirSync(path.join(ROOT, d))
  .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  .map((f) => `${d}/${f}`));

// 要匹配的是「檔案裡有**兩個**反斜線」。regex 原始碼要寫四個反斜線才代表兩個，
// 所以用 fromCharCode 組 —— 直接寫在原始碼裡會再被跳脫一次，很容易寫成只匹配一個。
// （第一版就寫錯成只匹配一個，結果 83 個檔全部誤報 —— 是下面的對照組抓到的。）
/**
 * 這個位置是不是在字串字面值裡面。
 *
 * 只看同一行、只認 ' " ` 三種引號，遇到跳脫就跳過下一個字元。
 * 跨行的樣板字串認不出來 —— 那是已知的限制，不是 bug：
 * 真的有跨行樣板字串包著 regex 的話會誤報，到時候再處理。
 */
function insideString(line, idx) {
  let quote = null;
  for (let k = 0; k < idx; k += 1) {
    const c = line[k];
    if (c === String.fromCharCode(92)) { k += 1; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
  }
  return quote !== null;
}

const BS2 = String.fromCharCode(92, 92);
const BAD_ESCAPE = new RegExp(String.fromCharCode(92, 92, 92, 92) + '[sdwSDWbn.]');
const brokenEscapes = [];
for (const rel of sourceFiles) {
  // 去掉註解再掃 —— 註解裡常常「舉例」寫一個壞掉的 regex 當說明
  // （這一段自己的註解就有兩個），那不是真的程式碼。
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  src.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\/((?:[^/\n]|\\\/)+)\/[gimsuy]*\s*\.(?:test|exec)\(/g)) {
      if (!BAD_ESCAPE.test(m[1])) continue;
      // **字串裡的 \\d 是對的。** mutationtest 的 find／replace 帶的是要塞進
      // 別的檔案的原始碼片段，那裡就該有兩個反斜線。只有真的 regex 字面值才算壞。
      if (insideString(line, m.index)) continue;
      brokenEscapes.push(`${rel}:${i + 1}  /${m[1]}/`);
    }
  });
}
ok(sourceFiles.length >= 40, `（母體）掃了 ${sourceFiles.length} 個原始碼檔`);
eq(brokenEscapes, [], '沒有任何 regex 的反斜線被跳脫兩次（那種 regex 永遠不會命中，等於假斷言）');
// 對照組：判準本身要認得出壞的、也不能誤報好的。
// 少了這兩條，上面那條「沒有壞掉的 regex」可能只是因為判準自己寫壞了才全過。
const ONE_BS = String.fromCharCode(92);
ok(BAD_ESCAPE.test(BS2 + 's'), '（對照）判準認得出被跳脫兩次的類別字元');
ok(!BAD_ESCAPE.test(ONE_BS + 's'), '（對照）而且不會誤報正常的單反斜線');

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

section('版本號四個地方必須一致');
// 這是「按按鈕跳回首頁」那個 bug 的結構性防線：
// js/version.js（程式看得到的版本）、sw.js（快取名稱）、index.html（HTTP 快取鍵）
// 只要有一個沒跟上，瀏覽器就可能把新舊檔案湊在一起。
// 第四處 package.json 不影響執行期，但它停在 0.1.0 而 App 已經 0.7.x 的話，
// 看 repo 的人會以為這個專案沒在動 —— 所以也一起釘住。
const appVersion = /export const APP_VERSION = '([^']+)';/.exec(read('js/version.js'))?.[1];
const APP_VERSION_IN_SRC = appVersion;
const swVersion = /const VERSION = '([^']+)';/.exec(read('sw.js'))?.[1];
const htmlStamps = [...read('index.html').matchAll(/\?v=([^"'&]+)/g)].map((m) => m[1]);
// 底下每一條版本一致性都走這個比對器，下面的對照組驗的也是它 ——
// 分成兩份的話，對照組會變成「驗一個沒人在用的函式」。
const sameVersion = (v) => v === appVersion;
ok(/^stockdiary-v\d+\.\d+\.\d+$/.test(String(appVersion)), `js/version.js 的版本：${appVersion}`);
ok(sameVersion(swVersion), 'sw.js 的 VERSION 與 js/version.js 一致', `sw.js 是 ${swVersion}`);
ok(htmlStamps.length >= 2, `index.html 有 ${htmlStamps.length} 個帶版本的資源網址`);
everyOf(htmlStamps, sameVersion, 'index.html 每一個 ?v= 都是同一個版本');
// package.json 的 version 沒有 stockdiary-v 前綴（npm 的 semver 不吃）。
// 補回前綴之後走**同一個** sameVersion 比對器 —— 分成兩份比對法的話，
// 下面那條對照組就只驗到其中一份，另一份可以寬鬆到什麼都放行也沒人知道。
const pkgVersion = JSON.parse(read('package.json')).version;
ok(sameVersion(`stockdiary-v${pkgVersion}`),
  `package.json 的 version 與 js/version.js 一致（${pkgVersion}）`,
  `package.json 是 ${pkgVersion}，js/version.js 是 ${appVersion}`);
// 對照組：上面三條都建立在「字串相等」上，所以要證明那個相等是**嚴格**的。
// 反例以前只有一個（appVersion 自己），等於只驗了 `x !== x` 是 false ——
// 那條幾乎什麼都沒守到。真正會出事的是**寬鬆比對**：包含、忽略大小寫、
// 順手 trim、或拿 startsWith 當相等。下面每一個正例都是那種比對法會放過的形狀。
const [, major, minor, patch] = /^stockdiary-v(\d+)\.(\d+)\.(\d+)$/.exec(appVersion);
detects((v) => !sameVersion(v), {
  shouldHit: [
    'stockdiary-v0.0.1',                       // 完全不同的版本
    'stockdiary-v9.9.9',
    '',                                        // 抓不到（regex 沒中）時的空字串
    `${appVersion} `,                          // 尾巴多一個空白（沒 trim 的比對會過）
    ` ${appVersion}`,
    `${appVersion}.1`,                         // 前綴相同（startsWith 會過）
    appVersion.slice(0, -1),                   // 被截斷（includes 會過）
    appVersion.toUpperCase(),                  // 大小寫（不分大小寫的比對會過）
    `stockdiary-v${major}.${minor}.${Number(patch) + 1}`, // 只差一個 patch —— 最容易真的發生
    `stockdiary-v${major}.${Number(minor) + 1}.${patch}`,
    `v${major}.${minor}.${patch}`,             // 少了前綴
    `stockdiary-${major}.${minor}.${patch}`,   // 少了 v
  ],
  shouldMiss: [
    appVersion,
    String(appVersion),
    `${appVersion}`,
    appVersion.split('').join(''),             // 同字串不同物件
    `stockdiary-v${major}.${minor}.${patch}`,  // 由零件重組回來的同一個版本
  ],
}, '版本比對是嚴格字串相等：多一個空白、少一個字、只差一個 patch 都算不同');

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

section('受影響的突變挑選器（mutationtest --changed）');
//
// 全套突變 3.5 小時，所以日常只跑「這次改動影響到的」那幾條。
// 挑選器壞掉的樣子是**少挑了幾條** —— 跟全綠長得一模一樣，不會有人發現。
// 所以它自己要被驗證，而且要用假資料驗（真資料會隨程式碼一起漂移）。

const FAKE_MUTATIONS = [
  { name: 'm1', file: 'js/settle.js', test: 'settletest' },
  { name: 'm2', file: 'js/money.js', test: 'settletest' },
  { name: 'm3', file: 'js/twse.js', test: 'parsetest' },
  { name: 'm4', file: 'js/ui.js', test: 'uikittest' },
  { name: 'm5', file: 'sw.js', test: 'shelltest' },
];
// 假的「這支測試碰得到哪些模組」表
const FAKE_DEPS = {
  settletest: ['js/settle.js', 'js/money.js'],
  parsetest: ['js/twse.js'],
  uikittest: ['js/ui.js', 'js/shell.js'],
  shelltest: ['js/app.js', 'js/ui.js'],
};
const pick = (changed) =>
  selectAffected(FAKE_MUTATIONS, changed, (t) => FAKE_DEPS[t] || []).map((m) => m.name);

// 1. 突變要改的那個檔案被改了
eq(pick(['js/twse.js']), ['m3'], '改到 js/twse.js → 只挑 parsetest 那條');

// 2. 那支測試**間接**碰得到的模組被改了（m1 的檔案沒被改，但 settletest 用得到 money.js）
eq(pick(['js/money.js']), ['m1', 'm2'],
  '改到 js/money.js → settletest 的兩條都挑（m1 的 file 不是 money.js，靠相依挑到）');

// 3. 測試檔自己被改了（斷言可能被改弱）
eq(pick(['scripts/parsetest.mjs']), ['m3'], '改到 scripts/parsetest.mjs → 挑 parsetest 的突變');

// 4. 一個模組被多支測試碰到
eq(pick(['js/ui.js']), ['m4', 'm5'], '改到 js/ui.js → uikittest 與 shelltest 的都挑');

// 對照組：**不該挑的真的沒挑到**。少了這條，一個「永遠全挑」的挑選器也會通過上面每一條。
eq(pick(['docs/STATUS.md']), [], '只改文件 → 一條都不挑');
eq(pick([]), [], '什麼都沒改 → 一條都不挑');
ok(pick(['js/twse.js']).length < FAKE_MUTATIONS.length,
  `挑選是有篩掉東西的（5 條裡只挑了 ${pick(['js/twse.js']).length} 條）`);

// moduleRefsOf 要認得**兩種**根目錄不同的 import。
// 只認 Node 端那種的話，所有端對端測試都會算成「沒碰到任何模組」——
// 而那正是最需要跑的那幾支（pathtest、scenariotest 全靠瀏覽器端動態 import）。
const FAKE_TEST_SRC = [
  "import { makeCalendar } from '../js/market.js';",
  "import { ok } from './tap.mjs';",
  'const r = await page.evaluate(async () => {',
  "  const db = await import('./js/db.js');",
  "  const store = await import('./js/store.js');",
  '});',
  "// import('./js/註解裡的.js') 不算",
].join('\n');
const a17refs = moduleRefsOf(FAKE_TEST_SRC);
ok(a17refs.includes('js/market.js'), `認得 Node 端的 '../js/market.js'：${a17refs.join(' ')}`);
ok(a17refs.includes('js/db.js') && a17refs.includes('js/store.js'),
  '也認得瀏覽器端 page.evaluate 裡的 ./js/*.js');
noneOf(a17refs, (r) => r.includes('tap.mjs') || r.includes('註解'),
  'scripts/ 之間的相依與註解裡的路徑都不算');

// moduleClosure 要**遞移**展開。只展開一層的話，改 js/money.js 就挑不到任何東西——
// 沒有任何測試直接 import 它，全是經由 settle.js／dividend.js 間接用到。
const FAKE_FS = {
  'scripts/faketest.mjs': "import { settle } from '../js/settle.js';",
  'js/settle.js': "import { toMicro } from './money.js';\nimport { fmt } from './format.js';",
  'js/money.js': '// 沒有 import',
  'js/format.js': "import { x } from './money.js';",
};
const fakeRead = (rel) => {
  if (!(rel in FAKE_FS)) throw new Error('沒這個檔：' + rel);
  return FAKE_FS[rel];
};
const a17closure = moduleClosure('scripts/faketest.mjs', fakeRead).sort();
eq(a17closure, ['js/format.js', 'js/money.js', 'js/settle.js'],
  '遞移展開：直接 import settle.js，連帶把 money.js 與 format.js 都算進來');
ok(!a17closure.includes('scripts/faketest.mjs'), '測試檔自己不算在模組清單裡');

// 對照組：讀不到的檔案要跳過，不是整個爆掉
const a17closure2 = moduleClosure('scripts/不存在.mjs', fakeRead);
eq(a17closure2, [], '讀不到的測試檔回空陣列（不丟例外）');

// 真資料抽查：挑選器接到真的突變清單時，至少要挑得出東西來。
// 上面全是假資料 —— 少了這條，真實格式改了（例如 file 欄位改名）也不會有人發現。
const realMutSrc = read('scripts/mutationtest.mjs');
const realMuts = [...realMutSrc.matchAll(/name: '([^']+)',[\s\S]{0,400}?file: '([^']+)',[\s\S]{0,400}?test: '([^']+)',/g)]
  .map((m) => ({ name: m[1], file: m[2], test: m[3] }));
ok(realMuts.length > 100, `（前提）真的解析得出突變清單：${realMuts.length} 條`);
const realPick = selectAffected(realMuts, ['js/twse.js'],
  (t) => moduleClosure(`scripts/${t}.mjs`, (rel) => read(rel)));
ok(realPick.length > 0 && realPick.length < realMuts.length,
  `改 js/twse.js 從真清單挑出 ${realPick.length}/${realMuts.length} 條`);
everyOf(realPick, (m) => m.file === 'js/twse.js' || moduleClosure(`scripts/${m.test}.mjs`, (rel) => read(rel)).includes('js/twse.js'),
  '挑出來的每一條，不是檔案被改到就是測試碰得到那個檔');

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
    '/news': '新聞',
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
  // 等的是**總覽自己的卡片**，不是 .big-number —— 一筆資料都沒有的時候，
  // 總覽畫的是「開始使用」那張，上面根本沒有大數字。等一個只在有資料時才出現的
  // 東西，等於在沒有資料的情況下永遠等不到（就這樣逾時過一次）。
  await page.waitForFunction(
    () => document.getElementById('topTitle')?.textContent === 'StockDiary 股息日記'
      && document.querySelector('#view .card'),
    { timeout: 60000 },
  );
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

  section('認得的網址但 view 炸了：畫面要講出來，不能只印 console');
  // 使用者回報過的症狀（v0.7.17）：「底部的設定按了沒反應」。
  // 路由以前對 view 的例外只做 console.error —— hash 換了、分頁亮了、#view 還是上一頁，
  // 而 iPhone 沒有 console。這一節註冊一條**一定會炸**的路由，證明畫面會講出來。
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForFunction(
    () => document.getElementById('topTitle')?.textContent === 'StockDiary 股息日記'
      && document.querySelector('#view .card'),
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 300));

  await page.evaluate(async () => {
    const router = await import('./js/router.js');
    router.route('/__boom', async () => { throw new Error('測試用的例外：BOOM-4242'); });
    location.hash = '#/__boom';
  });
  await page.waitForSelector('#view [data-card="viewError"]', { timeout: 60000 });
  const boom = await page.evaluate(() => ({
    hash: location.hash,
    title: document.getElementById('topTitle').textContent,
    text: document.querySelector('#view').textContent.replace(/\s+/g, ' '),
    msg: document.querySelector('#view [data-field="viewErrorMessage"]')?.textContent ?? '',
    hasUpdateButton: [...document.querySelectorAll('#view button')].some((b) => b.textContent.includes('更新到最新版')),
    hasHomeLink: [...document.querySelectorAll('#view a')].some((a) => a.getAttribute('href') === '#/'),
    tabs: document.querySelectorAll('#tabbar .tab').length,
  }));
  eq(boom.title, '這一頁打不開', '頂列標題換成「這一頁打不開」（不是留著上一頁的標題）');
  ok(boom.text.includes('__boom'), '把打不開的那條路徑寫出來');
  ok(boom.msg.includes('BOOM-4242'), `**例外訊息原樣放在畫面上**：「${boom.msg}」—— 使用者截圖就能回報根因`);
  ok(boom.text.includes('資料沒有被動到'), '先安撫：資料沒事');
  ok(boom.text.includes(APP_VERSION_IN_SRC), `寫出目前執行的版本 ${APP_VERSION_IN_SRC}`);
  ok(boom.hasUpdateButton, '有「更新到最新版」的按鈕（view 炸掉最常見的原因仍是版本混搭）');
  ok(boom.hasHomeLink, '也留了一條回總覽的路');
  ok(boom.tabs >= 4, '底部分頁還在，沒有把使用者困住');
  ok(boom.hash === '#/__boom', `網址留在原地（${boom.hash}）`);

  // 對照：炸過一次之後，正常的路由要還走得動 —— 錯誤卡片不能把路由卡死
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForFunction(() => document.getElementById('topTitle')?.textContent === '設定', { timeout: 60000 });
  ok(await page.$('#view [data-card="dataSource"]') != null, '（對照）炸過之後再點設定，設定頁照樣畫得出來');

  section('畫面上看得到版本號');
  // 以前版本號**只有錯誤卡片會寫**，正常畫面任何地方都看不到。
  // 結果是換版之後沒有人（包括使用者自己）講得出手機上跑的是哪一版，出問題時沒辦法對。
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('#view [data-card="about"]', { timeout: 60000 });
  const shown = await page.$eval('#view [data-field="appVersion"]', (el) => el.textContent.trim());
  ok(shown.includes(APP_VERSION_IN_SRC),
    `關於卡片上寫著目前執行的版本：「${shown}」`);
  // 對照：不是寫死一個字串 —— 換個版本號它要跟著變
  ok(!shown.includes('stockdiary-v0.0.0'), '（對照）不是寫死的假版本號');

  section('有持股但還沒結算：顯示「—」，不顯示 0');
  // 要先**真的有一檔持股**。一筆資料都沒有的時候總覽畫的是「開始使用」那張，
  // 上面本來就沒有大數字 —— 拿那個畫面來驗「當日損益是不是 —」等於什麼都沒驗。
  const seeded = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const holdings = await import('./js/holdings.js');
    for (const st of db.STORE_NAMES) await db.clear(st);
    await holdings.addOpening({ code: '2330', shares: 1000, avgCost: null, date: '2026-01-05' });
    return (await holdings.list()).length;
  });
  eq(seeded, 1, '（前提）真的有一檔持股，而且沒有任何結算紀錄');

  await page.evaluate(() => { location.hash = '#/settings'; });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#view .big-number', { timeout: 60000 });
  const dayPL = await page.$eval('#view .big-number', (el) => el.textContent.trim());
  eq(dayPL, '—', '當日損益在還沒結算時是「—」');
  ok(dayPL !== '0' && dayPL !== '0.00', '而且絕對不是 0', `實際「${dayPL}」`);
  const nums = await page.$$eval('#view .num, #view .big-number, #view .mid-number',
    (els) => els.map((e) => e.textContent.trim()));
  noneOf(nums, (t) => /^[+-]?0(\.0+)?$/.test(t),
    '整頁沒有任何一個數字節點是 0（「不知道」不可以變成 0）');
} finally {
  await browser.close();
  srv.close();
}

done('shelltest');
