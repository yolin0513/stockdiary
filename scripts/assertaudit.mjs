// 假斷言健檢（npm run assertaudit）。
//
// 這個專案反覆出現同一種缺陷：**斷言跑得過，但它沒在檢查東西。**
// 已經踩過的形狀至少有六種：
//   · 母體是空的（noneOf 檢查了 0 項）
//   · 母體只剩一個佔位元素（layouttest 的 84 組掃成 1 組）
//   · 對照組缺席（只驗「該抓的抓到」，沒驗「不該抓的沒抓」）
//   · 等待條件在上一頁就已經成立（等於什麼都沒等到）
//   · 反例太弱，被別條規則順便擋掉（金鑰前綴那條）
//   · 說明行寫成 ok(true, …)，混進通過數
//
// 一條一條人工看會漏，所以用機器掃：跑一次全套（SD_AUDIT=1），
// 把每條斷言的母體大小記下來，然後挑出可疑的。
//
// **這支不是 pass/fail 的測試**，是一份報告。它不進 npm test。
// 但**資料不齊時回傳 1**（2026-09-24）：有哪一支沒收到任何資料、或一支都沒跑到，報告最後講明並回傳 1——
// 以前崩掉那支的斷言會憑空消失、照樣回傳 0，看起來像一份完整的報告。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'assert-audit.jsonl');

// 只跑不需要真網路、也不會改寫原始碼的那些（mutationtest 會跑別的測試，會重複計數）
const TESTS = [
  // 純靜態、最快，放第一個
  'doctest',
  'roctest', 'fmttest', 'parsetest', 'settletest', 'changestest', 'dividendtest',
  'plantest', 'calctest', 'throttletest', 'datatest', 'shelltest', 'holdingtest',
  'eventtest', 'dcatest', 'calcviewtest', 'versionmixtest', 'racetest', 'newstest',
  'secret-leak-test', 'insighttest', 'backuptest', 'concentrationtest', 'layouttest',
  'uikittest', 'divrecordtest',
  // v0.7.7 之後新增的兩支端對端 —— 不補進來的話，它們的 140+ 條斷言
  // 從來不會被假斷言健檢掃到（這正是這支報告存在的理由）。
  'scenariotest', 'pathtest',
  // 2026-09-23（SPEC_測試可信度 A）接進 npm test 鏈的秒級檢查
  'checkmutations',
];

const only = process.argv[2];
const list = only ? TESTS.filter((t) => t.includes(only)) : TESTS;

fs.rmSync(OUT, { force: true });
process.stdout.write(`跑 ${list.length} 支測試收集斷言資料…\n`);
if (list.length === 0) {
  process.stdout.write(`一支都沒跑到（過濾「${only}」對不到任何登記的測試）——沒有資料，不產報告。\n`);
  process.exit(1);
}

// 每支跑完，數資料檔裡「這一支」寫了幾筆（每支測試 done() 的名稱就是檔名，2026-09-24 逐支核對過）。
// **0 筆＝它在寫出資料之前就崩了**，它的斷言會從報告裡憑空消失。2026-09-24 以前這裡照樣印
// 「測試本身沒過，資料仍然收到了」、最後回傳 0——盤點實測：兩支裡崩掉一支，報告只算到一支，回傳 0。
// 資料檔某一行解析不了就讓它拋錯停下，不要包 catch 把它當成 0 筆（v9 §5.13：故障時停下）。
const rowsOf = (name) => (fs.existsSync(OUT)
  ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).test === name).length
  : 0);
const noData = [];
for (const t of list) {
  const file = path.join(ROOT, 'scripts', `${t}.mjs`);
  if (!fs.existsSync(file)) { process.stdout.write(`  ✗ 找不到 ${t}.mjs（登記了但檔案不在）\n`); noData.push(t); continue; }
  let passed = true;
  try {
    execFileSync(process.execPath, [file], {
      cwd: ROOT,
      env: { ...process.env, SD_AUDIT: '1', SD_AUDIT_OUT: OUT },
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15 * 60 * 1000,
    });
  } catch { passed = false; }   // 測試紅了不是故障：它的斷言照樣寫進資料檔，下面數得到
  const n = rowsOf(t);
  if (n === 0) {
    noData.push(t);
    process.stdout.write(`  ✗ ${t}（**沒收到任何資料**——它在寫出資料之前就崩了或沒跑到 done()，報告裡不會有它）\n`);
  } else {
    process.stdout.write(passed ? `  ✓ ${t}（${n} 筆）\n` : `  ✗ ${t}（測試本身沒過；收到 ${n} 筆資料）\n`);
  }
}
if (!fs.existsSync(OUT)) {
  process.stdout.write('資料檔一筆都沒有——沒有任何一支寫出資料，不產報告。\n');
  process.exit(1);
}

const rows = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const asserts = rows.filter((r) => r.kind !== 'section' && r.kind !== 'note');
const notes = rows.filter((r) => r.kind === 'note');

const line = (s = '') => process.stdout.write(`${s}\n`);
line();
line('='.repeat(70));
line(`共 ${asserts.length} 條斷言、${notes.length} 行說明，來自 ${new Set(rows.map((r) => r.test)).size} 支測試`);
line('='.repeat(70));

// ---------------------------------------------------------------------------
line('\n【1】母體只有 1–2 項的集合斷言');
line('    母體太小的 noneOf／everyOf 幾乎沒有鑑別力 —— 它可能只是剛好沒踩到。');
const tiny = asserts.filter((r) => ['noneOf', 'everyOf'].includes(r.kind) && r.n != null && r.n <= 2);
if (tiny.length === 0) line('    （沒有）');
for (const r of tiny.sort((a, b) => a.n - b.n)) {
  line(`    n=${r.n}  [${r.test}] ${r.section} → ${r.msg}`);
}

// ---------------------------------------------------------------------------
line('\n【2】對照組只有 1 個正例或 1 個反例');
line('    detects 的鑑別力取決於兩邊的樣本數；只有一個很容易剛好通過。');
const thinDetect = asserts.filter((r) => r.kind === 'detects' && r.n != null && r.n <= 1);
if (thinDetect.length === 0) line('    （沒有）');
for (const r of thinDetect) line(`    min=${r.n}  [${r.test}] ${r.section} → ${r.msg}`);

// ---------------------------------------------------------------------------
line('\n【3】完全沒有集合斷言或對照組的區段');
line('    一個區段全是單點 ok()／eq()，通常代表它只驗了「某一次剛好對」。');
const bySection = new Map();
for (const r of asserts) {
  const key = `${r.test} ▸ ${r.section || '(無區段)'}`;
  const cur = bySection.get(key) ?? { total: 0, strong: 0 };
  cur.total += 1;
  if (['noneOf', 'everyOf', 'detects'].includes(r.kind)) cur.strong += 1;
  bySection.set(key, cur);
}
const weakSections = [...bySection].filter(([, v]) => v.strong === 0 && v.total >= 4);
if (weakSections.length === 0) line('    （沒有）');
for (const [k, v] of weakSections.sort((a, b) => b[1].total - a[1].total)) {
  line(`    ${v.total} 條全是單點  ${k}`);
}

// ---------------------------------------------------------------------------
line('\n【4】重複的斷言訊息');
line('    同一句話出現很多次，通常是複製貼上時忘了改 —— 也可能兩條在驗同一件事。');
const byMsg = new Map();
for (const r of asserts) byMsg.set(r.msg, (byMsg.get(r.msg) ?? 0) + 1);
const dup = [...byMsg].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 12);
if (dup.length === 0) line('    （沒有）');
for (const [m, n] of dup) line(`    ×${n}  ${m}`);

// ---------------------------------------------------------------------------
line('\n【5】每支測試的斷言強度');
const byTest = new Map();
for (const r of asserts) {
  const cur = byTest.get(r.test) ?? { total: 0, strong: 0 };
  cur.total += 1;
  if (['noneOf', 'everyOf', 'detects'].includes(r.kind)) cur.strong += 1;
  byTest.set(r.test, cur);
}
for (const [t, v] of [...byTest].sort((a, b) => (a[1].strong / a[1].total) - (b[1].strong / b[1].total))) {
  const pct = ((v.strong / v.total) * 100).toFixed(0);
  line(`    ${String(pct).padStart(3)}%  ${String(v.strong).padStart(3)}/${String(v.total).padStart(3)} 集合或對照  ${t}`);
}

line(`\n原始資料：${path.relative(ROOT, OUT)}`);
line('這是報告不是測試 —— 上面每一條都要人看過再決定要不要改。');

// 報告不是 pass/fail，但**資料不齊就不能當成齊的**：少收到的那幾支，它們的斷言不在上面任何一段裡。
if (noData.length) {
  line(`\n✗ 這份報告不完整：要跑 ${list.length} 支，${noData.length} 支沒收到任何資料（${noData.join('、')}）——`);
  line('  它們的斷言沒有被上面任何一段檢查到。先讓那幾支能跑到 done()，再重跑一次。');
  process.exit(1);
}
