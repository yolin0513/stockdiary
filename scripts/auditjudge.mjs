// assertaudit 的判斷邏輯與對照組（SPEC_檢查器修補 S3，F1）。
//
// 為什麼抽出來：assertaudit 跑一次要 9 分鐘，不在 npm test 裡；它自己的判斷邏輯壞掉時
// （例如「母體 ≤ 2」的篩選改壞），以前報告只寫「（沒有）」、回傳 0，沒有任何東西會發現（v9 盤點實測）。
// 抽成模組之後：assertaudit 開頭先跑對照組、沒過就停；scripts/controltest.mjs 每版在 npm test 裡跑同一組。
//
// 三種必敗對照組（F1）＋一個必過的：
//   · 一條一定失敗的斷言 → 判成「測試本身沒過；收到 N 筆」（紅了，但資料有寫出來，不是故障）
//   · 母體是空的 noneOf   → 它那一筆的 n 是 0，必須被「母體 ≤ 2」挑出來
//   · 寫出資料前就崩掉   → 判成「沒收到任何資料」
//   · 乾淨的測試（母體 3）→ 判成通過，而且不能被「母體 ≤ 2」挑出來（不然一個「什麼都挑」的篩選也會過）
// 探針是當場寫的小測試，跑的是跟真實收集同一段程式（collect、classify、tinyOf）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- 登記：assertaudit 要收集哪幾支（S5 從 assertaudit.mjs 搬來，好讓 controltest 每版做孤兒檢查）----
// 只跑不需要真網路、也不會改寫原始碼的那些。npm test 鏈上的每一支，不在這裡就要在 AUDIT_SKIP 寫理由——
// 以前 v9 新加進鏈的 gatescan、taptest 都沒補進來，沒有任何東西會發現（v9 盤點實測）。
export const AUDIT_TESTS = [
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
  // 2026-09-24（S5）孤兒檢查抓到的：v9 之後接進鏈、當時沒補進來的三支
  'taptest', 'controltest', 'gatescan',
  // 2026-09-24：三支 build 的寫檔前關卡（孤兒檢查一接進鏈就點名它）
  'buildtest',
  'buildverifytest',
  // 2026-09-24：跳脫掃描（補充說明（四）第 4 點）
  'escscan',
];
/** npm test 鏈上、刻意不收的：名稱 → 理由。 */
export const AUDIT_SKIP = {
  mutationtest: '它會改寫原始碼、再跑別的測試——那些測試的斷言會被重複計數，而且跑一次要一個多小時',
};

/** 從 package.json 的 scripts.test 取出鏈上每一支的名稱（node scripts/<名稱>.mjs）。 */
export function chainOf(testCmd) {
  return [...String(testCmd).matchAll(/node scripts\/([\w-]+)\.mjs/g)].map((m) => m[1]);
}

/** 孤兒檢查：鏈上沒登記也沒寫理由的（missing）、登記了卻不在鏈上的（stale）、理由過期的（skipStale）。 */
export function auditOrphans(chain, tests = AUDIT_TESTS, skip = AUDIT_SKIP) {
  return {
    missing: chain.filter((t) => !tests.includes(t) && !(t in skip)),
    stale: tests.filter((t) => !chain.includes(t)),
    skipStale: Object.keys(skip).filter((t) => !chain.includes(t)),
  };
}

/** 資料檔裡「這一支」寫了幾筆。某一行解析不了就讓它拋錯（故障時停下，不當成 0 筆）。 */
export function rowsOf(outFile, name) {
  if (!fs.existsSync(outFile)) return [];
  return fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.test === name);
}

/** 跑一支測試收集斷言資料。name 是那支測試 done() 的名稱（本 repo 等於檔名）。 */
export function collect(file, name, outFile, cwd = path.dirname(HERE)) {
  let passed = true;
  try {
    execFileSync(process.execPath, [file], {
      cwd,
      env: { ...process.env, SD_AUDIT: '1', SD_AUDIT_OUT: outFile },
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15 * 60 * 1000,
    });
  } catch { passed = false; }   // 測試紅了不是故障：它的斷言照樣寫進資料檔，下面數得到
  return { passed, rows: rowsOf(outFile, name) };
}

/** 'ok'｜'red-with-data'（紅了，但資料有寫出來）｜'no-data'（寫出資料前就崩了，報告裡不會有它） */
export function classify({ passed, rows }) {
  if (rows.length === 0) return 'no-data';
  return passed ? 'ok' : 'red-with-data';
}

export const isAssert = (r) => r.kind !== 'section' && r.kind !== 'note';
/** 母體只有 0–2 項的集合斷言（0 是空母體——tap 會判它紅，但它的那一筆照樣要被挑出來看）。 */
export const tinyOf = (asserts) => asserts.filter((r) => ['noneOf', 'everyOf'].includes(r.kind) && r.n != null && r.n <= 2);
/** 對照組只有 1 個（或 0 個）正例或反例的 detects。 */
export const thinDetectOf = (asserts) => asserts.filter((r) => r.kind === 'detects' && r.n != null && r.n <= 1);

/** 對照組。回傳 [{ key, name, ok, detail }]；呼叫端決定怎麼印、失敗時停下。 */
export function controls() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditjudge-'));
  const out = path.join(dir, 'audit.jsonl');
  const tap = JSON.stringify(pathToFileURL(path.join(HERE, 'tap.mjs')).href);
  const probe = (name, body) => {
    const file = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(file, `import { ok, noneOf, detects, done } from ${tap};\n${body}\n`);
    return collect(file, name, out);
  };
  try {
    const fail = probe('probe-fail', "ok(false, '一定失敗的斷言');\ndone('probe-fail');");
    const empty = probe('probe-empty', "noneOf([], () => true, '空母體');\ndone('probe-empty');");
    const crash = probe('probe-crash', "throw new Error('寫出資料前就崩了');");
    const clean = probe('probe-clean', "noneOf([1, 2, 3], (x) => x > 5, '母體 3 的乾淨斷言');\ndone('probe-clean');");
    const res = [];
    res.push({ key: 'fail', name: '一條一定失敗的斷言 → 判成「紅了，但資料有寫出來」', ok: classify(fail) === 'red-with-data', detail: `判成 ${classify(fail)}，${fail.rows.length} 筆` });
    const emptyTiny = tinyOf(empty.rows.filter(isAssert));
    res.push({ key: 'empty', name: '空母體的 noneOf → 它那一筆（n=0）被「母體 ≤ 2」挑出來', ok: emptyTiny.length === 1 && emptyTiny[0].n === 0, detail: `挑出 ${emptyTiny.length} 筆` });
    res.push({ key: 'crash', name: '寫出資料前就崩掉 → 判成「沒收到任何資料」', ok: classify(crash) === 'no-data', detail: `判成 ${classify(crash)}，${crash.rows.length} 筆` });
    const cleanTiny = tinyOf(clean.rows.filter(isAssert));
    res.push({ key: 'clean', name: '（必過）母體 3 的乾淨測試 → 判成通過、不被「母體 ≤ 2」挑出來', ok: classify(clean) === 'ok' && cleanTiny.length === 0, detail: `判成 ${classify(clean)}，挑出 ${cleanTiny.length} 筆` });

    // 孤兒檢查（S5）：合成的鏈與清單，跑的是跟 controltest 真實檢查同一段 chainOf／auditOrphans
    const chain = chainOf('node scripts/alpha.mjs && node scripts/secret-leak-test.mjs && node scripts/newtest.mjs && node scripts/mutationtest.mjs');
    const o1 = auditOrphans(chain, ['alpha', 'secret-leak-test'], { mutationtest: '理由' });
    res.push({ key: 'orphan-missing', name: '鏈上多了一支沒登記的 → 報出它（孤兒）', ok: o1.missing.length === 1 && o1.missing[0] === 'newtest', detail: `報了：${o1.missing.join('、') || '（沒有）'}` });
    const o2 = auditOrphans(chain, ['alpha', 'secret-leak-test', 'newtest', 'goner'], { mutationtest: '理由' });
    res.push({ key: 'orphan-stale', name: '清單裡有一支不在鏈上 → 報出它（過期）', ok: o2.stale.length === 1 && o2.stale[0] === 'goner', detail: `報了：${o2.stale.join('、') || '（沒有）'}` });
    const o3 = auditOrphans(chain, ['alpha', 'secret-leak-test', 'newtest'], { mutationtest: '理由', oldtest: '理由' });
    const o4 = auditOrphans(chain, ['alpha', 'secret-leak-test', 'newtest'], { mutationtest: '理由' });
    res.push({ key: 'orphan-skip-stale', name: '不收的理由寫給一支不在鏈上的 → 報出它（理由過期）', ok: o3.skipStale.length === 1 && o3.skipStale[0] === 'oldtest', detail: `報了：${o3.skipStale.join('、') || '（沒有）'}` });
    const n4 = o4.missing.length + o4.stale.length + o4.skipStale.length;
    res.push({ key: 'orphan-clean', name: '（必過）鏈上 4 支全部登記或寫了理由 → 什麼都不報', ok: chain.length === 4 && chain.includes('secret-leak-test') && n4 === 0, detail: `鏈取到 ${chain.length} 支（${chain.join('、')}），報了 ${n4}` });
    return res;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
