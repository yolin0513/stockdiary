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
import { parseFrozenList, frozenSection, extractFunction, hashOf, currentHashes } from './frozen.mjs';

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
  gateselftest: '推送閘門驗法的自我測試，要跑六次驗法、約 7 分鐘；改過閘門或驗法時跑',
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

// 文件裡每一處寫「現在的總數」的地方都要等於實際數字。
// 母體是**全部**出現過的地方 —— 只挑一處比對的話，另外兩處可以繼續錯下去
// （實際發生過：STATUS 與 README 一起停在 138，上線清單停在 110）。
//
// **寫法的約定（2026-09-23，SPEC_測試可信度 D1）**：
//   · 現在的總數寫成「N 支＋M 條突變」「N 支測試」「M 條突變」—— 這裡認得的就是這幾種。
//   · 「突變 M 條」也認得：以前只認前一種，上線清單那一行就是寫成這樣、漂到 185 沒人發現。
//   · **歷史紀錄前面加「當時」**（「當時 28 支」「當時 234 條」），這裡會跳過它 —— 不加的話，
//     它要嘛被當成現在的總數而紅，要嘛就得寫成認不得的樣子，下一個人不知道哪個才是現在的。
//   · 不是總數的數字不要寫成上面那幾種形狀（「14 個測試檔」「突變達 25 條」這種都不會被認成總數）。
function declaredCounts(text) {
  const notHistory = (m) => !/當時\s*\**\s*$/.test(text.slice(Math.max(0, m.index - 6), m.index));
  const pick = (rx) => [...text.matchAll(rx)].filter(notHistory).map((m) => Number(m.slice(1).find((x) => x != null)));
  return {
    muts: pick(/(\d+)\s*條突變|突變\s*(\d+)\s*條/g),
    suites: pick(/(\d+)\s*支測試|完整\s*(\d+)\s*支|`npm test`（(\d+)\s*支|(\d+)\s*支\s*[＋+]|全套\s*(\d+)\s*支/g),
  };
}
const inStatus = declaredCounts(status);
const inReadme = declaredCounts(readme);

// 對照組：認得兩種寫法、跳過「當時」、不把別的數字當成總數
eq(declaredCounts('共 12 條突變；另一處寫突變 12 條。').muts, [12, 12], '（對照）「N 條突變」與「突變 N 條」兩種寫法都認得');
eq(declaredCounts('當時 234 條突變、當時 **28 支＋**。').muts.length + declaredCounts('當時 **28 支＋**').suites.length, 0,
  '（對照）前面有「當時」的是歷史紀錄，跳過');
eq(declaredCounts('其餘 14 個測試檔；改過的突變達 **25 條**；新增 5 條').muts.length
  + declaredCounts('其餘 14 個測試檔').suites.length, 0,
  '（對照）「14 個測試檔」「突變達 25 條」這種不是總數，不會被認成總數');
eq(declaredCounts('測試：29 支＋247 條突變；全套 29 支；完整 29 支；29 支測試').suites, [29, 29, 29, 29],
  '（對照）「N 支＋」「全套 N 支」「完整 N 支」「N 支測試」都認得');

const declaredMutCounts = [
  ...inStatus.muts.map((n) => ({ where: 'STATUS', n })),
  ...inReadme.muts.map((n) => ({ where: 'README', n })),
];
ok(declaredMutCounts.length > 0,
  `（前提）文件裡找得到 ${declaredMutCounts.length} 處寫突變總數的地方`);
noneOf(declaredMutCounts, (d) => d.n !== MUTS,
  `文件裡每一處寫的突變條數都等於實際的 ${MUTS} 條`);

// 「N 支」也一樣。口徑：package.json 的 test 鏈扣掉 mutationtest（以前一處寫 27、一處寫 28，就是沒有口徑）
const declaredSuites = [...inStatus.suites, ...inReadme.suites];
ok(declaredSuites.length > 0, `（前提）文件裡找得到 ${declaredSuites.length} 處寫測試支數的地方`);
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

// ---------------------------------------------------------------------------
section('禁用詞清單只有一份（scripts/banned.mjs）');
// 以前 calctest、calcviewtest、uikittest 各抄一份；只改其中一份的話，另外兩處就悄悄少擋一個詞。
{
  // 「另抄一份」的樣子：一個陣列字面裡同時有這幾個詞
  const looksLikeCopy = (line) => /\[[^\]]*'應該買'[^\]]*\]/.test(line) && line.includes("'歷史平均'");
  // mutationtest.mjs 不算：它的 replace 字串是「把清單抄回去」那條突變要寫進去的程式碼，不是一份清單
  const scriptFiles = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs') && f !== 'banned.mjs' && f !== 'mutationtest.mjs');
  ok(scriptFiles.length > 20, `（前提）掃 scripts/ 底下 ${scriptFiles.length} 支`);
  const copies = scriptFiles.flatMap((f) => read(`scripts/${f}`).split('\n')
    .filter(looksLikeCopy).map((line) => ({ f, line: line.trim().slice(0, 60) })));
  eq(copies, [], '禁用詞清單只有一份：沒有任何測試另外抄一份');
  ok(looksLikeCopy(read('scripts/banned.mjs').split('\n').find((l) => l.includes('export const BANNED')) ?? ''),
    '（對照）拿 banned.mjs 那一行去餵，判準認得出它是一份清單');
  ok(!looksLikeCopy("everyOf(['不是投資建議', '目標價', '評等'], (w) => sys.includes(w))"),
    '（對照）只提到其中幾個詞的別種清單（insighttest 那種）不算另抄一份');
}

// ---------------------------------------------------------------------------
section('凍結區：清單從 SPEC_全面優化 §0 讀，每個單位都跟快照一樣（常設靜態稽核）');
// 以前每一版靠人工 git diff 代驗（v0.7.23 是這樣做的）；凍結還要維持一段時間，所以做成每次都跑的。
// 規則的出處：CLAUDE.md 常設規則 5。重產快照見 scripts/frozen.mjs 開頭。
{
  const SNAP_REL = 'scripts/frozen-snapshot.json';
  const sec0 = frozenSection(read('docs/SPEC_全面優化.md'));
  ok(sec0 != null, '（前提）SPEC_全面優化.md 裡找得到 §0 的凍結條文');
  const units = parseFrozenList(sec0 ?? '');
  const files = [...new Set(units.map((u) => u.file))];
  ok(files.length >= 8 && units.some((u) => u.fn === null) && units.some((u) => u.fn),
    `（前提）從 §0 讀出 ${files.length} 個檔、${units.length} 個凍結單位（整檔 ${units.filter((u) => !u.fn).length}、函式 ${units.filter((u) => u.fn).length}）`);
  const now = currentHashes(units, (rel) => (fs.existsSync(path.join(ROOT, rel)) ? read(rel) : null));

  if (process.argv.includes('--write-frozen-snapshot')) {
    fs.writeFileSync(path.join(ROOT, SNAP_REL),
      `${JSON.stringify({ note: '凍結區快照。只有在 Yolin 明確同意動凍結區之後才重產（scripts/frozen.mjs 開頭）。', units: Object.fromEntries(now.map((x) => [x.key, x.hash])) }, null, 2)}\n`);
    console.log(`  · 已重產 ${SNAP_REL}（${now.length} 個單位）`);
  }
  const snap = JSON.parse(read(SNAP_REL)).units;

  noneOf(now, (x) => x.hash == null, '每個凍結單位都切得出來（檔案在、函式找得到、括號平衡）');
  noneOf(now, (x) => snap[x.key] !== x.hash,
    `凍結區裡沒有任何一個檔案或函式被改過（連註解也不行）`);
  eq(Object.keys(snap).sort(), now.map((x) => x.key).sort(), '快照涵蓋的單位＝§0 列出的單位（§0 改了清單，快照要跟著重產）');

  // 對照組：用合成的條文與原始碼，確認解析器與切函式真的有在分辨
  eq(parseFrozenList('`js/a.js` 全部；`js/b.js` 的 `f1`／`f2`；`js/c.js` 全部'),
    [{ file: 'js/a.js', fn: null }, { file: 'js/b.js', fn: 'f1' }, { file: 'js/b.js', fn: 'f2' }, { file: 'js/c.js', fn: null }],
    '（對照）條文解析：整檔與函式分得開');
  const FAKE = 'export function a(x) {\n  if (x) { return 1; }\n  return 2;\n}\n\nexport function b() {\n  return 3;\n}\n';
  eq(extractFunction(FAKE, 'a'), 'export function a(x) {\n  if (x) { return 1; }\n  return 2;\n}', '（對照）切得出完整的函式，不會切到下一個');
  ok(hashOf(extractFunction(FAKE, 'a')) !== hashOf(extractFunction(FAKE.split('return 2;').join('return 2; // 改了註解'), 'a')),
    '（對照）函式裡只改一行註解，雜湊就不一樣');
  ok(hashOf(extractFunction(FAKE, 'a')) === hashOf(extractFunction(FAKE.split('return 3;').join('return 4;'), 'a')),
    '（對照）改的是別的函式，這個函式的雜湊不變（函式層級的凍結不會誤殺同檔的其他程式）');
}

done('doctest');
