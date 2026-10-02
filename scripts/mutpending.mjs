// 突變執行器的還原紀錄與還原（mutationtest.mjs 用；2026-10-03 從 mutationtest.mjs 搬出來）。
//
// 為什麼獨立一支：突變清單在 mutationtest.mjs 裡是字面資料，突變要打的那段程式若也在 mutationtest.mjs，
// find 字串會在清單的字面裡再出現一次（剛好 1 次的檢查過不了）。搬到這裡，突變（PD：）才打得到。
//
// 突變測試**直接改工作區的原始碼**（改完立刻還原）。被硬殺（工作管理員、taskkill /F、SIGKILL）時
// exit 的還原走不到，所以每改一支先把原檔寫進紀錄（scripts/.mutation-pending.json，不進版控）：
//   · 下一次啟動、或 node scripts/mutationtest.mjs --restore，照紀錄寫回原檔
//   · 紀錄在的這段期間，推送閘門（回 6）與自查（scripts/precheck.mjs）都擋——壞檔不會被 commit、推上線
// 紀錄的路徑與讀法跟閘門、自查共用（precheck.mjs 的 pendingRecord）。

import fs from 'node:fs';
import path from 'node:path';
import { PENDING_REL, pendingRecord, pendingMessage } from './precheck.mjs';

export function makePending(root) {
  const PENDING = path.join(root, PENDING_REL);
  /** 這個程序改壞、還沒寫回的檔：rel → 原檔內容 */
  const backups = new Map();

  /**
   * 改壞一支檔之前先寫紀錄。**寫不進去就丟例外、不准往下改**（2026-10-03 以前寫失敗被吞掉，
   * 突變照樣套上去——被硬殺時就沒有任何東西知道哪一支被改壞）。
   */
  function writePending(rel, content) {
    const text = JSON.stringify({ file: rel, content, at: new Date().toISOString() });
    fs.writeFileSync(PENDING, text, 'utf8');
    if (fs.readFileSync(PENDING, 'utf8') !== text) throw new Error(`還原紀錄寫進去之後讀回來不一樣：${PENDING_REL}`);
  }
  function clearPending() {
    fs.rmSync(PENDING, { force: true });
  }

  /**
   * 上一次跑到一半被殺掉的話，把那個檔案還原回去。回傳 null（沒有紀錄）或 { file, changed, at }。
   * **紀錄壞了不是「沒有紀錄」**：以前解析失敗就刪掉紀錄、當成乾淨，被改壞的那一支就再也沒人知道。
   * 現在停下、不刪紀錄（推送閘門與自查看到紀錄還在就會擋），請人用 git diff 確認。
   */
  function recoverPending() {
    const rec = pendingRecord(root);
    if (rec.state === 'none') return null;
    if (rec.state === 'broken') {
      console.log(pendingMessage(rec));
      process.exit(1);
    }
    const abs = path.join(root, rec.file);
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (now === rec.content) { clearPending(); return { file: rec.file, changed: false }; }
    // 先寫回、讀回確認、最後才刪紀錄（2026-10-03 以前先刪紀錄：寫回失敗的話，紀錄就沒了）
    fs.writeFileSync(abs, rec.content, 'utf8');
    if (fs.readFileSync(abs, 'utf8') !== rec.content) {
      console.log(`還原 ${rec.file} 之後讀回來跟原檔不一樣——紀錄留著（推送閘門與自查會擋），請人工處理`);
      process.exit(1);
    }
    clearPending();
    return { file: rec.file, changed: true, at: rec.at };
  }

  /**
   * 正常結束、Ctrl-C、SIGTERM 時把改壞的檔寫回去。**全部寫回、讀回都對了才刪紀錄**：
   * 2026-10-03 以前寫回失敗被吞掉、紀錄照刪——下一次啟動就不知道有檔沒還原。
   * （硬殺走不到這裡，靠下一次啟動或 --restore 讀紀錄還原。）
   */
  function restoreAll() {
    // 這個程序沒有改壞任何檔：紀錄不是它寫的（上一次留下、正等人處理，或壞掉的），不碰。
    // 2026-10-03 controltest 抓到：紀錄壞了而停下時，exit 時的這一段把它刪掉了，閘門與自查就擋不到。
    if (backups.size === 0) return;
    let allBack = true;
    for (const [rel, content] of backups) {
      const abs = path.join(root, rel);
      try {
        fs.writeFileSync(abs, content, 'utf8');
        if (fs.readFileSync(abs, 'utf8') !== content) allBack = false;
      } catch (e) {
        allBack = false;
        console.log(`還原 ${rel} 失敗：${String(e?.message ?? e).split('\n')[0]}——紀錄留著（推送閘門與自查會擋）`);
      }
    }
    backups.clear();
    if (allBack) clearPending();
  }

  return { backups, writePending, clearPending, recoverPending, restoreAll };
}
