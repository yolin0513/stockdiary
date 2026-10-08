// 用腳本改文件，寫回之前先擋兩件（共用慣例 §6.5，2026-10-08 落實）：
//   · 行數只准變多（真的要刪，呼叫端明講 allowShrink）
//   · 原本的章節標題（行首 # 開頭的那幾行）都要還在
// 為什麼：一次性的改文件腳本漏接後半份內容時，寫回去就把文件截掉了，而且不會有任何測試紅。
// 以後改 docs/ 的一次性腳本一律經 guardedWrite 寫回（以前只查「錨點剛好一次」，截斷與標題消失查不到）。
// scripts/docguardtest.mjs 驗（npm test 鏈）。

import fs from 'node:fs';

const linesOf = (t) => String(t).replace(/\r\n/g, '\n').split('\n');
const headingsOf = (t) => linesOf(t).filter((l) => /^#{1,6} /.test(l));

/** 回傳問題清單（空＝可以寫）。每一項以固定標籤開頭。 */
export function docWriteProblems(oldText, newText, { allowShrink = false } = {}) {
  const problems = [];
  const a = linesOf(oldText).length; const b = linesOf(newText).length;
  if (!allowShrink && b < a) problems.push(`行數變少：${a} → ${b}（真的要刪就明講 allowShrink）`);
  const now = new Set(headingsOf(newText));
  const gone = headingsOf(oldText).filter((h) => !now.has(h));
  if (gone.length) problems.push(`章節標題不見：${gone.slice(0, 3).join('／')}${gone.length > 3 ? ` 等 ${gone.length} 個` : ''}`);
  return problems;
}

/** 讀原檔 → 擋 → 寫 → 讀回確認。有問題就丟例外、一個字都不寫。 */
export function guardedWrite(file, newText, opts = {}) {
  const oldText = fs.readFileSync(file, 'utf8');
  const problems = docWriteProblems(oldText, newText, opts);
  if (problems.length) throw new Error(`不寫回 ${file}：${problems.join('；')}`);
  fs.writeFileSync(file, newText);
  if (fs.readFileSync(file, 'utf8') !== newText) throw new Error(`寫回 ${file} 之後讀回的內容不一樣`);
}
