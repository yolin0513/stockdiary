// 公開前自查：四類（本 repo 是 public）。由 scripts/gatepush.sh 在推送前呼叫，也可以自己跑：
//   node scripts/precheck.mjs [rev]      （預設 HEAD）
//
// 查的是這次 commit 的**新增行**：(a) 金鑰／token、(b) email（GitHub 與 Anthropic 的 noreply 不算）、
// (c) 本機使用者名稱、(d) 磁碟機代號與家目錄路徑。第五類（個人財務資料）在 scripts/piiscan.mjs。
//
// 每一類都先跑**當場組出來的合成對照樣本**（共用慣例 v6 §5.3）：對照組沒命中＝搜尋式壞了，那一類不算過。
// 本機使用者名稱從環境變數取，**不寫進這個檔、也不印出來**。
// 回傳值：全部通過 0；任何一類有命中、或任何一類的對照組沒命中 → 1。
//
// 2026-09-23 從 Session 的暫存目錄搬進來：閘門跟著 Session 生死的話，每換一次 Session 就有一段沒有閘門的空窗。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const rev = process.argv[2] || 'HEAD';

const raw = execFileSync('git', ['-C', ROOT, 'show', rev, '--format=', '--unified=0'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const added = raw.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

const USER = process.env.USERNAME || process.env.USER || '';
if (!USER) {
  console.error('拿不到本機使用者名稱（環境變數 USERNAME／USER），(c) 類無法自查 —— 擋下');
  process.exit(1);
}

const TOKEN = /gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_OK = /(users\.)?noreply@(anthropic\.com|github\.com)|@users\.noreply\.github\.com/;
const USERNAME = new RegExp(USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
// 磁碟機代號前面不能接英文字母：不然 `file:///` 與正規式 `find:/gm` 裡「字母＋冒號＋斜線」那一段都會被當成路徑
const PATHS = /(?<![A-Za-z])[A-Za-z]:[\\/]|\/(home|Users)\/[A-Za-z0-9._\u4e00-\u9fff-]+/;
const PATHS_MISS = ['+file:///x.mjs', '+match(/^\\s+find:/gm)', '+https://example.com/a'];

const hitsIn = (lines, re, skip) => lines.filter((l) => re.test(l) && !(skip && skip.test(l)));

// 合成對照樣本：拆開拼，這個檔自己才不會被自己抓到
const CTRL = {
  a: ['+' + 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0KLMN'],
  b: ['+' + 'someone' + '@' + 'example' + '.com'],
  c: ['+' + 'C' + ':/Users/' + USER + '/somewhere'],
  d: ['+' + 'X' + ':' + '\\' + 'Work' + '\\' + 'proj', '+' + '/home/' + 'someone' + '/x'],
};

const rows = [
  ['(a) 金鑰／token', hitsIn(CTRL.a, TOKEN).length, hitsIn(added, TOKEN)],
  ['(b) email（noreply 不算）', hitsIn(CTRL.b, EMAIL, EMAIL_OK).length, hitsIn(added, EMAIL, EMAIL_OK)],
  ['(c) 本機使用者名稱', hitsIn(CTRL.c, USERNAME).length, hitsIn(added, USERNAME)],
  ['(d) 磁碟機／家目錄路徑', hitsIn(CTRL.d, PATHS).length, hitsIn(added, PATHS)],
];

let bad = 0;
console.log(`四類自查：${rev}，新增行 ${added.length} 行`);
for (const [name, ctrl, hits] of rows) {
  const ctrlOk = ctrl > 0;
  if (!ctrlOk || hits.length > 0) bad += 1;
  console.log(`${name}：對照組命中 ${ctrl}${ctrlOk ? ' ✔' : ' ✘（搜尋式壞了）'}｜目標命中 ${hits.length}${hits.length === 0 ? ' ✔' : ' ✘'}`);
  // (c) 類命中時不印內容（會把使用者名稱印出來）
  if (name.startsWith('(c)')) continue;
  for (const h of hits.slice(0, 5)) console.log('    ' + h.slice(0, 120));
}
const falsePos = hitsIn(PATHS_MISS, PATHS);
if (falsePos.length) { bad += 1; console.log(`(d) 反例被誤抓：${falsePos.join('、')}`); }
else console.log('(d) 反例（file:///、find:/gm、https://）都沒被誤抓 ✔');

// 第二道（只印不判）：repo 裡的真實檔案。它會隨時間變，所以不能單獨當對照組（v6 §5.3）
const second = ['CLAUDE.md', 'docs/STATUS.md'].map((f) => `${f} ${hitsIn(readFileSync(path.join(ROOT, f), 'utf8').split('\n'), PATHS).length} 處`);
console.log(`(d) 第二道（真實檔案，只印不判）：${second.join('、')}`);

console.log(bad === 0 ? '四類自查：通過' : '四類自查：未通過');
process.exit(bad === 0 ? 0 : 1);
