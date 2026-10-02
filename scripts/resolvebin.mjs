// 把 bash 解成完整路徑，拒絕 WSL（2026-10-03，JLPT 與 MealMate 同日查到）。
//
// 為什麼：裸寫的 `bash` 交給 PATH 解。實測本機從 PowerShell 的 PATH 解，第一支是 %SystemRoot%\system32\bash.exe（WSL），
// 第二支是 WindowsApps 的；從 Git Bash 跑才是 Git 的那一支。被解成 WSL 時驗法根本沒跑起來（JLPT：2 秒就回 1、峰值 0 個程序）。
// 所以開跑前先解成完整路徑：落在 Windows 系統目錄或 WindowsApps 的一律拒絕；解不出來就丟例外（呼叫端判成情境未成立，不是照跑）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 這支 bash 能不能用：Windows 上不准是系統目錄（WSL 的 bash.exe）或 WindowsApps 的。 */
export function acceptableBash(p, { windir = process.env.SystemRoot || process.env.windir || ('C' + ':\\Windows') } = {}) {
  const n = path.win32.normalize(p).toLowerCase();
  if (n.startsWith(path.win32.normalize(windir).toLowerCase() + '\\')) return false;
  if (n.includes('\\windowsapps\\')) return false;
  return true;
}

/** 從候選清單挑第一支能用的；全都不能用 → null。 */
export function pickBash(candidates, opts) {
  return candidates.find((c) => acceptableBash(c, opts)) ?? null;
}

/**
 * 這台機器上的候選：PATH 上每一個目錄裡的 bash.exe（照 PATH 的順序），再加上 git 自己那一份的 usr/bin/bash.exe。
 * 回傳 { list, notes }：notes 記下沒取到候選的原因（例：git --exec-path 失敗），解不出來時一起印出來。
 */
export function bashCandidates() {
  const list = [];
  const notes = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'bash.exe');
    if (fs.existsSync(p)) list.push(p);
  }
  try {
    // git --exec-path → …\Git\mingw64\libexec\git-core；往上三層是 Git 的根目錄
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const p = path.normalize(path.join(exec, '..', '..', '..', 'usr', 'bin', 'bash.exe'));
    if (fs.existsSync(p)) list.push(p);
    else notes.push(`git 那一份的 bash 不在 ${p}`);
  } catch (e) {
    notes.push(`git --exec-path 失敗：${String(e?.message ?? e).split('\n')[0]}`);
  }
  return { list, notes };
}

/** 解成完整路徑；非 Windows 直接用 bash。解不出來就丟例外，訊息列出看過哪些候選、為什麼沒取到。 */
export function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  const { list, notes } = bashCandidates();
  const p = pickBash(list);
  if (!p) throw new Error(`找不到可用的 bash（看過 ${list.length} 支：${list.join('、') || '（沒有）'}；系統目錄與 WindowsApps 的是 WSL，不能用${notes.length ? `；${notes.join('；')}` : ''}）`);
  return p;
}
