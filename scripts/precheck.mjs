// 公開前自查：四類（本 repo 是 public）。由 scripts/gatepush.sh 在推送前呼叫，也可以自己跑：
//   node scripts/precheck.mjs [rev|範圍]      （預設 HEAD；閘門給的是 `<遠端 main>..HEAD`，也就是這次要推的全部 commit）
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
const META_FMT = '%B%n作者：%an <%ae>%n提交者：%cn <%ce>';

/**
 * 取這次每個 commit 的訊息、作者、提交者（每一行前面加「+」，跟新增行走同一套搜尋式）。
 * git：執行 git 的函式（參數陣列 → 輸出字串，失敗就丟例外）——當參數傳進來，測試才能只讓其中一個子指令失敗（F10 第 1b 點）。
 * **有 commit 卻取不到作者欄與提交者欄，就是檢查器壞了**（2026-09-24，MealMate 與統籌者各中一次同一個位置）：
 * 以前這裡取到空的就當成「0 行、0 命中」通過，姓名與信箱那道防線無聲失效。現在拿 rev-list 數出的 commit 數核對：
 * 作者欄、提交者欄各要剛好那麼多行；git 本身失敗也講明，不丟給外層當成崩潰。
 * 回傳 { lines, problem }；problem 不是 null 就要擋。
 */
export function commitMeta(git, rev) {
  const range = rev.includes('..') ? [rev] : ['-1', rev];
  let count;
  let raw;
  try {
    count = Number(git(['rev-list', '--count', ...range]).trim());
    raw = git(['log', `--format=${META_FMT}`, ...range]);
  } catch (e) {
    return { lines: [], problem: `取不到 commit 數或訊息與作者欄（git 失敗：${String(e?.message ?? e).split('\n')[0]}）` };
  }
  if (!Number.isInteger(count)) return { lines: [], problem: '算不出這次有幾個 commit' };
  const lines = raw.split('\n').filter((l) => l.trim() !== '').map((l) => '+' + l);
  const authors = lines.filter((l) => l.startsWith('+作者：')).length;
  const committers = lines.filter((l) => l.startsWith('+提交者：')).length;
  if (authors !== count || committers !== count) {
    return { lines, problem: `有 ${count} 個 commit，卻取到 ${authors} 個作者欄、${committers} 個提交者欄` };
  }
  return { lines, problem: null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
const rev = process.argv[2] || 'HEAD';

// 單一 commit（`HEAD`）或一段範圍（`<遠端>..HEAD`，閘門給的），都用 git log **逐個 commit** 取新增行 ——
// 用 git diff 比兩端的話，中間某個 commit 加了又刪掉的行會漏掉，但它照樣會被推上去。
// 兩種數法（-p 與 --numstat）用同一組範圍與同一組 diff 選項，行數才對得起來。
const SCOPE = rev.includes('..') ? [rev] : ['-1', rev];
const DIFF_OPTS = ['--no-renames', '--no-ext-diff', '--no-color'];
const raw = execFileSync('git', ['-C', ROOT, 'log', '-p', '--format=', '--unified=0', ...DIFF_OPTS, ...SCOPE], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

// **照 diff 的結構抽新增行**：只有 `@@` 之後、以 `+` 開頭的行才是內容；`diff --git` 開始新的檔頭。
// 2026-09-24 以前是「以 + 開頭、但不是 +++」：內容本身以 `++` 開頭的行，加上 diff 前面的 `+` 就變成 `+++…`，
// 被當成檔頭默默丟掉——實測一行 `++ ` 開頭、帶合成 token 的新增行，自查回傳 0。
function extractAdded(text) {
  const out = [];
  let inHunk = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk && l.startsWith('+')) out.push(l);
  }
  return out;
}
const addedLines = extractAdded(raw);

// **核對**：抽出來的行數必須等於 git 自己算的新增行數（--numstat，獨立的來源；二進位檔記成 `-`，不算）。
// 對不上就停：抽取寫錯、換了環境（git 版本、設定）讓抽取變少，都會在這裡被接住——
// 包括「抽出 0 行」這種故障（以前 0 行照樣放行）。只刪不增的正常推送兩邊都是 0，不會被擋。
const numstat = execFileSync('git', ['-C', ROOT, 'log', '--numstat', '--format=', ...DIFF_OPTS, ...SCOPE], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const gitAdded = numstat.split('\n').reduce((sum, l) => {
  const m = /^(\d+)\t/.exec(l);
  return m ? sum + Number(m[1]) : sum;
}, 0);
if (addedLines.length !== gitAdded) {
  console.log(`四類自查：${rev}，抽出 ${addedLines.length} 行、git 算 ${gitAdded} 行（抽取壞了）—— 擋下`);
  process.exit(1);
}

// commit 訊息、作者與提交者的名字與信箱也會公開（共用慣例 v8 §2.5「自查的範圍」）。
// 2026-09-24 以前只掃新增行：一個把合成 token 放在 commit 訊息裡的 commit，自查回傳 0（實測）。
// 每一行前面加「+」，跟新增行走同一套搜尋式；另外記住它是哪一種，命中時講得出來源。
const meta = commitMeta((args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), rev);
if (meta.problem) {
  console.log(`四類自查：${rev}，${meta.problem}（檢查器壞了）—— 擋下`);
  process.exit(1);
}
const metaLines = meta.lines;
const SOURCE = new Map([...addedLines.map((l) => [l, '新增行']), ...metaLines.map((l) => [l, 'commit 訊息／作者'])]);
const added = [...addedLines, ...metaLines];

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
console.log(`四類自查：${rev}，新增行 ${addedLines.length} 行＋commit 訊息與作者 ${metaLines.length} 行`);
for (const [name, ctrl, hits] of rows) {
  const ctrlOk = ctrl > 0;
  if (!ctrlOk || hits.length > 0) bad += 1;
  console.log(`${name}：對照組命中 ${ctrl}${ctrlOk ? ' ✔' : ' ✘（搜尋式壞了）'}｜目標命中 ${hits.length}${hits.length === 0 ? ' ✔' : ' ✘'}`);
  // (c) 類命中時不印內容（會把使用者名稱印出來）
  if (name.startsWith('(c)')) continue;
  for (const h of hits.slice(0, 5)) console.log(`    [${SOURCE.get(h) ?? '新增行'}] ${h.slice(0, 120)}`);
}
const falsePos = hitsIn(PATHS_MISS, PATHS);
if (falsePos.length) { bad += 1; console.log(`(d) 反例被誤抓：${falsePos.join('、')}`); }
else console.log('(d) 反例（file:///、find:/gm、https://）都沒被誤抓 ✔');

// 第二道（只印不判）：repo 裡的真實檔案。它會隨時間變，所以不能單獨當對照組（v6 §5.3）
const second = ['CLAUDE.md', 'docs/STATUS.md'].map((f) => `${f} ${hitsIn(readFileSync(path.join(ROOT, f), 'utf8').split('\n'), PATHS).length} 處`);
console.log(`(d) 第二道（真實檔案，只印不判）：${second.join('、')}`);

console.log(bad === 0 ? '四類自查：通過' : '四類自查：未通過');
process.exit(bad === 0 ? 0 : 1);
}
