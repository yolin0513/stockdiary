// upgradecheck 的「舊版」要拿哪一個 commit。
//
// 以前預設 `HEAD~1`。v0.7.22 之後連續五個 commit 全是文件，「舊版」與「新版」的 App 一模一樣，
// upgradecheck 的前提斷言（確實不同版）必紅 —— 而 mutationtest 的基準會跑它，基準一紅，
// 整套突變一條都沒跑（2026-09-21 全面檢測白跑 540 秒）。
//
// 再往前的教訓也還在：更早以前這裡寫死一個 commit id（v0.5.0），於是每發一版測的都還是
// 「從 v0.5.0 升上來」，真正要驗的那一跳從來沒測到。**所以不能寫死，也不能只看上一個 commit，
// 要往回找「版本號跟現在不一樣的最近一個 commit」** —— 那就是使用者手機上裝著的那一版。

import { execFileSync } from 'node:child_process';

/**
 * 純函式。commits：從 HEAD 往回的清單（新的在前），每個 { rev, version }；version 讀不到就是 null。
 * 回傳第一個「版本號讀得到、而且跟 current 不同」的 commit；一個都沒有 → { rev: null, reason }。
 *   · HEAD 是文件 commit → 版本跟現在一樣，跳過，往回找
 *   · HEAD 就是 bump 那個 commit → 它的版本等於現在，跳過，挑到上一版
 *   · 工作目錄 bump 了還沒 commit → HEAD 的版本已經跟現在不同，挑 HEAD（線上跑的就是它）
 */
export function pickOldRev(commits, current) {
  for (const c of commits) {
    if (c.version && c.version !== current) return { rev: c.rev, version: c.version, skipped: commits.indexOf(c) };
  }
  return { rev: null, version: null, reason: `往回看了 ${commits.length} 個 commit，沒有任何一個的版本號跟現在（${current}）不同 —— 沒有可比的舊版` };
}

const VERSION_RX = /const VERSION = '([^']+)';/;

/** 某個 commit 的 sw.js 版本號；那時還沒有 sw.js 就回 null。 */
export function versionAt(root, rev) {
  try {
    const sw = execFileSync('git', ['show', `${rev}:sw.js`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return VERSION_RX.exec(sw)?.[1] ?? null;
  } catch { return null; }
}

/** 真的去 git 裡找。找到不同版就停，不必把整段歷史讀完。 */
export function findOldRev(root, current, limit = 200) {
  const revs = execFileSync('git', ['log', '--format=%H', '-n', String(limit)], { cwd: root, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const seen = [];
  for (const rev of revs) {
    seen.push({ rev, version: versionAt(root, rev) });
    if (seen.at(-1).version && seen.at(-1).version !== current) break;
  }
  return pickOldRev(seen, current);
}
