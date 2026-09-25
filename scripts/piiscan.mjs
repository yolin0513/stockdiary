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
// 判準 (2) 的每一個分支各一個樣本（2026-09-25，補充說明（十一）第 3 點：以前一個樣本只打到 9 個分支裡的 3 個）；
// 判斷與樣本放在模組層，controltest 逐一驗。
// 回傳值：通過 0；黑名單命中、黑名單檔不存在或是空的、任何一道的對照組沒過 → 1。
//
// 2026-09-23 從 Session 的暫存目錄搬進來（原本整支連黑名單都在暫存目錄，每換一次 Session 就沒了）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LIST = path.join(ROOT, '.private', 'pii-blacklist.txt');
// 這幾個目錄不掃：套件、git、log，以及黑名單自己所在的目錄（不然黑名單會抓到自己）
const SKIP_DIRS = new Set(['node_modules', '.git', '.logs', '.private', '.wrangler']);

// 同一段比對程式給真實掃描與對照組共用
export const literalHits = (line, list) => list.filter((lit) => line.includes(lit));
export const SUBJECT = /使用者的|他的|你的|Yolin 的|我的定期定額/;
export const TICKER = /\b00\d{2,4}\b|\b[1-9]\d{3}\b/;
export const MONEY = /\d{1,3}(,\d{3})+\s*元|\d+\s*元(整|起)?/;
export const contextHit = (line) => SUBJECT.test(line) && (TICKER.test(line) || MONEY.test(line));

/**
 * 判準 (2) 的合成對照，**每個分支一個樣本**（拆開拼，這個檔自己才不會被語境判準抓到）。回傳 [{ label, ok }]。
 * 金額的第一個分支（有千分位）被第二個分支（任何數字＋元）包含，拿掉它行為不變——等價，沒有辦法造只打到它的樣本。
 */
export function contextControls() {
  const hit = (label, line) => ({ label, ok: contextHit(line) });
  const miss = (label, line) => ({ label, ok: !contextHit(line) });
  // 每個樣本只有「被測的那個分支」是唯一依靠：指認詞樣本同時帶兩種代號與金額，代號／金額樣本同時帶兩個指認詞——
  // 拿掉一個分支，只有它自己的樣本失手（第一版共用零件，拿掉「使用者的」連代號樣本一起紅）
  const DATA = ' 0050、2330，500 元';
  const TWO = '使用者' + '的、他' + '的';
  return [
    hit('指認詞「使用者的」', '使用者' + '的持股' + DATA),
    hit('指認詞「他的」', '他' + '的持股' + DATA),
    hit('指認詞「你的」', '你' + '的持股' + DATA),
    hit('指認詞「Yolin 的」', 'Yolin ' + '的持股' + DATA),
    hit('指認詞「我的定期定額」', '我的定' + '期定額' + DATA),
    hit('代號 00 開頭', TWO + '持股 0050'),
    hit('代號四位數', TWO + '持股 2330'),
    hit('金額（沒有千分位）', TWO + '預算 500 元'),
    miss('沒有指認詞不算', '證交所公布 2026 年的休市日'),
    miss('有指認詞、沒有代號也沒有金額不算', '使用者' + '的設定頁'),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
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

// 合成對照：一個假的字面、每個語境分支一句假的句子（拆開拼，這個檔自己才不會被語境判準抓到）
const FAKE_LIT = '9,8' + '76,543';
const ctrlLit = literalHits(`總額 ${FAKE_LIT} 元`, [FAKE_LIT]).length;
const ctrlLitMiss = literalHits('總額 1,234 元', [FAKE_LIT]).length;          // 反例：不該命中
const ctx = contextControls();
const ctxOk = ctx.filter((c) => c.ok).length;

const ctrlOk = ctrlLit > 0 && ctrlLitMiss === 0 && ctxOk === ctx.length;
console.log(`第五類：掃 ${files.length} 個檔，黑名單 ${LITERALS.length} 個字面（內容不印）`);
console.log(`判準 (1) 黑名單：對照組 正例 ${ctrlLit}／反例 ${ctrlLitMiss}${ctrlLit > 0 && ctrlLitMiss === 0 ? ' ✔' : ' ✘（比對壞了）'}｜目標命中 ${litHits.length}${litHits.length === 0 ? ' ✔' : ' ✘'}`);
for (const h of litHits) console.log('    ' + h + '（類別：個人財務資料）');
console.log(`判準 (2) 語境樣式：對照組 ${ctxOk}/${ctx.length}${ctxOk === ctx.length ? ' ✔' : ` ✘（比對壞了：${ctx.filter((c) => !c.ok).map((c) => c.label).join('、')}）`}｜候選 ${ctxHits.length} 行（要人看一眼，不擋）`);
if (process.argv.includes('--show-candidates')) for (const h of ctxHits) console.log('    ' + h);

const bad = !ctrlOk || litHits.length > 0;
console.log(bad ? '第五類：未通過' : '第五類：通過（語境候選請人工看過：加 --show-candidates 列出來）');
process.exit(bad ? 1 : 0);
}
