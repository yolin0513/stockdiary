// F10：三支入口（assertaudit、sweep、livecheck）的「對照組沒過就停」——從真實入口驗，讓真的依賴失敗。
//
// 為什麼（2026-09-24，Dispatch 裁示；證據檔「盤點」一節的「該補卻還沒補」第 1 件）：
//   三支開頭都先跑對照組，沒過就 process.exit(1)。以前只有判斷邏輯（controltest）每版被驗，入口「照判斷停下」那一行
//   只實跑過一次——拿掉那一停，沒有任何測試會紅。
// 做法（F10 第 1b 點第 1 種：讓真的依賴失敗，不在正式程式裡留後門）：
//   在 repo 底下的 .logs/（不進版控；放這裡，node 才找得到 repo 的 node_modules）放一份 scripts／js／data 的複本，
//   把入口依賴的東西真的弄壞——assertaudit、sweep 弄壞判斷模組，livecheck 弄壞錄好的回應——再從入口跑。
//   網路一律不打：預先載入一個模組，把 fetch 換成「記下網址、然後以 97 結束」。
// 每一支兩個方向：依賴壞了 → 回 1、停下的理由是對照組、**沒有往下做**（沒打網路／沒跑測試）；
//   依賴沒壞（對照）→ 過了對照組、真的往下做（記到一個網路請求、或開始跑測試）——證明「沒往下做」不是因為本來就走不到。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ok, eq, section, done } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const T = path.join(ROOT, '.logs', `entrygatetest-${process.pid}`);
const NETLOG = path.join(T, 'net.log');
const PRELOAD = path.join(T, 'netguard.mjs');

/** 子程序的輸出放進斷言細節時壓成一行：原樣放進去，裡面「  ✗ …」開頭的行會被突變判定當成這支測試自己的失敗斷言。 */
const oneLine = (t) => String(t).replace(/\r?\n/g, ' ⏎ ');
eq(oneLine('甲\n  ✗ 乙\r\n丙'), '甲 ⏎   ✗ 乙 ⏎ 丙', '（對照）oneLine：子程序的多行輸出壓成一行（「  ✗」不會出現在行首）');
/** 某個固定開頭的那一行（只認行首）。 */
const lineOf = (out, head) => out.replace(/\r/g, '').split('\n').find((l) => l.startsWith(head)) ?? null;
eq(lineOf('a\n對照組沒過：x\n', '對照組沒過：'), '對照組沒過：x', '（對照）lineOf：行首是那個開頭 → 抽得到');
eq(lineOf('說明：對照組沒過：x\n', '對照組沒過：'), null, '（對照）lineOf：只在行中間出現 → 不算');

function fresh() {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(T, { recursive: true });
  for (const d of ['scripts', 'js', 'data']) {
    fs.cpSync(path.join(ROOT, d), path.join(T, d), { recursive: true, filter: (src) => !src.includes('.mutation-backup') });
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(T, 'package.json'));
  fs.writeFileSync(PRELOAD, [
    "import fs from 'node:fs';",
    'globalThis.fetch = async (u) => { fs.appendFileSync(process.env.NETLOG, String(u) + "\\n"); process.exit(97); };',
    '',
  ].join('\n'));
}
/** 改一處（錨點要剛好一次）。 */
function breakFile(rel, find, replace) {
  const f = path.join(T, rel);
  const s = fs.readFileSync(f, 'utf8');
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`${rel}：錨點出現 ${n} 次（要剛好 1 次）`);
  fs.writeFileSync(f, s.split(find).join(replace));
}
function run(script, args = []) {
  fs.rmSync(NETLOG, { force: true });
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, `scripts/${script}`, ...args],
    { cwd: T, encoding: 'utf8', env: { ...process.env, NETLOG, SD_AUDIT: '' }, timeout: 300000 });
  const net = fs.existsSync(NETLOG) ? fs.readFileSync(NETLOG, 'utf8').split('\n').filter(Boolean) : [];
  return { code: r.status, out: `${r.stdout}${r.stderr}`, net };
}

const CASES = [
  {
    label: 'F10 assertaudit', broke: 'F10 assertaudit・依賴壞了：', script: 'assertaudit.mjs', args: ['roctest'], stopHead: '對照組沒過：assertaudit',
    breakIt: () => breakFile('scripts/auditjudge.mjs', "r.kind) && r.n != null && r.n <= 2);", "r.kind) && r.n != null && r.n <= -1);"),
    went: (r) => lineOf(r.out, '跑 1 支測試收集斷言資料') != null || fs.existsSync(path.join(T, 'assert-audit.jsonl')),
    wentWhat: '開始跑測試收集資料',
  },
  {
    label: 'F10 sweep', broke: 'F10 sweep・依賴壞了：', script: 'sweep.mjs', args: [], stopHead: '對照組沒過：sweep',
    breakIt: () => breakFile('scripts/sweepjudge.mjs', "  if (sw !== local) out.push({ where: 'sw.js', got: sw });", "  if (false) out.push({ where: 'sw.js', got: sw });"),
    went: (r) => r.net.length > 0, wentWhat: '打出網路請求',
  },
  {
    label: 'F10 livecheck', broke: 'F10 livecheck・依賴壞了：', script: 'livecheck.mjs', args: [], stopHead: '對照組沒過：livecheck',
    // 對照組真的會讀的那份（第一版挑了 holiday-schedule-115.json，對照組根本不讀它，這一格就沒擋——換成 twt48u-forecast.json）
    breakIt: () => fs.writeFileSync(path.join(T, 'scripts/fixtures/twt48u-forecast.json'), '{ 壞掉的錄音'),
    went: (r) => r.net.length > 0, wentWhat: '打出網路請求',
  },
];

try {
  for (const c of CASES) {
    section(c.label);
    // 對照（依賴沒壞）：過了對照組、真的往下做
    fresh();
    const g = run(c.script, c.args);
    ok(lineOf(g.out, c.stopHead) == null && c.went(g), `${c.label}・依賴沒壞（對照）：過了對照組、${c.wentWhat}`,
      `回傳 ${g.code}；網路 ${g.net.length} 筆；${oneLine(g.out.slice(-300))}`);
    // 依賴壞了：停下、理由是對照組、沒往下做
    fresh();
    c.breakIt();
    const b = run(c.script, c.args);
    ok(b.code === 1 && lineOf(b.out, c.stopHead) != null, `${c.broke}回 1，停下的理由是對照組`, `回傳 ${b.code}；${oneLine(b.out.slice(-300))}`);
    ok(!c.went(b), `${c.broke}沒有往下做（沒有${c.wentWhat}）`, `網路 ${JSON.stringify(b.net)}；${oneLine(b.out.slice(-300))}`);
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done('entrygatetest');
