// 突變清單的秒級檢查（npm run checkmutations；也在 npm test 鏈裡）。
//
// 不跑任何突變、不改任何檔案。它守的是「突變本身」與「判定邏輯」：
//   · 判定：帶 expect 的突變，紅錯地方要判不合格（SPEC_測試可信度 A1）
//   · 每一條 expect 都真的在對應測試的原始碼裡（A2 —— 打錯字的 expect 永遠不會命中）
//   · 標記以下新增的突變一律帶 expect
//
// 為什麼要獨立一支：mutationtest 整套要一個半小時，這些問題不該等到那時候才看得到。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, detects, everyOf, note } from './tap.mjs';
import {
  failedAssertions, judge, applyMutation, loadMutations, expectProblems, legacyCount, EXPECT_MARKER,
} from './mutjudge.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};
const APP_VERSION = /APP_VERSION = '([^']+)'/.exec(read('js/version.js'))[1];
const SRC = read('scripts/mutationtest.mjs');
const MUTATIONS = loadMutations(SRC, APP_VERSION);

// ---------------------------------------------------------------------------
section('判定：紅要紅在對的那一條（A1）');

// 合成的測試輸出，照 tap.mjs 的格式：✓／✗ 兩格縮排，細節六格縮排
const OUT_HIT = '\n— 某段 —\n  ✓ 無關的那條\n  ✗ 目標斷言：數字對得上（檢查了 3 項）\n      命中 1 項\n\nx：1 項通過，1 項失敗';
const OUT_ELSEWHERE = '\n— 某段 —\n  ✗ 別的斷言\n      細節裡提到目標斷言這幾個字\n\nx：0 項通過，1 項失敗';
const OUT_CRASH = 'file:///x.mjs:3\nTypeError: 目標斷言 is not a function\n    at x.mjs:3:1';

eq(failedAssertions(OUT_HIT), ['目標斷言：數字對得上（檢查了 3 項）'], '從輸出取出失敗的斷言訊息（只取 ✗ 行，不取 ✓ 與細節行）');
eq(judge({ code: 1, out: OUT_HIT }, '目標斷言').verdict, 'red', '帶 expect、紅在含 expect 的那一條 → 合格');
eq(judge({ code: 1, out: OUT_ELSEWHERE }, '目標斷言').verdict, 'wrong-place',
  '對照：紅了，但 expect 只出現在細節行、不在任何 ✗ 行 → 判成「紅錯地方」');
eq(judge({ code: 1, out: OUT_CRASH }, '目標斷言').verdict, 'wrong-place',
  '對照：測試直接崩了（沒有 ✗ 行，expect 只出現在例外訊息裡）→ 判成「紅錯地方」');
eq(judge({ code: 0, out: '' }, '目標斷言').verdict, 'not-red', '對照：完全沒紅 → 判成「沒紅」，跟「紅錯地方」分得開');
eq(judge({ code: 1, out: OUT_ELSEWHERE }).verdict, 'red', '沒帶 expect 的照舊：只要紅就算');

// ---------------------------------------------------------------------------
section('套用突變不會偷改替換字串（接手者第 40 條）');
eq(applyMutation('a X b', 'X', "$$ $& $'"), "a $$ $& $' b",
  '替換字串裡的 $$、$&、$\' 原樣寫進去（String.replace(字串, 字串) 會把它們當特殊序列）');

// ---------------------------------------------------------------------------
section('每一條 expect 都找得到（A2）');

const withExpect = MUTATIONS.filter((m) => m.expect != null);
ok(withExpect.length > 0, `（前提）帶 expect 的突變有 ${withExpect.length} 條（全部 ${MUTATIONS.length} 條）`);
everyOf(withExpect, (m) => expectProblems(m, read).length === 0,
  '每一條 expect 都是對應測試原始碼裡的一段字面（打錯字的永遠不會命中）');

// 對照組：拿一支真的存在的測試造兩條假突變，一條 expect 對、一條打錯字
const REAL_TEST = 'checkmutations';
const REAL_LINE = '每一條 expect 都是對應測試原始碼裡的一段字面';
detects((m) => expectProblems(m, read).length > 0, {
  shouldHit: [
    { name: '假：打錯字', test: REAL_TEST, expect: REAL_LINE + '（打錯）' },
    { name: '假：空字串', test: REAL_TEST, expect: '   ' },
    { name: '假：測試不存在', test: 'no-such-test', expect: REAL_LINE },
  ],
  shouldMiss: [
    { name: '假：正確', test: REAL_TEST, expect: REAL_LINE },
    { name: '假：沒帶 expect', test: REAL_TEST },
  ],
}, 'expect 檢查抓得到打錯字、空字串、測試不存在，也不會誤殺正確的');

// ---------------------------------------------------------------------------
section('標記以下新增的突變一律帶 expect');

const LEGACY = legacyCount(SRC);
ok(LEGACY != null && LEGACY > 200, `（前提）mutationtest.mjs 裡找得到標記「${EXPECT_MARKER}」，它之前有 ${LEGACY} 條舊突變`);
const fresh = MUTATIONS.slice(LEGACY ?? MUTATIONS.length);
everyOf(fresh, (m) => typeof m.expect === 'string' && m.expect.trim() !== '',
  `標記以下的 ${fresh.length} 條新突變都帶 expect`);
// 對照：造一段合成的原始碼，標記在第 2 條之後
const FAKE_SRC = [
  'const MUTATIONS = [',
  '  {', "    find: 'a',", '  },',
  '  {', "    find: 'b',", '  },',
  '  ' + EXPECT_MARKER,
  '  {', "    find: 'c',", '  },',
  '];',
].join('\n');
eq(legacyCount(FAKE_SRC), 2, '對照：標記在第 2 條之後，數得出「之前有 2 條」');
eq(legacyCount('const MUTATIONS = [\n];'), null, '對照：沒有標記 → 回 null（上面的前提就會紅）');

note(`沒帶 expect 的舊突變還有 ${MUTATIONS.filter((m) => m.expect == null).length} 條 —— 照 SPEC 不整批補`);

done('checkmutations');
