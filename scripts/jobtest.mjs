// Job Object（scripts/jobrun.mjs＋jobhelper.ps1）的測試（2026-10-03；v11.6 §5.19「殺程序不要靠父程序編號往下找子孫」）。
//
// 兩種漏殺各一個情境，**各帶一個不經 jobrun 的對照**（證明那個情境真的會漏，不然「經 jobrun 殺完 0 個」可能只是情境沒造出來）；
// 殺之前先確認都活著（前置）。另外：結束碼照傳、經 cmd.exe 開（wrangler 那種形狀）、正常結束時留下的子孫也被收掉。
// 數程序用帶標記的指令列（標記在原始碼裡拆開拼：外層的指令列不會含完整的標記，不會把外層數成內層），查詢式自己有對照。
// 只在 Windows 跑（Job Object 是 Windows 的東西）；別的平台照實寫「沒驗」。

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, note } from './tap.mjs';
import { resolveBash } from './resolvebin.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const JOBRUN = path.join(ROOT, 'scripts', 'jobrun.mjs');
const N = process.execPath;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();
const count = (name, like) => Number(ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${name}' -and $_.CommandLine -like '${like}' }).Count`));
const sweep = (name, like) => ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${name}' -and $_.CommandLine -like '${like}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
/** 收拾 sleep 與 bash（一次 PowerShell 呼叫；每開一次 PowerShell 約 1 秒，整支的耗時大半在這裡） */
const sweepSleep = (secs) => ps(`Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'sleep.exe' -or $_.Name -eq 'bash.exe') -and $_.CommandLine -like '*sleep* ${secs}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
const tagOf = (k) => `SDJ${k}${process.pid}${Date.now() % 100000}`;

if (process.platform !== 'win32') {
  note('Job Object 只在 Windows：這個平台沒驗（jobrun 直接跑指令，漏殺沒有處理）');
  done('jobtest');
  process.exit(0);
}

section('數程序的查詢式（對照）');
{
  const t = tagOf('C');
  const outer = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)', ${JSON.stringify(t)} + '-IN'], { stdio: 'ignore' }); setTimeout(()=>{}, 8000);`;
  const p = spawn(N, ['-e', outer, `${t}-OUT`], { stdio: 'ignore' });
  await wait(1500);
  eq([count('node.exe', `* ${t}-OUT`), count('node.exe', `* ${t}-IN`)], [1, 1], '（對照）查詢式：外層、內層各數到 1 個（外層的指令列不會被算成內層）');
  p.kill(); sweep('node.exe', `*${t}*`);
}

section('結束碼照傳');
{
  const r = spawnSync(N, [JOBRUN, N, '-e', 'console.log("job-hi"); process.exit(7)'], { encoding: 'utf8' });
  ok(r.status === 7 && r.stdout.includes('job-hi'), 'Job・結束碼照傳：指令回 7，jobrun 也回 7、輸出照樣傳出來', `回傳 ${r.status}；${r.stderr.slice(0, 200)}`);
}

const BASH = resolveBash();
/** 漏的一：直接那一支經 Git Bash 開 2 個 sleep；用 handle 殺最外層（執行器逾時的殺法） */
async function sleepCase(viaJob) {
  const secs = 6000 + Math.floor(Math.random() * 900) + (viaJob ? 0 : 1000);
  const prog = `require('child_process').spawn(${JSON.stringify(BASH)}, ['-c', 'sleep ${secs} & sleep ${secs} & wait'], { stdio: 'ignore' }); setTimeout(()=>{}, 20000);`;
  const p = spawn(N, viaJob ? [JOBRUN, N, '-e', prog] : ['-e', prog], { stdio: 'ignore' });
  let before = 0;
  for (let i = 0; i < 20 && before < 2; i++) { await wait(500); before = count('sleep.exe', `*sleep* ${secs}*`); }
  p.kill();
  await wait(1000);
  const after = count('sleep.exe', `*sleep* ${secs}*`);
  if (after) sweepSleep(secs);
  return { before, after };
}
section('漏的一：經 Git Bash 開的孫程序（執行器逾時只殺直接那一支）');
{
  const c = await sleepCase(false);
  ok(c.before === 2 && c.after === 2, '（對照）Job・Git Bash：不經 jobrun，殺掉直接那一支之後 2 個 sleep 還活著（這個情境真的會漏）', JSON.stringify(c));
  const j = await sleepCase(true);
  ok(j.before === 2, '（前提）Job・Git Bash：經 jobrun 時，殺之前 2 個 sleep 都活著', JSON.stringify(j));
  ok(j.after === 0, 'Job・Git Bash：經 jobrun，殺掉最外層之後 sleep 一個都不剩', JSON.stringify(j));
}

/** 漏的二：根 → 中間（detached 開目標、自己結束）→ 目標；殺最外層 */
async function detachedCase(viaJob) {
  const t = tagOf(viaJob ? 'J' : 'N');
  const mid = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)', ${JSON.stringify(t)} + '-T'], { stdio: 'ignore', detached: true }); c.unref(); setTimeout(() => process.exit(0), 300);`;
  const root = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(mid)}], { stdio: 'ignore' }); setTimeout(()=>{}, 20000);`;
  const p = spawn(N, viaJob ? [JOBRUN, N, '-e', root] : ['-e', root], { stdio: 'ignore' });
  let before = 0;
  for (let i = 0; i < 20 && before < 1; i++) { await wait(500); before = count('node.exe', `* ${t}-T`); }
  await wait(500);   // 讓中間那一支確實先結束
  p.kill();
  await wait(1000);
  const after = count('node.exe', `* ${t}-T`);
  if (after) sweep('node.exe', `*${t}*`);
  return { before, after };
}
section('漏的二：中間那一支用 detached 開了目標、自己先結束（照父程序編號找不到）');
{
  const c = await detachedCase(false);
  ok(c.before === 1 && c.after === 1, '（對照）Job・detached：不經 jobrun，殺掉最外層之後目標還活著（這個情境真的會漏）', JSON.stringify(c));
  const j = await detachedCase(true);
  ok(j.before === 1, '（前提）Job・detached：經 jobrun 時，殺之前目標活著', JSON.stringify(j));
  ok(j.after === 0, 'Job・detached：經 jobrun，殺掉最外層之後目標不剩（不准脫離 Job）', JSON.stringify(j));
}

section('經 cmd.exe 開（workertest 起 wrangler 的形狀）');
{
  // 經 cmd.exe 開一支小檔（第一版把帶引號、括號的程式碼塞進 cmd 的指令，cmd 看不懂 Node 的跳脫，那支 node 一開就結束——情境沒成立）
  const fs = await import('node:fs');
  const t = tagOf('W');
  const sleeperFile = path.join(ROOT, '.logs', `jobtest-sleeper-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(sleeperFile), { recursive: true });
  fs.writeFileSync(sleeperFile, 'setTimeout(() => {}, 20000);\n');
  // 路徑不加引號（repo 路徑沒有空白）：加了的話 Node 會跳脫成 \"，cmd 不認得，node 拿到壞的檔名就結束（第二版踩到）
  const p = spawn(N, [JOBRUN, 'cmd.exe', '/d', '/s', '/c', `node ${sleeperFile} ${t}-W`], { stdio: 'ignore' });
  let before = 0;
  for (let i = 0; i < 20 && before < 1; i++) { await wait(500); before = count('node.exe', `* ${t}-W`); }
  ok(before === 1, '（前提）Job・cmd.exe：殺之前 cmd 開的那支 node 活著', JSON.stringify({ before }));
  p.kill();
  await wait(1000);
  const after = count('node.exe', `* ${t}-W`);
  if (after) sweep('node.exe', `*${t}*`);
  fs.rmSync(sleeperFile, { force: true });
  ok(after === 0, 'Job・cmd.exe：經 jobrun 開 cmd.exe、它再開 node，殺掉最外層之後 node 不剩', JSON.stringify({ before, after }));
}

section('正常結束時，留下來的子孫也被收掉');
{
  const secs = 6000 + Math.floor(Math.random() * 900) + 2000;
  const prog = `require('child_process').spawn(${JSON.stringify(BASH)}, ['-c', 'sleep ${secs} & sleep ${secs} & wait'], { stdio: 'ignore', detached: true }).unref(); setTimeout(() => process.exit(0), 2500);`;
  const r = spawnSync(N, [JOBRUN, N, '-e', prog], { encoding: 'utf8', timeout: 30000 });
  await wait(1500);
  const after = count('sleep.exe', `*sleep* ${secs}*`);
  if (after) sweepSleep(secs);
  ok(r.status === 0 && after === 0, 'Job・正常結束：指令以 0 結束，它留下的 sleep 也一起被收掉', JSON.stringify({ status: r.status, after }));
}

done('jobtest');
