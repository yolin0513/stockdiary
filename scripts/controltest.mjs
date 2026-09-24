// 不在 npm test 裡的檢查器，它們的「判斷邏輯自己有沒有壞」每版在這裡跑（npm run controltest；在 npm test 鏈裡）。
//
// 為什麼要這支（SPEC_檢查器修補 F1）：assertaudit（9 分鐘、手動）這類檢查器很久才跑一次；
// 它們的判斷邏輯壞掉時，以前沒有任何東西會發現（v9 盤點實測：篩選條件改壞，報告照樣回 0）。
// 判斷邏輯抽成模組、在這裡用合成樣本跑——跟那支檢查器自己開頭跑的是同一組對照、同一段程式。
//
// 每一組對照用**寫死的標籤**斷言（共用慣例 §5.9：突變的 expect 要有固定的錨點），
// 而且逐一點名：哪一組對照不見了，那一條就紅（不能靠「全部都 ok」——少一組也是全部都 ok）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done } from './tap.mjs';
import { controls as auditControls, chainOf, auditOrphans } from './auditjudge.mjs';
import { controls as sweepControls } from './sweepjudge.mjs';
import { controls as liveControls, stageControls as liveStageControls } from './livejudge.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const expectEach =(tool, results, labels) => {
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
  'orphan-missing': 'assertaudit 對照五：鏈上多了一支沒登記的，要報出它',
  'orphan-stale': 'assertaudit 對照六：清單裡有一支不在鏈上，要報出它',
  'orphan-skip-stale': 'assertaudit 對照七：不收的理由寫給不在鏈上的，要報出它',
  'orphan-clean': 'assertaudit 對照八（必過）：鏈上全部登記或寫了理由，什麼都不報',
});

// 孤兒檢查（S5，F4）：assertaudit 的清單要涵蓋 npm test 鏈上的每一支——以前 v9 新加進鏈的兩支沒補進去，沒有東西會發現。
// 跟上面對照五到八同一段程式（auditjudge.mjs 的 chainOf、auditOrphans）。
section('assertaudit 的清單 ＝ npm test 鏈（孤兒檢查）');
const chain = chainOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test);
ok(chain.length >= 30, `（前提）從 package.json 的 npm test 取到 ${chain.length} 支`);
const orphans = auditOrphans(chain);
eq(orphans.missing, [], 'assertaudit 孤兒：npm test 鏈上的每一支，都在 assertaudit 的清單裡或寫了不收的理由');
eq(orphans.stale, [], 'assertaudit 過期：assertaudit 清單裡的每一支都還在 npm test 鏈上');
eq(orphans.skipStale, [], 'assertaudit 理由過期：寫了不收理由的每一支都還在 npm test 鏈上');

section('sweep 的判斷邏輯（scripts/sweepjudge.mjs；合成回應，不打網路）');
expectEach('sweep', sweepControls(), {
  'sw-old': 'sweep 對照一：線上 sw.js 是舊版，版本比對要報 sw.js',
  'html-old': 'sweep 對照二：線上 index.html 載入舊版，版本比對要報 index.html',
  'sw-missing': 'sweep 對照三：sw.js 讀不到版本，要報、不能當成一致',
  'cache-stale': 'sweep 對照四：還留著舊版的快取，要挑出那一個',
  'real-error': 'sweep 對照五：不是新聞上游的錯誤，要算進真的錯誤',
  clean: 'sweep 對照六（必過）：全部一致、只有新聞上游 502，什麼都不報',
});

section('livecheck 的判斷邏輯（scripts/livejudge.mjs；錄好的回應，不打證交所）');
expectEach('livecheck', liveControls(), {
  cors: 'livecheck 對照一：CORS 標頭不見，要報',
  sda: 'livecheck 對照二：STOCK_DAY_ALL 的表裡少了 2330，要報',
  sd: 'livecheck 對照三：STOCK_DAY 的除權息標記不見，要報',
  otc: 'livecheck 對照四：上櫃代號查得到資料了，要報',
  t48u: 'livecheck 對照五：TWT48U 的欄位改名，要報格式變了',
  refprice: 'livecheck 對照六：參考價跟公式差 0.01，要挑出那一筆',
  calendar: 'livecheck 對照七：證交所那個月少一個交易日，要報出是哪一天',
  stocks: 'livecheck 對照八：市場上多了一檔代號表沒有的，要報出那一檔',
  gaps: 'livecheck 對照九：請求間隔不到 2 秒或一個都沒量到，要報',
  'calendar-closed': 'livecheck 對照十：日曆休市日多年格式要讀得到、認不得的格式要拋錯',
});
expectEach('livecheck 段落', await liveStageControls(), {
  stages: 'livecheck 對照十一：中間一段崩了，要記成那一段失敗、講出段名，後面照跑',
});

done('controltest');
