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

/** 收集寫檔前的問題；check() 在寫檔之前呼叫，有問題就拋錯（訊息開頭固定是「不寫檔：」）。 */
export function guard(what) {
  const problems = [];
  return {
    problems,
    add(msg) { problems.push(msg); },
    check() {
      if (problems.length) {
        throw new Error(`${what} 不寫檔：寫檔前的檢查沒過，輸出維持上一次成功的狀態\n  · ${problems.join('\n  · ')}`);
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
export function writeAtomic(dest, text) {
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, dest);
}
