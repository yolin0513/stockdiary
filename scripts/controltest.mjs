// 不在 npm test 裡的檢查器，它們的「判斷邏輯自己有沒有壞」每版在這裡跑（npm run controltest；在 npm test 鏈裡）。
//
// 為什麼要這支（SPEC_檢查器修補 F1）：assertaudit（9 分鐘、手動）這類檢查器很久才跑一次；
// 它們的判斷邏輯壞掉時，以前沒有任何東西會發現（v9 盤點實測：篩選條件改壞，報告照樣回 0）。
// 判斷邏輯抽成模組、在這裡用合成樣本跑——跟那支檢查器自己開頭跑的是同一組對照、同一段程式。
//
// 每一組對照用**寫死的標籤**斷言（共用慣例 §5.9：突變的 expect 要有固定的錨點），
// 而且逐一點名：哪一組對照不見了，那一條就紅（不能靠「全部都 ok」——少一組也是全部都 ok）。

import { ok, section, done } from './tap.mjs';
import { controls as auditControls } from './auditjudge.mjs';

const expectEach = (tool, results, labels) => {
  ok(results.length === Object.keys(labels).length,
    `（前提）${tool} 的對照組有 ${results.length} 組，登記的是 ${Object.keys(labels).length} 組`);
  for (const [key, label] of Object.entries(labels)) {
    const c = results.find((r) => r.key === key);
    ok(c?.ok === true, label, c ? c.detail : `對照組「${key}」不見了`);
  }
};

section('assertaudit 的判斷邏輯（scripts/auditjudge.mjs）');
expectEach('assertaudit', auditControls(), {
  fail: 'assertaudit 對照一：一條一定失敗的斷言，要判成紅了但資料有寫出來',
  empty: 'assertaudit 對照二：空母體的 noneOf，它那一筆要被母體 ≤ 2 挑出來',
  crash: 'assertaudit 對照三：寫出資料前就崩掉，要判成沒收到任何資料',
  clean: 'assertaudit 對照四（必過）：母體 3 的乾淨測試，要判成通過、不被挑出來',
});

done('controltest');
