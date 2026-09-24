// 推送閘門驗法的自我測試（npm run gateselftest；約 8 分鐘，不在 npm test 裡）。
//
// 為什麼（2026-09-24，統籌者驗收 S7 指出）：S7 的第零關（驗法登記）有兩個洞沒有東西守——
//   · 沒有任何 S7 的突變：統籌者補跑「登記的雜湊對不上時不擋」，只有情境 10 紅，而且那個 commit 真的推了出去
//   · 沒有「驗法沒全過要刪掉登記」的情境：驗法失敗卻留著上一次的登記，閘門照樣放行
// 做法：在暫存複本裡把閘門或驗法改壞一處並 commit（gatetest.sh 驗的是已 commit 的內容），跑 gatetest.sh，
// **逐行解析**每一種情境的結論，比對「不符的那幾種」**剛好等於**預期（多一種、少一種都算不符）；
// 另外看驗法跑完登記檔在不在、跑到的是不是改壞的那一份（比雜湊）。
//
// 解析結論時**斷言剛好是 ALL 那幾種**（現在 21 種；2026-09-24 F9 的六種必備情境是 13–18）：用 grep 抽 ✓／✗ 這種多位元組字元，語系不對時兩邊都抽到 0 種，
// 「兩邊相同」在母體是空的時候恆真（本 App 與統籌者各踩過一次）。
//
// 用法：node scripts/gateselftest.mjs      回傳 0＝每一種變體的結果都跟預期一樣
// 驗法本身的突變（V1 一開跑不刪舊登記、V2 沒全過也寫登記）登記在 mutationtest，指向這一支：
// 它們一改壞，下面「驗法沒全過，先放的舊登記要被刪掉」那一條就紅。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, note } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ALL = ['1', '1b', '2a', '2b', '2c', '3', '4', '6', '7', '7b', '8', '9', '10', '11', '13', '14', '15', '16', '17', '18', '5'];
const REVERSED = [...ALL].reverse();
const STALE_REG = 'scripts/gatepush.sh 0000000000000000000000000000000000000000\n';

/**
 * 從 gatetest.sh 的輸出解析每一種情境的結論：{ id → 'ok'｜'bad' }。
 * 只認「兩格縮排＋✓ 或 ✗＋空白＋情境編號＋句點」開頭的行；逐行看，不靠 grep 的字元類別。
 */
export function parseVerdicts(out) {
  const v = {};
  for (const line of String(out).split('\n')) {
    const m = /^ {2}(✓|✗) (\d+[a-e]?)\. /.exec(line.replace(/\r$/, ''));
    if (m) v[m[2]] = m[1] === '✓' ? 'ok' : 'bad';
  }
  return v;
}

// 解析程式本身的對照（§5.11 第二層）：已知的輸出要抽到該抽的；（對照）那一行、縮排不對的不能算
{
  const sample = [
    '  ✓ （對照）比對擋下原因的那段程式：…',
    '  ✓ 1. 自查命中（HEAD 帶合成 token）：回傳 1（預期 1）',
    '  ✗ 10. 閘門改過、沒重跑驗法：回傳 0（預期 4）',
    '  ✓ 2c. 某一種情境：回傳 1',
    '  ✗ 12d. 帶字尾 d 的情境：回傳 5',
    '  ✓ 12f. 字尾超出 a–e 的不算',
    '    ✓ 3. 縮排不對的不算',
  ].join('\n');
  const got = parseVerdicts(sample);
  eq(got, { 1: 'ok', 10: 'bad', '2c': 'ok', '12d': 'bad' }, '（對照）解析驗法結論的程式：只抽情境那幾行，抽得到 ✓ 與 ✗');
  eq(parseVerdicts(''), {}, '（對照）空的輸出抽到 0 種（下面每一次都另外斷言剛好是 ALL 那幾種）');
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gateselftest-'));
const W = path.join(T, 'w');
const git = (...args) => execFileSync('git', ['-C', W, ...args], { encoding: 'utf8' }).trim();
execFileSync('git', ['clone', '-q', '--no-local', ROOT, W]);
git('config', 'user.name', execFileSync('git', ['-C', ROOT, 'config', 'user.name'], { encoding: 'utf8' }).trim());
git('config', 'user.email', execFileSync('git', ['-C', ROOT, 'config', 'user.email'], { encoding: 'utf8' }).trim());
// 用 repo **工作區**的六支閘門檔（不是已 commit 的）：mutationtest 改壞工作區的檔時，這裡才看得到。
// gatetest.sh 驗的是已 commit 的內容，所以在複本裡把它們 commit 成這一輪的起點。
for (const f of ['scripts/gatepush.sh', 'scripts/gatetest.sh', 'scripts/precheck.mjs', 'scripts/piiscan.mjs', 'scripts/gatereason.mjs', 'scripts/buildverify.mjs']) fs.copyFileSync(path.join(ROOT, f), path.join(W, f));
if (git('status', '--porcelain')) git('commit', '-q', '-am', 'gateselftest：工作區的閘門檔');
const BASE = git('rev-parse', 'HEAD');
const REG = path.join(W, '.logs', 'gate-verified.txt');

/** 改一處（錨點要剛好一次，改完內容要真的變了），回傳改完的內容。 */
function patch(rel, find, replace) {
  const f = path.join(W, rel);
  const s = fs.readFileSync(f, 'utf8');
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`${rel}：錨點出現 ${n} 次（要剛好 1 次）：${find.slice(0, 60)}`);
  const t = s.split(find).join(replace);
  if (t === s) throw new Error(`${rel}：改了等於沒改`);
  fs.writeFileSync(f, t);
}

/**
 * 跑一種變體：還原 → 改壞（patches）→ commit → 先放一份舊登記 → 跑 gatetest.sh → 解析。
 * expectBad：預期不符的情境（剛好這幾種）；expectReg：跑完登記檔應該在（true）或不在（false）。
 */
function variant(name, patches, { expectBad, expectReg, order = ALL }) {
  git('reset', '-q', '--hard', BASE);
  for (const [rel, find, replace] of patches) patch(rel, find, replace);
  if (patches.length) git('commit', '-q', '-am', `gateselftest：${name}`);
  const gateHash = git('hash-object', 'scripts/gatepush.sh');
  fs.mkdirSync(path.dirname(REG), { recursive: true });
  fs.writeFileSync(REG, STALE_REG);
  const seeded = fs.existsSync(REG) && fs.readFileSync(REG, 'utf8') === STALE_REG;
  const r = spawnSync('bash', ['scripts/gatetest.sh'], { cwd: W, encoding: 'utf8', env: { ...process.env, GATETEST_ORDER: order.join(' ') }, timeout: 600000 });
  const out = `${r.stdout}${r.stderr}`;
  const v = parseVerdicts(out);
  const ran = /被執行的閘門檔案雜湊：([0-9a-f]+)/.exec(out)?.[1];
  const bad = Object.keys(v).filter((k) => v[k] === 'bad').sort();
  const regNow = fs.existsSync(REG) ? fs.readFileSync(REG, 'utf8') : null;
  section(`變體：${name}`);
  ok(seeded, `（前提）${name}：跑之前先放了一份舊的登記檔`);
  eq(Object.keys(v).sort(), [...ALL].sort(), `（前提）${name}：解析到剛好 ${ALL.length} 種情境的結論`);
  eq(ran, gateHash, `（前提）${name}：驗法跑到的閘門＝改過的那一份（雜湊）`);
  eq(bad, [...expectBad].sort(), `${name}：不符的情境剛好是 ${expectBad.length ? expectBad.join('、') : '（沒有）'}`);
  if (expectReg) {
    ok(regNow != null && regNow !== STALE_REG && regNow.includes('scripts/gatepush.sh '), `${name}：全部符合，登記換成這一次的（不是先放的舊登記）`, `登記：${JSON.stringify(regNow)}`);
  } else {
    ok(regNow == null, `${name}：驗法沒全過，先放的舊登記要被刪掉`, `登記還在：${JSON.stringify(regNow)}`);
  }
  eq(r.status, expectBad.length ? 1 : 0, `${name}：gatetest.sh 的回傳值`);
  return v;
}

try {
  const base = variant('原樣（對照）', [], { expectBad: [], expectReg: true });
  const rev = variant('原樣、倒過來的順序', [], { expectBad: [], expectReg: true, order: REVERSED });
  eq(ALL.map((k) => rev[k]), ALL.map((k) => base[k]), `換順序（§5.11 第四層）：${ALL.length} 種的結論逐一相同（兩邊都已斷言剛好 ${ALL.length} 種）`);

  // ---- 閘門第零關的突變 ----
  variant('突變 G1：拿掉整個第零關', [
    ['scripts/gatepush.sh', 'if [ -s "$REG" ]; then', 'if false; then'],
    ['scripts/gatepush.sh', '  echo "【第零關擋下】沒有驗法登記', '  : echo "【第零關擋下】沒有驗法登記'],
    ['scripts/gatepush.sh', '先跑 bash scripts/gatetest.sh"\n  exit 4\nfi\n\nLOCAL=', '先跑 bash scripts/gatetest.sh"\nfi\n\nLOCAL='],
  ], { expectBad: ['10', '11'], expectReg: false });
  variant('突變 G2：登記的雜湊對不上時不擋（統籌者補跑的那一種）', [
    ['scripts/gatepush.sh', '  if [ -n "$REG_BAD" ]; then', '  if false; then'],
  ], { expectBad: ['10'], expectReg: false });
  variant('突變 G3：沒有登記檔時不擋', [
    ['scripts/gatepush.sh', '  echo "【第零關擋下】沒有驗法登記', '  : echo "【第零關擋下】沒有驗法登記'],
    ['scripts/gatepush.sh', '先跑 bash scripts/gatetest.sh"\n  exit 4\nfi\n\nLOCAL=', '先跑 bash scripts/gatetest.sh"\nfi\n\nLOCAL='],
  ], { expectBad: ['11'], expectReg: false });

  // ---- F9：六種必備情境（13＝第 1 條 … 18＝第 6 條），每一種一條只紅它的突變（G5–G10）；G4 是閘門整個不理 F9 ----
  variant('突變 G4：F9 比對沒過也照樣往下推', [
    ['scripts/gatepush.sh', 'if [ "$V" -ne 0 ]; then', 'if false; then'],
  ], { expectBad: ['13', '15', '16', '18'], expectReg: false });
  variant('突變 G5（第 2 條）：F9 比的是工作區、不是要推的已 commit 版本', [
    ['scripts/buildverify.mjs', "    const have = git('rev-parse', `${ref}:${f}`);", "    const have = git('hash-object', path.join(ROOT, f));"],
  ], { expectBad: ['14'], expectReg: false });
  variant('突變 G6（第 6 條）：F9 只看最後一個 commit 有沒有動到', [
    ['scripts/buildverify.mjs', '  const touched = [...new Set(lines.filter((l) => GUARDED.includes(l)))];',
      "  const touched = [...new Set(lines.slice(0, lines.findIndex((l, i) => i > 0 && l.startsWith('commit ')) + 1 || lines.length).filter((l) => GUARDED.includes(l)))];"],
  ], { expectBad: ['18'], expectReg: false });
  variant('突變 G7（第 1 條）：有登記就放行、不比雜湊', [
    ['scripts/buildverify.mjs', '    return have.status !== 0 || reg[f] !== have.stdout.trim();', '    return false;'],
  ], { expectBad: ['13'], expectReg: false });
  variant('突變 G8（第 3 條）：驗法一開跑不刪舊登記', [
    ['scripts/buildverify.mjs', '  fs.rmSync(REG, { force: true });   // 一開跑就刪', '  // 突變：不刪舊登記'],
  ], { expectBad: ['15'], expectReg: false });
  variant('突變 G9（第 4 條）：算不出工作區有改動（一律當成跟 HEAD 一樣）', [
    ['scripts/buildverify.mjs', '      if (want.status !== 0 || have.status !== 0 || want.stdout.trim() !== have.stdout.trim()) bad.push(f);', '      if (want.status !== 0) bad.push(f);'],
  ], { expectBad: ['16'], expectReg: false });
  variant('突變 G10（第 5 條）：沒動到被守的檔也要有登記檔', [
    ['scripts/buildverify.mjs', '  if (!touched.length) { say(', '  if (!touched.length && fs.existsSync(REG)) { say('],
  ], { expectBad: ['17'], expectReg: false });

} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done('gateselftest');
