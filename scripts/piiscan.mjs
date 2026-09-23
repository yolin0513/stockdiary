// 公開前自查：第五類「個人財務資料」（本 repo 是 public）。由 scripts/gatepush.sh 在推送前呼叫，也可以自己跑：
//   node scripts/piiscan.mjs
//
// 掃整個工作目錄（不只這次的新增行）。兩道判準，因為數字本身長得跟任何數字一樣，單靠樣式一定爆量誤報：
//   (1) 黑名單：已經確認是 Yolin 個人財務資料的**字面**。命中就擋（回傳 1）。
//   (2) 語境樣式：同一行有指認詞（他的／你的／使用者的）又有代號或金額 —— 只列給人看，不擋。
//
// **規則在這裡、資料不在這裡**：黑名單本身就是個資的字面，所以放在 `.private/pii-blacklist.txt`
// （已在 .gitignore，不進 repo）。一行一個字面，`#` 開頭是註解。新發現的個資字面要往那個檔加。
// 檔案不存在或是空的 → **擋下**（回傳 1）並講怎麼產生，不要靜默跳過這一類。產生方式見 docs/STATUS.md「推送閘門」。
//
// 對照組（共用慣例 v6 §5.3）：兩道判準都用**當場造的合成樣本**跑同一段比對程式 ——
// 不拿黑名單裡的真實字面當對照（以前是這樣，那會隨黑名單內容變）。
// 回傳值：通過 0；黑名單命中、黑名單檔不存在或是空的、任何一道的對照組沒命中 → 1。
//
// 2026-09-23 從 Session 的暫存目錄搬進來（原本整支連黑名單都在暫存目錄，每換一次 Session 就沒了）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LIST = path.join(ROOT, '.private', 'pii-blacklist.txt');
// 這幾個目錄不掃：套件、git、log，以及黑名單自己所在的目錄（不然黑名單會抓到自己）
const SKIP_DIRS = new Set(['node_modules', '.git', '.logs', '.private', '.wrangler']);

if (!existsSync(LIST)) {
  console.log('第五類：找不到黑名單檔 .private/pii-blacklist.txt —— 擋下。');
  console.log('  它刻意不進 repo（內容就是個資字面）。怎麼產生：docs/STATUS.md「推送閘門」那一節。');
  process.exit(1);
}
const LITERALS = readFileSync(LIST, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
if (LITERALS.length === 0) {
  console.log('第五類：黑名單檔是空的 —— 擋下（空的黑名單等於這一類什麼都沒查）。');
  process.exit(1);
}

// 同一段比對程式給真實掃描與對照組共用
const literalHits = (line, list) => list.filter((lit) => line.includes(lit));
const SUBJECT = /使用者的|他的|你的|Yolin 的|我的定期定額/;
const TICKER = /\b00\d{2,4}\b|\b[1-9]\d{3}\b/;
const MONEY = /\d{1,3}(,\d{3})+\s*元|\d+\s*元(整|起)?/;
const contextHit = (line) => SUBJECT.test(line) && (TICKER.test(line) || MONEY.test(line));

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(md|mjs|js|json|html|css|txt|sh)$/.test(name)) out.push(p);
  }
  return out;
};

const files = walk(ROOT);
const litHits = [];
const ctxHits = [];
for (const f of files) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const where = `${path.relative(ROOT, f).split(path.sep).join('/')}:${i + 1}`;
    // 命中時**不印字面**：印出來就等於把個資貼進終端機與回報裡（附錄 A：查到的結果只寫檔名、行號、類別）
    if (literalHits(line, LITERALS).length) litHits.push(where);
    if (contextHit(line)) ctxHits.push(`${where}  ${line.trim().slice(0, 90)}`);
  });
}

// 合成對照：一個假的字面、一行假的句子（拆開拼，這個檔自己才不會被語境判準抓到）
const FAKE_LIT = '9,8' + '76,543';
const ctrlLit = literalHits(`總額 ${FAKE_LIT} 元`, [FAKE_LIT]).length;
const ctrlLitMiss = literalHits('總額 1,234 元', [FAKE_LIT]).length;          // 反例：不該命中
const ctrlCtx = contextHit('使用者' + '的計畫是 0000 與 0001，每次 9,999 元') ? 1 : 0;
const ctrlCtxMiss = contextHit('證交所公布 2026 年的休市日') ? 1 : 0;       // 反例：沒有指認詞

const ctrlOk = ctrlLit > 0 && ctrlLitMiss === 0 && ctrlCtx > 0 && ctrlCtxMiss === 0;
console.log(`第五類：掃 ${files.length} 個檔，黑名單 ${LITERALS.length} 個字面（內容不印）`);
console.log(`判準 (1) 黑名單：對照組 正例 ${ctrlLit}／反例 ${ctrlLitMiss}${ctrlLit > 0 && ctrlLitMiss === 0 ? ' ✔' : ' ✘（比對壞了）'}｜目標命中 ${litHits.length}${litHits.length === 0 ? ' ✔' : ' ✘'}`);
for (const h of litHits) console.log('    ' + h + '（類別：個人財務資料）');
console.log(`判準 (2) 語境樣式：對照組 正例 ${ctrlCtx}／反例 ${ctrlCtxMiss}${ctrlCtx > 0 && ctrlCtxMiss === 0 ? ' ✔' : ' ✘（比對壞了）'}｜候選 ${ctxHits.length} 行（要人看一眼，不擋）`);
if (process.argv.includes('--show-candidates')) for (const h of ctxHits) console.log('    ' + h);

const bad = !ctrlOk || litHits.length > 0;
console.log(bad ? '第五類：未通過' : '第五類：通過（語境候選請人工看過：加 --show-candidates 列出來）');
process.exit(bad ? 1 : 0);
