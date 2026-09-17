// 「這次改動影響到哪些突變」的挑選邏輯（給 mutationtest 的 --changed 用）。
//
// 全套突變要跑 3.5 小時，所以日常只跑「這次改到的程式碼對應的那幾條」。
// 以前這件事靠人手動下 `--only <關鍵字>`，而 STATUS 慣例 28 記著它出過什麼事：
// **受影響的測試少跑一支，斷言就悄悄過期。** 人挑會漏，所以改成從 git diff 自動算。
//
// 這支只放**純函式**：不讀檔、不跑 git、不碰 process。
// 呼叫端（mutationtest.mjs）負責餵進「改到的檔案清單」與「讀檔函式」，
// shelltest 則餵假資料驗證挑選邏輯本身 —— 不然這個挑選器自己壞掉時沒人會知道，
// 而它壞掉的樣子正好是「少挑了幾條」，跟全綠長得一模一樣。

import path from 'node:path';
import { stripComments } from './srcscan.mjs';

/**
 * 從一支測試檔的原始碼，抽出它會碰到的專案模組（正規化成 repo 相對路徑）。
 *
 * 測試檔裡的 import 有兩種，而且**根目錄不同**：
 *   1. Node 端：`import { makeCalendar } from '../js/market.js'`  → 相對於 scripts/
 *   2. 瀏覽器端：`await import('./js/db.js')`（包在 page.evaluate 裡）→ 相對於網站根目錄
 * 兩種都要認。只看第 1 種的話，所有端對端測試都會算成「沒碰到任何 js 模組」，
 * 挑選器就會把它們全部漏掉 —— 而那正是最需要跑的那幾支。
 *
 * 只回傳 js/ 底下的模組；scripts/ 之間的相依（tap、serve）不影響突變挑選。
 */
export function moduleRefsOf(rawSource) {
  const source = stripComments(rawSource);
  const out = new Set();
  const patterns = [
    /\bimport\s+[^'"]*?from\s+'([^']+)'/g,
    /\bimport\s+'([^']+)'/g,
    /\bimport\(\s*'([^']+)'\s*\)/g,
    /\bimport\(\s*`([^`$]+)/g,
  ];
  for (const rx of patterns) {
    for (const m of source.matchAll(rx)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      // '../js/x.js'（相對 scripts/）與 './js/x.js'（相對站台根）都落到 js/x.js
      const norm = path.posix.normalize(spec.replace(/^\.\.\//, '').replace(/^\.\//, ''));
      if (norm.startsWith('js/')) out.add(norm);
    }
  }
  return [...out];
}

/**
 * 一支測試「碰得到」的全部模組：它直接引用的，加上那些模組遞移 import 的。
 *
 * readFile 是參數而不是直接 fs.readFileSync —— 測試才能用假的檔案系統驗證這個展開
 * 真的有遞移下去（只展開一層的話，改 js/money.js 就挑不到任何東西，因為沒有測試
 * 直接 import 它，全是經由 settle.js／dividend.js 間接用到）。
 *
 * 讀不到的檔案直接跳過：測試檔裡的 import 字串有可能指向不存在的路徑
 * （例如字串拼接出來的），那不該讓整個挑選器爆掉。
 */
export function moduleClosure(testRel, readFile) {
  let src;
  try { src = readFile(testRel); } catch { return []; }

  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let s;
    try { s = readFile(rel); } catch { return; }
    for (const spec of moduleRefsOf(s)) walk(spec);
    // js/ 模組之間是正常的相對 import（'./money.js'），要相對它自己的目錄解析
    for (const m of stripComments(s).matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (next.startsWith('js/')) walk(next);
    }
  };

  for (const spec of moduleRefsOf(src)) walk(spec);
  return [...seen];
}

/**
 * 挑出「這次改動有可能讓它變得不會紅」的突變。
 *
 * 三種情況都要挑（少挑任何一種，都會讓某條斷言在沒人看著的情況下過期）：
 *   1. 突變要改的那個檔案被改了 —— find 字串可能已經對不上（突變過期）
 *   2. 突變對應的測試檔自己被改了 —— 斷言可能被改弱了
 *   3. 那支測試碰得到的某個模組被改了 —— 邏輯變了，斷言可能已經守不住
 *
 * depsOf(testName) 由呼叫端提供，回傳那支測試碰得到的模組清單。
 * 純函式：不讀檔，好驗證。
 */
export function selectAffected(mutations, changedFiles, depsOf) {
  const changed = new Set(changedFiles);
  const cache = new Map();
  const deps = (t) => {
    if (!cache.has(t)) cache.set(t, new Set(depsOf(t) || []));
    return cache.get(t);
  };
  return mutations.filter((m) => {
    if (changed.has(m.file)) return true;
    if (changed.has(`scripts/${m.test}.mjs`)) return true;
    for (const f of changed) if (deps(m.test).has(f)) return true;
    return false;
  });
}
