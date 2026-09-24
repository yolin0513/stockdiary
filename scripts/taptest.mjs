// tap.mjs 自己的測試（npm run taptest；在 npm test 鏈裡）。
//
// tap.mjs 是每一支測試都靠的那道防線：noneOf／everyOf 的「母體是空的就紅」、detects 的「正例反例都要有」。
// 2026-09-24 盤點實測：把 noneOf 的「母體非空」拿掉，整個 npm test 鏈 30 支沒有一支紅——
// 那道防線本身沒有任何測試守著，突變清單也一條都沒有。這支補上。
//
// 做法：斷言一紅，呼叫它的那支測試就跟著紅，所以「應該紅」的斷言不能在這裡直接呼叫。
// 每一種情境當場寫一支小探針、另開子程序跑，看它的回傳值與輸出。
// 對照組：母體非空、乾淨的斷言必須放行——不然一個「什麼都判紅」的 tap 也會讓下面全部通過。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ok, section, done } from './tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAP_URL = pathToFileURL(path.join(HERE, 'tap.mjs')).href;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taptest-'));

/** 跑一支只呼叫一條斷言的探針，回傳 { code, out }。 */
function probe(name, body) {
  const file = path.join(DIR, `${name}.mjs`);
  fs.writeFileSync(file, `import { noneOf, everyOf, detects, done } from ${JSON.stringify(TAP_URL)};\n${body}\ndone('probe');\n`);
  // 探針不寫稽核資料：assertaudit 收集時本支帶著 SD_AUDIT=1，探針故意做的空母體會混進報告（S5 把本支加進 assertaudit 清單時發現）
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, SD_AUDIT: '' } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const failed = (r) => r.code !== 0 && /1 項失敗/.test(r.out);
const passed = (r) => r.code === 0 && /1 項通過/.test(r.out) && !/失敗/.test(r.out);
/**
 * 紅的理由：只取「  ✗ 」那一行**底下**的細節行（六格縮排）。2026-09-24（補充說明（四）第 1 點）以前在整份輸出裡找，
 * 理由的字眼若出現在斷言名稱或別的行，照樣算數——「出現過」不等於「是理由」。
 */
function reasonOf(out) {
  const lines = String(out).split('\n').map((l) => l.replace(/\r$/, ''));
  const got = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('  ✗ ')) continue;
    for (let j = i + 1; j < lines.length && lines[j].startsWith('      '); j += 1) got.push(lines[j].trim());
  }
  return got.join('\n');
}

try {
  section('對照組：取紅的理由的程式，兩個方向');
  {
    const onlyLabel = '  ✗ 母體是空的（這是斷言的名稱，不是理由）\n      命中 1 項\n  ✓ 母體是空的也出現在這裡';
    const inDetail = '  ✓ 無關\n  ✗ 空母體\n      母體是空的 —— 這條斷言沒有檢查到任何東西';
    ok(!/母體是空的/.test(reasonOf(onlyLabel)) && /母體是空的/.test(reasonOf(inDetail)) && reasonOf('') === '',
      '（對照）取紅的理由：字眼只出現在斷言名稱或 ✓ 行 → 不算；出現在 ✗ 底下的細節行 → 算', JSON.stringify([reasonOf(onlyLabel), reasonOf(inDetail)]));
  }

  section('對照組：母體非空、乾淨的斷言要放行（不然「什麼都判紅」的 tap 也會讓下面全過）');
  const okNone = probe('ok-none', "noneOf([1, 2], (x) => x > 5, '對照：乾淨的 noneOf');");
  const okEvery = probe('ok-every', "everyOf([1, 2], (x) => x > 0, '對照：乾淨的 everyOf');");
  const okDetects = probe('ok-detects', "detects((x) => x > 5, { shouldHit: [9], shouldMiss: [1] }, '對照：正反例都有的 detects');");
  ok(passed(okNone), `（對照）母體非空、沒有命中的 noneOf 放行（exit ${okNone.code}）`, okNone.out.slice(0, 200));
  ok(passed(okEvery), `（對照）母體非空、全部符合的 everyOf 放行（exit ${okEvery.code}）`, okEvery.out.slice(0, 200));
  ok(passed(okDetects), `（對照）正反例都有、都判對的 detects 放行（exit ${okDetects.code}）`, okDetects.out.slice(0, 200));

  section('母體是空的就紅：斷言沒檢查到任何東西，不能算通過');
  const emptyNone = probe('empty-none', "noneOf([], () => true, '空母體');");
  ok(failed(emptyNone) && /母體是空的/.test(reasonOf(emptyNone.out)),
    `空母體的 noneOf 必須紅，而且講明是母體是空的（exit ${emptyNone.code}）`, emptyNone.out.slice(0, 200));
  const emptyEvery = probe('empty-every', "everyOf([], () => true, '空母體');");
  ok(failed(emptyEvery) && /母體是空的/.test(reasonOf(emptyEvery.out)),
    `空母體的 everyOf 必須紅，而且講明是母體是空的（exit ${emptyEvery.code}）`, emptyEvery.out.slice(0, 200));

  section('對照組要正例反例都有：只給一邊，一個「永遠回 true」的檢查器也會過');
  const noMiss = probe('no-miss', "detects(() => true, { shouldHit: ['a'], shouldMiss: [] }, '沒有反例');");
  ok(failed(noMiss) && /沒有給反例/.test(reasonOf(noMiss.out)),
    `沒有反例的 detects 必須紅，而且講明沒有給反例（exit ${noMiss.code}）`, noMiss.out.slice(0, 200));
  const noHit = probe('no-hit', "detects(() => false, { shouldHit: [], shouldMiss: ['a'] }, '沒有正例');");
  ok(failed(noHit) && /沒有給正例/.test(reasonOf(noHit.out)),
    `沒有正例的 detects 必須紅，而且講明沒有給正例（exit ${noHit.code}）`, noHit.out.slice(0, 200));

  section('命中就紅（基本功能）');
  const hitNone = probe('hit-none', "noneOf([1, 9], (x) => x > 5, '有命中');");
  ok(failed(hitNone) && /命中 1 項/.test(reasonOf(hitNone.out)), `有命中的 noneOf 必須紅，而且講得出命中幾項（exit ${hitNone.code}）`, hitNone.out.slice(0, 200));
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

done('taptest');
