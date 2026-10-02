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
import { ok, eq, section, done, detects, everyOf, noneOf, note } from './tap.mjs';
import { loadRegistry } from './assertreg.mjs';
import {
  failedAssertions, judge, applyMutation, loadMutations, expectProblems, registryProblems, findProblems, legacyCount, EXPECT_MARKER,
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
eq(judge({ test: 'x', code: 1, out: OUT_HIT }, '目標斷言').verdict, 'red', '帶 expect、紅在含 expect 的那一條 → 合格');
eq(judge({ test: 'x', code: 1, out: OUT_ELSEWHERE }, '目標斷言').verdict, 'wrong-place',
  '對照：紅了，但 expect 只出現在細節行、不在任何 ✗ 行 → 判成「紅錯地方」');
eq(judge({ test: 'x', code: 1, out: OUT_CRASH }, '目標斷言').verdict, 'not-counted',
  '情境未成立・崩潰：測試直接崩了（沒有結算行，expect 只出現在例外訊息裡）→ 判成「不算數」（2026-10-03 以前是紅錯地方）');
// 情境未成立（2026-10-03）：逾時、沒有自己的結算行 → 不算紅、不算通過；排在 exit code 之前判
eq(judge({ test: 'x', code: 1, out: OUT_HIT, timedOut: true }, '目標斷言').verdict, 'not-counted',
  '情境未成立・逾時：就算輸出裡已經有紅在目標斷言的 ✗ 行，逾時一律判成「不算數」');
eq(judge({ test: 'x', code: 1, out: OUT_HIT, timedOut: true }).verdict, 'not-counted',
  '情境未成立・逾時（沒帶 expect）：不能被 exit code 判成紅（gateselftest 那兩條就是這樣被記成被抓到）');
eq(judge({ test: 'x', code: 1, out: '\n— 某段 —\n  ✗ 目標斷言：紅了\n' }, '目標斷言').verdict, 'not-counted',
  '情境未成立・沒有結算行：有 ✗ 行但沒跑到結算（中途崩了或被殺）→ 不算數');
eq(judge({ test: 'x', code: 1, out: '\n  ✗ 目標斷言：紅了\n\ny：0 項通過，1 項失敗' }, '目標斷言').verdict, 'not-counted',
  '情境未成立・別支的結算行：結算行是別支測試的（子程序印的）→ 不算數');
eq(judge({ test: 'x', code: 1, out: '\n  ✗ 目標斷言：紅了\n  說明 x：0 項通過，1 項失敗' }, '目標斷言').verdict, 'not-counted',
  '情境未成立・結算行不在行首：只在行中間出現 → 不算');
eq(judge({ test: 'x', code: 0, out: '\n— 某段 —\n  ✓ 目標斷言\n\nx：1 項通過' }, '目標斷言').verdict, 'not-red', '對照：完全沒紅 → 判成「沒紅」，跟「紅錯地方」分得開');
// 2026-09-24 Dispatch：232 條沒寫 expect 的要分批補，先做這個對照——故意把一條的 expect 寫成**另一組真的存在的標籤**，判定必須報出來
eq(judge({ test: 'x', code: 1, out: OUT_HIT }, '無關的那條').verdict, 'wrong-place',
  '對照：expect 寫錯成另一組存在的標籤（那一組沒紅）→ 判成「紅錯地方」');
eq(judge({ test: 'x', code: 1, out: OUT_ELSEWHERE }).verdict, 'red', '沒帶 expect 的照舊：情境有成立（有結算行）、只要紅就算');
// 「只紅對應的那一種」（2026-09-24，統籌者驗收指出：以前只要有一條對上 expect 就判 red，不看別組有沒有一起紅）
const OUT_BOTH = '\n— 某段 —\n  ✗ 目標斷言：數字對得上（檢查了 3 項）\n      命中 1 項\n  ✗ 另一組：也紅了\n\nx：0 項通過，2 項失敗';
{
  const both = judge({ test: 'x', code: 1, out: OUT_BOTH }, '目標斷言');
  ok(both.verdict === 'extra-red' && both.extra.length === 1 && both.extra[0] === '另一組：也紅了',
    '只紅對應：紅在對的那一條、別組也一起紅 → 判成「多紅了別組」，並列出多紅的那一條', JSON.stringify(both));
  eq(judge({ test: 'x', code: 1, out: OUT_BOTH }, '目標斷言', ['另一組：']).verdict, 'red',
    '只紅對應（必過）：多紅的那一組有用 alsoRed 明列 → 合格');
  eq(judge({ test: 'x', code: 1, out: OUT_BOTH }, '目標斷言', ['不相干的標籤：']).verdict, 'extra-red',
    '只紅對應：alsoRed 列的是別的標籤 → 照樣判「多紅了別組」');
}
{
  const fakeRead = (rel) => (rel === 'scripts/t.mjs' ? "ok(x, '目標斷言：…'); ok(y, '另一組：…');" : null);
  eq(expectProblems({ test: 't', expect: '目標斷言：', alsoRed: ['另一組：'], alsoRedWhy: '同一行比對，兩組一起紅' }, fakeRead), [],
    'alsoRed（必過）：每一條都是測試原始碼裡的字面 → 沒問題');
  ok(expectProblems({ test: 't', expect: '目標斷言：', alsoRed: ['另一組：'] }, fakeRead).some((p) => p.includes('alsoRedWhy')),
    'alsoRed：有連帶紅卻沒寫理由（alsoRedWhy）→ 報出來');
  ok(expectProblems({ test: 't', expect: '目標斷言：', alsoRed: ['打錯的標籤：'], alsoRedWhy: '同一行比對，兩組一起紅' }, fakeRead).some((p) => p.includes('打錯的標籤：')),
    'alsoRed：有一條在測試原始碼裡找不到 → 報出來');
  ok(expectProblems({ test: 't', expect: '目標斷言：', alsoRed: [''] }, fakeRead).some((p) => p.includes('空的')),
    'alsoRed：空字串（會讓每一條都算宣告過）→ 報出來');
}

// ---------------------------------------------------------------------------
section('expect 必須是失敗訊息的開頭（2026-10-03，Dispatch 決定 A）');
{
  // 三格（JLPT 的結構）：舊判定＋碰巧的樣本 → 要求被滿足（洞原本在）；新判定＋同一個樣本 → 不被滿足；新判定＋真的違規 → 照樣滿足。
  // 碰巧的樣本：另一條失敗斷言的訊息裡嵌了證據（別支檔的原始碼），剛好含 expect 那幾個字——「要求被它不擁有的內容滿足」。
  const EVIDENCE = '\n  ✗ 登記的檔沒有壞寫法：scripts/x.mjs:3 引用了「目標斷言」這幾個字\n\nx：0 項通過，1 項失敗';
  const REAL = '\n  ✗ 目標斷言：數字對得上\n\nx：0 項通過，1 項失敗';
  const IN_DETAIL = '\n  ✗ 別的斷言\n      細節：scripts/x.mjs:3 引用了「目標斷言」這幾個字\n\nx：0 項通過，1 項失敗';
  /** 前置：碰巧的樣本真的被判定看見了（它出現在某一條失敗斷言的訊息裡）；沒有 → 情境未成立。 */
  const sampleSeen = (out) => failedAssertions(out).some((f) => f.includes('目標斷言'));
  /** 2026-10-03 以前的判定（子字串），只在這裡重現，證明洞原本在。 */
  const oldRed = (out, expect) => failedAssertions(out).some((f) => f.includes(expect));
  ok(sampleSeen(EVIDENCE), '（前提）三格：碰巧的樣本真的出現在一條失敗斷言的訊息裡（被判定看見）');
  ok(!sampleSeen(IN_DETAIL), '（對照）三格的前提：樣本只在細節行（不在任何失敗斷言的訊息裡）→ 判成情境未成立');
  ok(oldRed(EVIDENCE, '目標斷言'), '舊判定的洞・第一格：子字串比對時，嵌在別條訊息裡的證據會滿足 expect');
  eq(judge({ test: 'x', code: 1, out: EVIDENCE }, '目標斷言').verdict, 'wrong-place', '舊判定的洞・第二格：新判定（比開頭）下，同一個樣本不滿足 expect → 紅錯地方');
  eq(judge({ test: 'x', code: 1, out: REAL }, '目標斷言').verdict, 'red', '舊判定的洞・第三格（必過）：新判定下，真的紅在那一條 → 照樣判紅');
  eq(judge({ test: 'x', code: 1, out: EVIDENCE + REAL.replace('\n\nx：0 項通過，1 項失敗', '') + '\n' }, '目標斷言', ['不相干：']).verdict, 'extra-red',
    '舊判定的洞・多紅別組也比開頭：嵌了證據的那一條算「多紅了別組」，不會因為含 expect 那幾個字就被當成紅在對的地方');
}
{
  // 登記時就擋：expect／alsoRed 要出現在原始碼某個字面的開頭（緊接在引號後面）；兩個方向
  const src = "ok(a, '標籤甲：訊息'); ok(b, `前文 標籤乙：${x}`); ok(c, `${x} 標籤丙：`);";
  const rd = (rel) => (rel === 'scripts/t.mjs' ? src : null);
  eq(expectProblems({ test: 't', expect: '標籤甲：' }, rd), [], '登記檢查・expect 在開頭（必過）：緊接在引號後面 → 准登記');
  ok(expectProblems({ test: 't', expect: '標籤乙：' }, rd).some((p) => p.includes('沒有出現在任何字面的開頭')),
    '登記檢查・expect 不在開頭：只出現在固定文字中間 → 拒絕登記並點名');
  ok(expectProblems({ test: 't', expect: '標籤丙：' }, rd).some((p) => p.includes('沒有出現在任何字面的開頭')),
    '登記檢查・expect 前面嵌了動態內容：拒絕登記並點名');
  ok(expectProblems({ test: 't', expect: '標籤甲：', alsoRed: ['標籤乙：'], alsoRedWhy: '同一行比對，兩組一起紅' }, rd).some((p) => p.includes('alsoRed「標籤乙：」') && p.includes('開頭')),
    '登記檢查・alsoRed 不在開頭：拒絕登記並點名');
  // 母體：檢查的筆數＝帶 expect 的突變數，而且要等於從原始碼另外數出來的「expect:」筆數（兩個來源核對）
  const withExpect = MUTATIONS.filter((m) => m.expect);
  // 兩種寫法：自成一行的「    expect: …」與寫在同一行的「…, expect: '…' }」；引號三種都算；註解行不算
  const rawCount = SRC.split('\n').filter((l) => !/^\s*\/\//.test(l) && /(^\s+|, )expect: ['"`]/.test(l)).length;
  eq(withExpect.length, rawCount, `（前提）登記檢查的母體：帶 expect 的突變 ${withExpect.length} 條＝原始碼裡數出的 expect 欄位 ${rawCount} 筆`);
}

// ---------------------------------------------------------------------------
section('套用突變不會偷改替換字串（接手者第 40 條）');
eq(applyMutation('a X b', 'X', "$$ $& $'"), "a $$ $& $' b",
  '套用突變不偷改替換字串：$$、$&、$\' 原樣寫進去（String.replace(字串, 字串) 會把它們當特殊序列）');

// ---------------------------------------------------------------------------
section('每一條突變都還有效：find 在目標檔裡剛好出現一次（C）');

const t0 = Date.now();
const stale = MUTATIONS.map((m) => ({ name: m.name, probs: findProblems(m, read) })).filter((x) => x.probs.length);
noneOf(MUTATIONS.map((m) => ({ name: m.name, probs: findProblems(m, read) })), (x) => x.probs.length > 0,
  `突變都還有效・find 剛好一次：全部 ${MUTATIONS.length} 條（改了有差、測試檔存在）`
  + (stale.length ? `；過期的：${stale.map((x) => `${x.name}（${x.probs.join('；')}）`).join('／')}` : ''));
// 對照組：用這支檔案自己當目標，造幾條假突變
const SELF = 'scripts/checkmutations.mjs';
// 「剛好出現一次」的樣本要拆開拼：直接寫成字面的話，這一行自己就是第二次出現
const ONCE = 'const SE' + 'LF = ';
detects((m) => findProblems(m, read).length > 0, {
  shouldHit: [
    { name: '假：find 不存在', file: SELF, find: ONCE + '（不存在的一段）', replace: 'x', test: 'checkmutations' },
    { name: '假：find 出現兩次', file: SELF, find: 'findProblems(m, read)', replace: 'x', test: 'checkmutations' },
    { name: '假：改了等於沒改', file: SELF, find: ONCE, replace: ONCE, test: 'checkmutations' },
    { name: '假：目標檔不存在', file: 'js/no-such-file.js', find: 'a', replace: 'b', test: 'checkmutations' },
    { name: '假：測試不存在', file: SELF, find: ONCE, replace: 'x', test: 'no-such-test' },
  ],
  shouldMiss: [{ name: '假：正常', file: SELF, find: ONCE, replace: 'x', test: 'checkmutations' }],
}, '過期檢查抓得到 find 不存在、出現兩次、改了等於沒改、檔案或測試不存在，也不會誤殺正常的');
note(`檢查 ${MUTATIONS.length} 條花了 ${Date.now() - t0} 毫秒`);

// ---------------------------------------------------------------------------
section('每一條 expect 都找得到（A2）');

const withExpect = MUTATIONS.filter((m) => m.expect != null);
ok(withExpect.length > 0, `（前提）帶 expect 的突變有 ${withExpect.length} 條（全部 ${MUTATIONS.length} 條）`);
everyOf(withExpect, (m) => expectProblems(m, read, loadRegistry(m.test)).length === 0,
  '每一條 expect 都是對應測試原始碼裡的一段字面（打錯字的永遠不會命中）');
{
  // 有斷言登記表的測試，預期對登記表檢查（2026-10-03）：通過時也印出檢查了幾條，免得「0 個問題」跟「沒有表、沒檢查」長得一樣
  const viaReg = withExpect.filter((m) => loadRegistry(m.test));
  note(`對斷言登記表檢查的預期：${viaReg.length} 條（${[...new Set(viaReg.map((m) => m.test))].join('、') || '（沒有）'}）；其餘 ${withExpect.length - viaReg.length} 條對原始碼的字面檢查`);
  for (const m of viaReg) {
    const reg = loadRegistry(m.test);
    note(`  ${m.name}：expect 對應到 ${reg.assertions.filter((a) => a.name.startsWith(m.expect)).length} 條、預期寫於 ${m.regStamp ?? '（沒戳）'}、登記表現在是 ${reg.version}`);
  }
}

section('斷言登記表：預期有歧義、對不到、需要複審（兩個方向）');
{
  const REG = { test: 't', version: '4:abc', assertions: ['甲：一', '甲：二', '乙：唯一', '丙：x'].map((name, i) => ({ id: `t#${i + 1}`, name })) };
  eq(registryProblems({ test: 't', expect: '乙：', regStamp: '4:abc' }, REG), [], '登記表・唯一而且版本對（必過）：沒有問題');
  ok(registryProblems({ test: 't', expect: '甲：', regStamp: '4:abc' }, REG).some((p) => p.startsWith('預期有歧義') && p.includes('t#1、t#2')),
    '登記表・預期有歧義：以 expect 開頭的斷言有 2 條 → 報出來、列出是哪幾條');
  ok(registryProblems({ test: 't', expect: '丁：', regStamp: '4:abc' }, REG).some((p) => p.includes('對不到任何一條')),
    '登記表・對不到：以 expect 開頭的斷言 0 條 → 報出來');
  ok(registryProblems({ test: 't', expect: '乙：', regStamp: '3:old' }, REG).some((p) => p.startsWith('預期需要複審')),
    '登記表・預期需要複審：預期戳的是舊版登記表（母體變了）→ 報出來');
  ok(registryProblems({ test: 't', expect: '乙：', regStamp: '4:abc', alsoRed: ['戊：'] }, REG).some((p) => p.includes('alsoRed「戊：」')),
    '登記表・alsoRed 對不到：報出來');
  // 有表就對表檢查：同一條預期，原始碼裡是唯一的字面開頭（靜態看沒問題），登記表裡卻是 2 條的開頭 → 要報歧義
  const rdOne = (rel) => (rel === 'scripts/t.mjs' ? "ok(a, `甲：${n}`);" : null);
  ok(expectProblems({ test: 't', expect: '甲：', regStamp: '4:abc' }, rdOne, REG).some((p) => p.startsWith('預期有歧義')),
    '登記表・有表就對表檢查：原始碼裡看起來唯一（樣板），登記表裡對到 2 條 → 照登記表報歧義');
}

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
