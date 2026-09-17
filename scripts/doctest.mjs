// 文件與程式對齊（npm run doctest）。
//
// 為什麼需要這個：**文件會漂移，而且漂移不會讓任何測試變紅。**
// 稽核時實際抓到的：STATUS 與 README 都寫「138 條突變」，實際 182；
// 上線檢查清單寫「25 支＋110 條」；README 的測試表格漏了 scenariotest 與 pathtest
// （那兩支加起來 140+ 條斷言，看 README 的人根本不知道它們存在）。
// 三處數字三個版本，而且全部綠燈。
//
// 所以這一支把文件**釘在程式上**：數字一律從程式數出來比，不寫死。
// 文件改錯會紅，程式改了忘記同步文件也會紅。
//
// 不碰網路、不開瀏覽器 —— 純靜態，很快。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, noneOf, everyOf } from './tap.mjs';
import { stripComments } from './srcscan.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BT = String.fromCharCode(96);

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const status = read('docs/STATUS.md');
const mutSrc = read('scripts/mutationtest.mjs');

// ---------------------------------------------------------------------------
section('測試清單：npm test 與 README 表格要對得起來');

const chain = [...new Set([...pkg.scripts.test.matchAll(/scripts\/([a-z-]+)\.mjs/g)].map((m) => m[1]))];
ok(chain.length > 20, `（前提）npm test 鏈裡解析得出 ${chain.length} 支`);

// README 測試表格的第一欄
const tableRx = new RegExp('^\\| ' + BT + 'npm run ([a-z-]+)' + BT + ' \\|', 'gm');
const inTable = [...new Set([...readme.matchAll(tableRx)].map((m) => m[1]))];
ok(inTable.length > 20, `（前提）README 測試表格解析得出 ${inTable.length} 列`);

const missingFromReadme = chain.filter((t) => !inTable.includes(t));
eq(missingFromReadme, [],
  'npm test 跑的每一支都列在 README 表格裡（漏了的話，沒人知道它存在）');

// 反過來：README 有、npm test 沒有的，必須是**刻意**不進 npm test 的那幾支。
// 沒有這份白名單的話，「反之亦然」只能放寬成單向，README 就可以列一堆不存在的測試。
// 理由見 STATUS 工作慣例 10：打真網路的測試不進 npm test。
const DELIBERATELY_OUT = {
  workertest: '要 wrangler、會碰一次上游',
  upgradecheck: '要起兩次伺服器模擬換版，慢',
};
const extraInReadme = inTable.filter((t) => !chain.includes(t));
eq(extraInReadme.sort(), Object.keys(DELIBERATELY_OUT).sort(),
  `README 有但 npm test 沒有的，就是刻意排除的那幾支（${Object.entries(DELIBERATELY_OUT).map(([k, v]) => `${k}：${v}`).join('；')}）`);

// 每一支都要真的存在，而且 package.json 裡有對應的 script
everyOf([...chain, ...inTable], (t) => fs.existsSync(path.join(ROOT, 'scripts', `${t}.mjs`)),
  '提到的每一支測試，scripts/ 底下都真的有那個檔');
everyOf([...chain, ...inTable], (t) => typeof pkg.scripts[t] === 'string',
  'package.json 裡都有對應的 npm script');

// ---------------------------------------------------------------------------
section('數字：文件寫的要等於程式數出來的');

// 口徑：N 支 ＝ npm test 鏈裡除了 mutationtest 以外的支數
const SUITES = chain.filter((t) => t !== 'mutationtest').length;
const MUTS = (mutSrc.match(/^\s+find:/gm) || []).length;
ok(MUTS > 100, `（前提）mutationtest.mjs 裡數得出 ${MUTS} 條突變`);
ok(SUITES > 20, `（前提）npm test 鏈裡有 ${SUITES} 支測試（不含 mutationtest）`);

// 文件裡每一個「N 條突變」都要等於實際條數。
// 母體是**全部**出現過的地方 —— 只挑一處比對的話，另外兩處可以繼續錯下去
// （實際發生過：STATUS 與 README 一起停在 138，上線清單停在 110）。
const mutCountRx = /(\d+)\s*條突變/g;
const declaredMutCounts = [
  ...[...status.matchAll(mutCountRx)].map((m) => ({ where: 'STATUS', n: Number(m[1]) })),
  ...[...readme.matchAll(mutCountRx)].map((m) => ({ where: 'README', n: Number(m[1]) })),
];
ok(declaredMutCounts.length > 0,
  `（前提）文件裡找得到 ${declaredMutCounts.length} 處「N 條突變」的寫法`);
noneOf(declaredMutCounts, (d) => d.n !== MUTS,
  `文件裡每一處寫的突變條數都等於實際的 ${MUTS} 條`);

// 「N 支」也一樣
const suiteCountRx = /(\d+)\s*支測試|完整\s*(\d+)\s*支|`npm test`（(\d+)\s*支/g;
const declaredSuites = [
  ...[...status.matchAll(suiteCountRx)],
  ...[...readme.matchAll(suiteCountRx)],
].map((m) => Number(m[1] || m[2] || m[3]));
ok(declaredSuites.length > 0, `（前提）文件裡找得到 ${declaredSuites.length} 處「N 支」的寫法`);
noneOf(declaredSuites, (n) => n !== SUITES,
  `文件裡每一處寫的測試支數都等於實際的 ${SUITES} 支`);

// ---------------------------------------------------------------------------
section('版本：四處一致（比對本身由 shelltest 守，這裡確認那條檢查還在）');

const appVersion = /export const APP_VERSION = '([^']+)';/.exec(read('js/version.js'))?.[1];
ok(/^stockdiary-v\d+\.\d+\.\d+$/.test(String(appVersion)), `js/version.js：${appVersion}`);

// 文件說「shelltest 會驗」，所以要確認 shelltest 裡真的有那段 ——
// 不然文件承諾了一個已經被刪掉的防線，而且沒有任何測試會發現。
const shellSrc = read('scripts/shelltest.mjs');
ok(shellSrc.includes("section('版本號四個地方必須一致')"),
  'shelltest 裡真的有「版本號四個地方必須一致」那一段');
ok(status.includes('`shelltest` 會驗') || status.includes('shelltest` 會驗'),
  'STATUS 的上線檢查清單有說這件事由 shelltest 守');

// ---------------------------------------------------------------------------
section('STATUS 提到的檔案與指令都真的存在');

const runRx = new RegExp(BT + 'npm run ([a-z-]+)' + BT, 'g');
const statusRuns = [...new Set([...status.matchAll(runRx)].map((m) => m[1]))];
ok(statusRuns.length > 10, `（前提）STATUS 提到 ${statusRuns.length} 個 npm run 指令`);
const badRuns = statusRuns.filter((t) => !pkg.scripts[t]);
eq(badRuns, [], 'STATUS 提到的每一個 npm run 指令，package.json 裡都有');

const scriptRx = new RegExp(BT + 'scripts/([a-z-]+)\\.mjs' + BT, 'g');
const statusScripts = [...new Set([...status.matchAll(scriptRx)].map((m) => m[1]))];
ok(statusScripts.length > 3, `（前提）STATUS 直接點名 ${statusScripts.length} 支 scripts/*.mjs`);
const badScripts = statusScripts.filter((t) => !fs.existsSync(path.join(ROOT, 'scripts', `${t}.mjs`)));
eq(badScripts, [], 'STATUS 點名的每一支 scripts/*.mjs 都存在');

// ---------------------------------------------------------------------------
section('元件慣例：STATUS 說「不要用」的，程式裡真的沒有');

// STATUS「元件慣例」表宣告了哪些東西不准再用。這裡**雙向釘住**：
//   1. 這幾條規則還寫在 STATUS 裡（有人刪掉規則的話要知道）
//   2. 程式裡真的沒有違規（uikittest 也掃，但那支要開瀏覽器；這裡是純靜態的第二道）
const BANNED = [
  { what: 'type="time"', inDoc: '`<input type="time">`', rx: /type\s*:\s*'time'|type="time"/ },
  { what: 'link-btn', inDoc: '`link-btn`', rx: /link-btn/ },
];
everyOf(BANNED, (b) => status.includes(b.inDoc),
  'STATUS 的元件慣例表裡，每一條禁用規則都還在');

const srcFiles = [
  ...fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'js/views')).filter((f) => f.endsWith('.js')).map((f) => `js/views/${f}`),
];
ok(srcFiles.length > 30, `（前提）掃 ${srcFiles.length} 支程式`);
const violations = [];
for (const rel of srcFiles) {
  const src = stripComments(read(rel));   // 註解裡寫「不要用 type="time"」不算違規
  for (const b of BANNED) if (b.rx.test(src)) violations.push(`${rel} 用了 ${b.what}`);
}
eq(violations, [], '程式裡沒有任何一處用到被禁用的元件');

// 對照組：判準真的抓得到。少了這條，regex 寫錯（例如多跳脫一層）也會全綠。
everyOf(BANNED, (b) => b.rx.test(`x ${b.what} y`),
  '（對照）每一條判準都認得出自己要抓的東西');

done('doctest');
