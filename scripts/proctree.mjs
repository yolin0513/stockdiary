// 殺程序樹之前，先算出「真的是我們開的」那幾個（2026-10-03）。
//
// 為什麼：以前 workertest 用 `taskkill /PID <殼的 PID> /T /F` 殺整棵樹。PID 會被重用——殼結束之後，
// 那個號碼可能被別的程序拿走（JLPT 2026-10-02 撞到的是 OneDrive 的同步服務，那會砍掉 Yolin 正在同步的檔案），
// 而 taskkill /T 自己找子孫也只看父 PID。所以改成自己列程序表、自己挑，兩道擋（TripQuest 同日的修法）：
//   1. 只認「比父程序晚建立」的子程序；根程序本身要是在我們開它的那一刻前後建立的
//   2. 只殺名稱在可殺清單裡的；不在清單裡的，就算被認成子孫也不殺、只印出來
// 判斷是純函式（pickKillTargets），用合成的程序表驗（含 PID 重用的樣本）；列程序表與真的殺在 killTargets。

import { execFileSync } from 'node:child_process';

/**
 * table：[{ pid, ppid, name, created（毫秒） }]；rootPid：我們開的那一個；spawnedAt：開它的時刻（毫秒）。
 * 回傳 { kill: [pid…], skipped: [{ pid, name, why }], why }（why 不是 null ＝ 根程序認不得，一個都不殺）。
 */
export function pickKillTargets(table, rootPid, spawnedAt, allow, { slackMs = 5000 } = {}) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const root = byPid.get(rootPid);
  // 根程序：還在的話，建立時刻要落在我們開它的那一刻前後；不在了（殼已結束），子孫要在開它之後才建立
  if (root && Math.abs(root.created - spawnedAt) > slackMs) {
    return { kill: [], skipped: [{ pid: root.pid, name: root.name, why: '根程序的建立時刻跟我們開它的時刻對不上（PID 被重用）' }], why: '根程序不是我們開的那一個' };
  }
  const rootCreated = root ? root.created : spawnedAt - slackMs;
  const kill = [];
  const skipped = [];
  const seen = new Set([rootPid]);
  const walk = (parentPid, parentCreated) => {
    for (const p of table) {
      if (p.ppid !== parentPid || seen.has(p.pid)) continue;
      // 第一道：子程序一定比父程序晚建立；早建立的是 PID 重用的舊程序（例：記著已結束的父 PID 的 OneDrive）
      if (!(p.created >= parentCreated)) { skipped.push({ pid: p.pid, name: p.name, why: '比父程序早建立（父 PID 被重用）' }); continue; }
      seen.add(p.pid);
      // 第二道：名稱不在可殺清單 → 不殺、只印（它的子孫也不往下認）
      if (!allow.includes(p.name.toLowerCase())) { skipped.push({ pid: p.pid, name: p.name, why: '名稱不在可殺清單' }); continue; }
      kill.push(p.pid);
      walk(p.pid, p.created);
    }
  };
  if (root) {
    if (allow.includes(root.name.toLowerCase())) kill.push(root.pid);
    else skipped.push({ pid: root.pid, name: root.name, why: '名稱不在可殺清單' });
  }
  walk(rootPid, rootCreated);
  return { kill, skipped, why: null };
}

/**
 * 我們開的那棵樹裡的全部程序（只列、不殺；資源紀錄用）。認法跟 pickKillTargets 一樣防 PID 重用：
 * 根程序的建立時刻要對得上開它的時刻；子孫一定比父程序晚建立。不看名稱清單（要數全部）。
 * 回傳 [{ pid, name, …原欄位 }]，含根程序（還在的話）。
 */
export function descendants(table, rootPid, spawnedAt, { slackMs = 5000 } = {}) {
  const root = table.find((p) => p.pid === rootPid);
  if (root && Math.abs(root.created - spawnedAt) > slackMs) return [];
  const out = root ? [root] : [];
  const seen = new Set([rootPid]);
  const walk = (parentPid, parentCreated) => {
    for (const p of table) {
      if (p.ppid !== parentPid || seen.has(p.pid) || !(p.created >= parentCreated)) continue;
      seen.add(p.pid);
      out.push(p);
      walk(p.pid, p.created);
    }
  };
  walk(rootPid, root ? root.created : spawnedAt - slackMs);
  return out;
}

/** Windows 的程序表（PowerShell 的 Win32_Process）。讀不到就丟例外——不能當成「沒有子程序」。 */
export function windowsProcessTable() {
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2}`t{3}`t{4}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CreationDate.ToUniversalTime().ToString("o"), $_.WorkingSetSize }';
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const table = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [pid, ppid, name, created, ws] = l.split('\t');
    return { pid: Number(pid), ppid: Number(ppid), name: String(name), created: Date.parse(created), mem: Number(ws) || 0 };
  }).filter((p) => Number.isInteger(p.pid) && Number.isFinite(p.created));
  if (table.length < 5) throw new Error(`程序表只讀到 ${table.length} 筆——讀法壞了，不能拿它判斷要殺哪些`);
  return table;
}

/** 系統可用記憶體（MB）。讀不到就丟例外。 */
export function windowsFreeMemoryMB() {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { encoding: 'utf8' });
  const kb = Number(out.trim());
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`讀不到系統可用記憶體（${out.trim().slice(0, 40)}）`);
  return Math.round(kb / 1024);
}

/** 工作程序：node／python／瀏覽器（§5.19；bash、git、powershell 不算）。 */
export const WORKER_NAMES = ['node.exe', 'python.exe', 'python3.exe', 'chrome.exe', 'chrome-headless-shell.exe', 'msedge.exe'];

/** 照 pickKillTargets 挑出來的殺（一支一支殺、不用 /T）；回傳挑選結果，讓呼叫端印出沒殺的。 */
export function killTargets(rootPid, spawnedAt, allow, { table = windowsProcessTable(), kill = (pid) => execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }) } = {}) {
  const pick = pickKillTargets(table, rootPid, spawnedAt, allow);
  for (const pid of [...pick.kill].reverse()) {   // 由下往上殺：子孫先、根最後
    try { kill(pid); } catch (e) { pick.skipped.push({ pid, name: '?', why: `taskkill 失敗（可能已經結束）：${String(e?.message ?? e).split('\n')[0]}` }); }
  }
  return pick;
}
