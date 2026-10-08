// 共用慣例副本要跟主檔一致（2026-10-08，Dispatch；照 MealMate 的 scripts/convcheck.mjs 抄過來、改成本 repo 的樣子）。
// 為什麼：副本過期時，過期的規則和現行的規則在閱讀時長得一樣——都叫「共用慣例」、都讀得通，沒有任何地方會告訴你手上那份過期了
// （本 repo 的副本停在 v9 好幾天，主檔早就是 v11.6；MealMate 因此兩條規則違反了一整天）。scripts/convtest.mjs 每次都跑（npm test 鏈）。
//
// 主檔：統籌工作區（統籌 Session 的 repo）的 CONVENTIONS.md——Dispatch 2026-10-08 確認是專案既定的安排。
// 路徑用相對於本 repo 根目錄的寫法登記在這裡（不寫本機絕對路徑：repo 是公開的）。搬家了就改這一行。
// **已知代價（刻意的）**：換一台沒有統籌工作區的機器，這道檢查會紅（讀不到主檔）——靜默跳過的版本比對等於沒有版本比對，紅了至少會有人問為什麼。
// 判定：讀不到主檔＝紅（講明「讀不到主檔」，不當成通過）；副本與主檔是同一個實體檔＝紅（拿自己比自己永遠一致）；
//       版本行不同＝紅；版本行相同、全文不同＝紅（主檔改了內容卻沒改版本，或副本被改過）。
// 比 MealMate 多一道：同一個實體檔用 realpath 加 inode 判（MealMate 只比路徑字串，捷徑或連結騙得過）。
import fs from 'node:fs';
import path from 'node:path';

export const MASTER_REL = '../../Fable_Planner/CONVENTIONS.md';
export const COPY_REL = 'docs/CONVENTIONS.md';

/** 第一行的版本標記：<!-- CONVENTIONS vX 日期 -->；不是這個樣子就回 null */
export function versionLine(text) {
  const first = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)[0];
  return /^<!-- CONVENTIONS v[\d.]+ \d{4}-\d{2}-\d{2} -->$/.test(first) ? first : null;
}

/** 比對副本與主檔的內容（純函式）：{ ok, why }。why 的開頭是固定標籤，測試照開頭比。 */
export function compareConv(copyText, masterText) {
  if (masterText == null) return { ok: false, why: '讀不到主檔' };
  if (copyText == null) return { ok: false, why: '讀不到副本' };
  const cv = versionLine(copyText); const mv = versionLine(masterText);
  if (!mv) return { ok: false, why: '主檔第一行不是版本標記' };
  if (!cv) return { ok: false, why: '副本第一行不是版本標記' };
  if (cv !== mv) return { ok: false, why: `版本不同：副本 ${cv}、主檔 ${mv}——副本過期，照主檔更新（照統籌者的工單）` };
  const norm = (t) => String(t).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (norm(copyText) !== norm(masterText)) return { ok: false, why: `全文不同：版本相同（${cv}）但內容不同——主檔改了內容卻沒改版本，或副本被改過` };
  return { ok: true, why: `一致（${cv}）` };
}

/** 兩個路徑是不是同一個實體檔（realpath 相同，或同一個 dev＋inode）。任一個讀不到回 false。 */
export function sameFile(a, b) {
  try {
    if (fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()) return true;
    const sa = fs.statSync(a, { bigint: true }); const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch { return false; }
}

/** 從 repo 根目錄讀兩份來比。 */
export function convCheck(root, { masterRel = MASTER_REL, copyRel = COPY_REL } = {}) {
  const copyAbs = path.resolve(root, copyRel); const masterAbs = path.resolve(root, masterRel);
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };   // 讀不到回 null → 下面判紅，不當成通過
  const masterText = read(masterAbs);
  if (masterText != null && sameFile(copyAbs, masterAbs)) return { ok: false, why: '同一個實體檔：副本與主檔指到同一個檔，拿自己比自己永遠一致' };
  return compareConv(read(copyAbs), masterText);
}
