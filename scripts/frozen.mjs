// 凍結區的靜態稽核（doctest 用）。
//
// 凍結區＝成本／損益對帳的數學（CLAUDE.md 常設規則 5、SPEC_全面優化.md §0）：在 Yolin 另外拍板之前，
// 那些檔案與函式**連過期註解也不改**。以前靠每一版人工 `git diff` 代驗（v0.7.23 就是這樣），
// 凍結還要維持一段時間，所以做成常設的：清單從 §0 讀（不寫死），每個單位的內容雜湊要等於快照。
//
// 快照是 scripts/frozen-snapshot.json。**只有在 Yolin 明確同意動凍結區之後**才重產它：
//   node scripts/doctest.mjs --write-frozen-snapshot
// 重產時 commit 訊息要寫是依哪一次拍板。

import { createHash } from 'node:crypto';

/**
 * 從 §0 的文字取出凍結清單。寫法是：
 *   `js/avgcost.js` 全部；`js/holdings.js` 的 `a`／`b`／`c`；…
 * 回傳 [{ file, fn }]：fn 為 null 代表整個檔案。
 */
export function parseFrozenList(section0) {
  const units = [];
  for (const seg of section0.split(/[；;\n]/)) {
    const file = /`(js\/[^`]+\.js)`/.exec(seg)?.[1];
    if (!file) continue;
    if (/全部/.test(seg)) { units.push({ file, fn: null }); continue; }
    const after = seg.slice(seg.indexOf(file) + file.length);
    for (const m of after.matchAll(/`([A-Za-z_$][\w$]*)`/g)) units.push({ file, fn: m[1] });
  }
  return units;
}

/** §0 的第 1 條（「成本／損益對帳數學凍結」那一段）。找不到回 null。 */
export function frozenSection(specText) {
  const start = specText.indexOf('1. **成本／損益對帳數學凍結。**');
  if (start < 0) return null;
  const end = specText.indexOf('\n2. ', start);
  return specText.slice(start, end < 0 ? undefined : end);
}

/**
 * 切出一個頂層函式的全文（從 `function name(` 那一行到第一個行首的 `}`）。
 * 這個 repo 的頂層函式一律是這個寫法；切不出來、或括號不平衡就回 null（讓稽核紅，不要猜）。
 */
export function extractFunction(src, fn) {
  const head = new RegExp(`^(export )?(async )?function ${fn}\\(`, 'm').exec(src);
  if (!head) return null;
  const end = src.indexOf('\n}', head.index);
  if (end < 0) return null;
  const body = src.slice(head.index, end + 2);
  const open = (body.match(/\{/g) || []).length;
  const close = (body.match(/\}/g) || []).length;
  return open === close ? body : null;
}

export const hashOf = (text) => (text == null ? null : createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16));

/** 每個單位現在的雜湊。read(rel) 讀不到回 null。 */
export function currentHashes(units, read) {
  return units.map((u) => {
    const src = read(u.file);
    const text = src == null ? null : (u.fn ? extractFunction(src, u.fn) : src);
    return { key: u.fn ? `${u.file}#${u.fn}` : u.file, hash: hashOf(text) };
  });
}
