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
 * 動態組出來的 import 路徑：樣板字串裡，`${` 出現在路徑的 `.js` 之前（例：`./js/views/${m}.js`）。
 * 只有版本參數接在 `.js` 後面的（`./views/home.js${V}`）不算——路徑本身是固定的。
 */
export function dynamicImportsOf(rawSource) {
  const out = [];
  for (const m of stripComments(rawSource).matchAll(/\bimport\(\s*`([^`]*?)\$\{/g)) {
    if (!/\.m?js$/.test(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 一支測試「碰得到」的全部模組，加上**判斷不出範圍的理由**（unresolved）。
 *
 * readFile 是參數而不是直接 fs.readFileSync —— 測試才能用假的檔案系統驗證這個展開
 * 真的有遞移下去（只展開一層的話，改 js/money.js 就挑不到任何東西，因為沒有測試
 * 直接 import 它，全是經由 settle.js／dividend.js 間接用到）。
 *
 * **讀不到、動態路徑，不是「沒有關係」**（共用慣例 §5.13、§5.18 第 1 點；2026-10-03）：
 * 以前讀不到的檔直接跳過，範圍默默變小——實測一支中間的模組讀不到，改 js/avgcost.js 從 168 條變成 11 條，
 * 回傳 0、沒有任何訊息。現在讀不到的檔、動態組出來的 import 路徑都記進 unresolved，呼叫端照它全跑。
 */
export function closureReport(testRel, readFile) {
  const unresolved = [];
  let src;
  try { src = readFile(testRel); } catch { return { modules: [], unresolved: [`讀不到測試檔 ${testRel}`] }; }
  for (const d of dynamicImportsOf(src)) unresolved.push(`${testRel} 有動態組出來的 import 路徑（${d}…）`);

  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let s;
    try { s = readFile(rel); } catch { unresolved.push(`讀不到 ${rel}`); return; }
    for (const d of dynamicImportsOf(s)) unresolved.push(`${rel} 有動態組出來的 import 路徑（${d}…）`);
    for (const spec of moduleRefsOf(s)) walk(spec);
    // js/ 模組之間是正常的相對 import（'./money.js'），要相對它自己的目錄解析
    for (const m of stripComments(s).matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (next.startsWith('js/')) walk(next);
    }
  };

  for (const spec of moduleRefsOf(src)) walk(spec);
  return { modules: [...seen], unresolved };
}

/** 只要模組清單（判斷不出範圍的理由另外看 closureReport）。 */
export function moduleClosure(testRel, readFile) {
  return closureReport(testRel, readFile).modules;
}

/**
 * 挑選的入口（mutationtest --changed 用）：**任何一支測試判斷不出範圍，就全跑**，並回傳理由。
 * reportOf(testName) → closureReport 的結果。回傳 { selected, all, reasons }。
 * 寧可多跑、不可少跑（§5.18 第 1 點）：一支測試的範圍算不出來，就不知道這次的改動有沒有碰到它。
 */
export function selectWithReason(mutations, changedFiles, reportOf) {
  const cache = new Map();
  const rep = (t) => { if (!cache.has(t)) cache.set(t, reportOf(t)); return cache.get(t); };
  const reasons = [];
  for (const t of new Set(mutations.map((m) => m.test))) for (const u of rep(t).unresolved) reasons.push(`${t}：${u}`);
  if (reasons.length) return { selected: mutations, all: true, reasons };
  return { selected: selectAffected(mutations, changedFiles, (t) => rep(t).modules), all: false, reasons };
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
