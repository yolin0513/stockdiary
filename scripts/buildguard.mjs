// 三支 build（build-calendar、build-dividends、build-stocks）共用的「寫檔前關卡」（2026-09-24）。
//
// 為什麼（STATUS「S8：三支 build 的盤點」）：資料變少時三支都照樣寫檔——日曆剩 1 天休市、股利剩 2 檔、
// 少一份上櫃來源都回 0；build-dividends 一筆都收不進來時，照樣寫出「0 檔」的 dividends.json。
// 這是財務資料：舊檔被一份殘缺的新檔蓋掉，App 不會知道，使用者更不會。
//
// 形狀（照 JLPT build_data.py 的修法）：**動手寫任何檔之前**，先確認每一份來源、每一組都有、都不是空的、
// 欄位對得上、沒有比上一次成功的少一半以上；**有任何一項不過就全部停、一個檔都不寫**，輸出維持上一次成功的狀態。
// 問題一次列完（不是遇到第一個就停），每一條都點名是哪一份來源、哪一組。

import fs from 'node:fs';
import path from 'node:path';

/** 收集寫檔前的問題；check() 在寫檔之前呼叫，有問題就拋錯（訊息開頭固定是「不寫檔：」）。 */
export function guard(what) {
  const problems = [];
  return {
    problems,
    add(msg) { problems.push(msg); },
    check() {
      if (problems.length) {
        throw new BuildStop(`${what} 不寫檔：寫檔前的檢查沒過，輸出維持上一次成功的狀態\n  · ${problems.join('\n  · ')}`);
      }
    },
  };
}

/**
 * 比上一次成功的少一半以上嗎？回傳問題字串或 null。
 * before 讀不到（第一次產）就不比——那時只靠「不是空的」擋。
 */
export function shrinkProblem(label, now, before) {
  if (!(Number.isFinite(before) && before > 0)) return null;
  if (now * 2 < before) return `${label}：這次只有 ${now}，上一次成功的是 ${before}（少了一半以上）`;
  return null;
}

/**
 * 讀上一次成功的輸出。**只有「檔案不存在」算第一次產**（回 null）；
 * 存在卻讀不了或解析不了就拋錯——那是壞掉，不能當成「沒有上一次」而跳過比對。
 */
export function readPrevious(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 先寫到同一個目錄的暫存檔、寫完再換上：寫到一半中斷，也不會留下半份輸出。 */
//
// 寫不進去時（補充說明（四）第 5 點；Windows 上防毒或索引程式鎖檔就會這樣）：
//   · 暫存檔名固定是「<輸出檔>.tmp」——那個位置被別的東西佔住（例如同名資料夾），**不動它**，照實講出來
//   · **只清自己寫出的暫存檔**；清理本身也可能失敗，失敗就點名留下了哪個檔，**不中斷**、不吐堆疊
//   · 停下的訊息跟寫檔前關卡同一個格式（「寫檔失敗：」後面一串「  · 單位：狀況」），輸出檔本身維持上一次成功的內容
export function writeAtomic(dest, text) {
  const tmp = `${dest}.tmp`;
  const unit = `輸出檔（${path.basename(dest)}）`;
  const problems = [];
  let wrote = false;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    wrote = true;
    fs.renameSync(tmp, dest);
    return;
  } catch (e) {
    problems.push(wrote
      ? `${unit}：換不上去（${e.code ?? e.message}）——新的內容寫在暫存檔裡，沒有蓋掉原本的輸出檔`
      : `${unit}：暫存檔寫不進去（${e.code ?? e.message}：${path.basename(tmp)}）——那個位置原本的東西沒有動`);
  }
  if (wrote) {
    try {
      fs.rmSync(tmp, { force: true });
      problems.push(`${unit}：已清掉這次寫出的暫存檔 ${path.basename(tmp)}`);
    } catch (e) {
      problems.push(`${unit}：清理也失敗——暫存檔 ${path.basename(tmp)} 刪不掉（${e.code ?? e.message}），留在輸出目錄裡，請手動刪除`);
    }
  }
  throw new BuildStop(`寫檔失敗：輸出維持上一次成功的內容\n  · ${problems.join('\n  · ')}`);
}

/** 設計好的停下（寫檔前關卡沒過、寫檔失敗）：印訊息就好，不印堆疊。沒料到的例外才印堆疊。 */
export class BuildStop extends Error {}
export function reportAndExit(e) {
  process.stderr.write(e instanceof BuildStop ? `✗ ${e.message}\n` : `✗ 沒料到的錯誤：${e?.stack ?? e}\n`);
  process.exit(1);
}
