// F9：三支 build 的驗法登記（2026-09-24，統籌者新訂，四家統一）。
//
//   node scripts/buildverify.mjs                       跑 buildtest；全部擋下才登記（寫 .logs/build-verified.txt，不進版控）
//   node scripts/buildverify.mjs --check <範圍> <ref>  推送閘門呼叫：這次要推的 commit 動到被守的檔，登記就要對得上 <ref> 那一版
//
// 為什麼：F8 的驗法（buildtest 的 54 格矩陣）以前靠人記得「改過 build 就重跑」。改成跟閘門第零關一樣的登記制：
// 驗法全部擋下時登記被守的檔的雜湊；推送前比對，對不上就擋（gatepush.sh 回 5）。
//
// 三件一定要守的事（另外兩家各缺過一件）：
//   1. **登記的是 HEAD 那一版**：驗法跑的是工作區的檔，登記寫的是 HEAD 的雜湊。工作區有改動還照樣登記，
//      等於把「從沒被驗過的 HEAD」登記成驗過（JLPT 缺這一條，拿掉那段邏輯 19 種情境照樣全過）。
//      所以登記前先比對工作區＝HEAD，不一樣就不登記；而且**一開跑就刪掉舊登記**，沒走到最後就沒有登記。
//   2. **沒動到被守的檔就不看登記**：不是每次推送都要跑 buildtest。
//   3. **逐個 commit 看有沒有動到**：前一個 commit 動到、最後一個乾淨，照樣要比對（MealMate 補的；只看最後一個會漏）。
//
// 被守的檔用**登記制**：下面這張表。另外檢查 build 腳本與驗法 import 到的每一個本地檔都在表上（漏了就不登記），
// 表上的檔也都要存在——不靠人記得「新增相依要加進來」。
// 這支檔本身在推送閘門第零關的登記清單裡（改了它要重跑 bash scripts/gatetest.sh）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const GUARDED = [
  'scripts/build-calendar.mjs', 'scripts/build-dividends.mjs', 'scripts/build-stocks.mjs',
  'scripts/buildguard.mjs', 'scripts/testfetch.mjs', 'scripts/buildtest.mjs', 'scripts/tap.mjs',
  'js/roc.js', 'js/twse.js',
];
const ENTRY = ['scripts/build-calendar.mjs', 'scripts/build-dividends.mjs', 'scripts/build-stocks.mjs', 'scripts/buildtest.mjs'];
const REG = path.join(ROOT, '.logs', 'build-verified.txt');

const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const say = (s) => process.stdout.write(`${s}\n`);

/** 從入口一路追本地 import（'./x' 與 '../x'），加上 buildtest 的 SCRIPTS 表（它們是另開程序跑的，不是 import）。 */
export function localDeps(root = ROOT) {
  const seen = new Set();
  const todo = [...ENTRY];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*import[^'"\n]*?['"](\.{1,2}\/[^'"]+)['"]/g)) {
      todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
    if (rel === 'scripts/buildtest.mjs') {
      const t = /const SCRIPTS = \[([^\]]*)\]/.exec(src);
      if (!t) throw new Error('buildtest.mjs 裡找不到 SCRIPTS 表（另開程序跑的檔從那裡讀）');
      for (const m of t[1].matchAll(/'([^']+)'/g)) todo.push(`scripts/${m[1]}`);
    }
  }
  return [...seen].sort();
}

function register() {
  fs.mkdirSync(path.dirname(REG), { recursive: true });
  fs.rmSync(REG, { force: true });   // 一開跑就刪：沒走到最後，就不能留著上一次的登記
  const stop = (why) => { say(`【不登記】${why}`); say('build 驗法登記：沒有寫入（推送閘門遇到動了 build 的 commit 會回 5）'); process.exit(1); };

  const missing = GUARDED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) stop(`登記清單上的檔不存在：${missing.join('、')}`);
  let deps;
  try { deps = localDeps(); } catch (e) { stop(`追不出相依：${e.message}`); }
  const orphan = deps.filter((f) => !GUARDED.includes(f));
  if (orphan.length) stop(`build 或驗法用到、卻不在登記清單上的檔：${orphan.join('、')}（加進 GUARDED）`);

  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) stop('讀不到 HEAD');
  const headHashes = () => {
    const bad = [];
    const out = {};
    for (const f of GUARDED) {
      const want = git('rev-parse', `HEAD:${f}`);
      const have = git('hash-object', path.join(ROOT, f));
      if (want.status !== 0 || have.status !== 0 || want.stdout.trim() !== have.stdout.trim()) bad.push(f);
      else out[f] = want.stdout.trim();
    }
    return { bad, out };
  };
  const before = headHashes();
  if (before.bad.length) stop(`工作區跟 HEAD 不一樣：${before.bad.join('、')}——登記的是 HEAD 那一版，驗法跑的卻是工作區，先 commit 或還原再跑`);

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'buildtest.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);
  if (r.status !== 0) stop(`驗法沒過（buildtest 回傳 ${r.status}）`);
  // 總計那一行由 buildtest 的 note 印出（行首「  · 矩陣共」）；只認這個位置，找不到當成沒過
  const m = /^ {2}· 矩陣共 (\d+) 格：擋 (\d+)、碰巧擋下 (\d+)、沒擋 (\d+)$/m.exec(out.replace(/\r/g, ''));
  if (!m) stop('驗法的輸出裡找不到矩陣總計那一行（算不出擋了幾格，不當成全擋）');
  const [total, blocked] = [Number(m[1]), Number(m[2])];
  if (!(total > 0 && blocked === total)) stop(`驗法沒有全部擋下：矩陣共 ${total} 格，擋 ${blocked}`);

  const after = headHashes();
  if (after.bad.length) stop(`驗法跑的期間，工作區的檔變了：${after.bad.join('、')}`);
  fs.writeFileSync(REG, `commit ${head.stdout.trim()}\n${GUARDED.map((f) => `${f} ${after.out[f]}`).join('\n')}\n`);
  say(`build 驗法登記：已寫入 .logs/build-verified.txt（矩陣 ${total} 格全擋；${GUARDED.length} 支檔的 HEAD 版本）`);
}

function check(range, ref) {
  const stop = (why) => { say(`【F9 擋下】${why}`); process.exit(1); };
  if (!range || !ref) stop('用法：--check <範圍> <ref>');
  // 逐個 commit 列出動到的檔（不是只比兩端：中間動過又改回來的也算動過）
  const log = git('log', '--no-renames', '--name-only', '--format=commit %H', range);
  const count = git('rev-list', '--count', range);
  if (log.status !== 0 || count.status !== 0) stop(`算不出這次要推哪些 commit 動到了哪些檔（${range}）`);
  const lines = log.stdout.split('\n');
  const commits = lines.filter((l) => l.startsWith('commit ')).length;
  if (commits !== Number(count.stdout.trim())) stop(`讀到的 commit 數 ${commits} 跟 rev-list 的 ${count.stdout.trim()} 對不上，檢查器壞了`);
  const touched = [...new Set(lines.filter((l) => GUARDED.includes(l)))];
  if (!touched.length) { say(`F9：這次要推的 ${commits} 個 commit 沒動到 build 與它的驗法，不看登記`); return; }
  if (!fs.existsSync(REG)) stop(`這次要推的 commit 動到 ${touched.join('、')}，但沒有 build 驗法登記——先跑 node scripts/buildverify.mjs`);
  const reg = Object.fromEntries(fs.readFileSync(REG, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')));
  const bad = GUARDED.filter((f) => {
    const have = git('rev-parse', `${ref}:${f}`);
    return have.status !== 0 || reg[f] !== have.stdout.trim();
  });
  if (bad.length) stop(`build 驗法登記跟要推的版本對不上：${bad.join('、')}（這次動到 ${touched.join('、')}）——先跑 node scripts/buildverify.mjs`);
  say(`F9：這次要推的 commit 動到 ${touched.join('、')}，build 驗法登記相符`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--check') check(a[1], a[2]);
  else register();
}
