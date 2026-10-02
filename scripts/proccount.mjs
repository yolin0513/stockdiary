// 程序逐一計數（longrun 用 NODE_OPTIONS=--import 掛到它開的整棵樹的每一個 node 上；2026-10-03）。
//
// 為什麼：每 60 秒取樣一次的峰值會系統性偏低——只活 0.8 秒的子程序，取樣多半抓不到（遊戲那邊用三個 0.8 秒的子程序驗到峰值 3，
// 取樣抓不到）。所以改成逐一計數：每個 node 程序啟動時記「+」、結束時記「-」；它開的**非 node** 子程序（bash、瀏覽器、git…）
// 在開的時候記「+」、結束時記「-」（node 子程序自己會記，不重複記）。longrun 跑完照順序重播，算出真正的同時峰值。
// 被硬殺的程序來不及記「-」→ 峰值只會高估、不會低估。
// 只寫檔、不印任何東西（印了會混進測試的輸出）。事件檔的路徑由 longrun 經環境變數 SD_PROCCOUNT 交給它。

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const FILE = process.env.SD_PROCCOUNT;
if (FILE) {
  const put = (s) => { try { fs.appendFileSync(FILE, `${Date.now()}\t${s}\n`); } catch { /* 記不到就少一筆：峰值只會偏低一次，不影響被測的程式 */ } };
  put(`+\tnode:${process.pid}\tnode`);
  process.on('exit', () => put(`-\tnode:${process.pid}`));
  const isNode = (cmd) => /(^|[\\/])node(\.exe)?$/i.test(String(cmd)) || String(cmd) === process.execPath;
  const nameOf = (cmd) => path.basename(String(cmd)).toLowerCase();
  let seq = 0;
  // 非同步：spawn 與 execFile——開的那一刻 +、exit 時 -。
  // （Node 的 execFile 內部用的是模組裡自己那一份 spawn，不經過這裡包的，所以兩個都要包；exec 走 shell，記成 cmd.exe 那一層）
  for (const fn of ['spawn', 'execFile']) {
    const orig = cp[fn];
    cp[fn] = function patchedAsync(cmd, ...rest) {
      const child = orig.call(this, cmd, ...rest);
      if (!isNode(cmd)) {
        const id = `c:${process.pid}:${++seq}`;
        put(`+\t${id}\t${nameOf(cmd)}`);
        let ended = false;   // error 之後可能還有 exit：只記一次「-」
        const end = () => { if (!ended) { ended = true; put(`-\t${id}`); } };
        child.once('exit', end);
        child.once('error', end);
      }
      return child;
    };
  }
  // 同步：spawnSync／execFileSync——呼叫前 +、回來後 -
  for (const fn of ['spawnSync', 'execFileSync']) {
    const orig = cp[fn];
    cp[fn] = function patchedSync(cmd, ...rest) {
      if (isNode(cmd)) return orig.call(this, cmd, ...rest);
      const id = `c:${process.pid}:${++seq}`;
      put(`+\t${id}\t${nameOf(cmd)}`);
      try { return orig.call(this, cmd, ...rest); } finally { put(`-\t${id}`); }
    };
  }
  syncBuiltinESMExports();
}
