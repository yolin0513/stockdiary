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
    return res;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
