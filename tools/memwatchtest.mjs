// tools/memwatch.mjs 的情境測試（2026-10-03）。node tools/memwatchtest.mjs；約 30 秒、最多 3 個 node。
// 用 --fake-free 餵可用記憶體，目標是自己開的假程序（指令列帶一個在這裡拼出來的標記）。
// MEMWATCH_FILE＝要測的那一份（突變驗證時指到改壞的複本；預設 tools/memwatch.mjs）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done } from '../scripts/tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCH = process.env.MEMWATCH_FILE || path.join(HERE, 'memwatch.mjs');
const N = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memwatch-'));
const MARK = ['mw', 'target', process.pid].join('-');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** 假目標：活 secs 秒；指令列帶標記 */
function target(secs, tag) {
  const p = spawn(N, ['-e', `setTimeout(() => {}, ${secs * 1000})`, `${MARK}-${tag}`], { stdio: 'ignore' });
  return p;
}
function watch(pid, expect, fake, extra = []) {
  const log = path.join(TMP, `w-${pid}.log`);
  const r = spawnSync(N, [WATCH, '--pid', String(pid), '--expect', expect, '--every', '0.4', '--times', '3', '--min-mb', '2048', '--log', log, '--fake-free', fake, ...extra],
    { encoding: 'utf8', timeout: 90000 });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { code: r.status, out: `${r.stdout}${r.stderr}`, log: text };
}
const samples = (log) => (log.match(/第 \d+ 次：可用/g) ?? []).length;

try {
  section('記憶體監看：連續 3 次才停、單次起伏不停、身分對不上不動手');
  {
    const t = target(60, 'a');
    await new Promise((r) => setTimeout(r, 500));
    ok(alive(t.pid), '（前提）監看・連續低：目標開始時活著');
    const w = watch(t.pid, `${MARK}-a`, '3000,1000,3000,1000,1000,1000');
    await new Promise((r) => setTimeout(r, 500));
    eq(w.code, 10, '監看・連續 3 次低於門檻：回 10（停了目標）', w.out.slice(-400));
    ok(!alive(t.pid), '監看・連續 3 次低於門檻：目標被停掉了');
    ok(samples(w.log) === 6 && /連續 3 次/.test(w.log), '監看・單次起伏不算：第 2、4 次低於門檻都沒停，到第 6 次（連續第 3 次）才停', w.log.slice(-600));
    ok(/前 10 名：\n(.*\n){10}/.test(w.log), '監看・停之前把記憶體用量前 10 名寫進 log', w.log.slice(-800));
    if (alive(t.pid)) t.kill();
  }
  {
    const t = target(15, 'b');   // 每次取樣要開 PowerShell 確認身分（約 1 秒），目標要活夠久才取得到好幾次
    await new Promise((r) => setTimeout(r, 500));
    const w = watch(t.pid, `${MARK}-b`, '3000,1000,1000,3000,1000,1000,3000');
    eq(w.code, 0, '監看・從來沒有連續 3 次低：目標自己結束、回 0、沒動手', w.out.slice(-400));
    ok(samples(w.log) >= 3 && !/記憶體不足/.test(w.log), '（前提）監看・沒連續低：真的取樣了好幾次（不是一開始就結束）', w.log.slice(-400));
  }
  {
    const t = target(30, 'c');
    await new Promise((r) => setTimeout(r, 500));
    const w = watch(t.pid, `${MARK}-不是它`, '1000');
    eq(w.code, 2, '監看・身分對不上（指令列不含 --expect）：回 2、什麼都沒動', w.out.slice(-300));
    ok(alive(t.pid), '監看・身分對不上：目標還活著');
    t.kill();
  }
  {
    const t = target(30, 'd');
    await new Promise((r) => setTimeout(r, 500));
    const w = watch(t.pid, `${MARK}-d`, 'x,x,x');
    eq(w.code, 4, '監看・連續讀不到可用記憶體：回 4（監看失效），不當成記憶體正常', w.out.slice(-300));
    ok(alive(t.pid) && /監看失效/.test(w.log), '監看・讀不到：目標沒被動、log 寫明監看失效', w.log.slice(-300));
    t.kill();
  }
  section('停掉父程序（mutationtest 的位置）之後，jobrun 底下的樹剩幾個（Dispatch 2026-10-03：這一條原本是推論）');
  {
    // 形狀照真的：父程序（扮 mutationtest）用 execFileSync 經 jobrun 開「測試」，測試經 Git Bash 開 2 個孫程序、直接開 1 個子程序。
    // 監看停的是父程序——它**不在** jobrun 的 Job 裡；jobrun 會不會跟著死，靠的是 Node 自己那個「父程序結束就連帶殺」的 Job。
    // 對照：同一個父程序不經 jobrun，停掉之後 Git Bash 開的孫程序還活著（證明這個情境會漏，「經 jobrun 剩 0」才是 Job 的作用）。
    const { resolveBash } = await import('../scripts/resolvebin.mjs');
    const JOBRUN = path.join(HERE, '..', 'scripts', 'jobrun.mjs');
    const BASH = resolveBash();
    const inner = path.join(TMP, 'inner.mjs');
    const parent = path.join(TMP, 'parent.mjs');
    fs.writeFileSync(inner, [
      "import { spawn } from 'node:child_process';",
      'const [bash, tag] = process.argv.slice(2);',
      "const n = process.execPath.split('\\\\').join('/');",
      "spawn(bash, ['-c', `\"${n}\" -e \"setTimeout(()=>{},40000)\" ${tag}-GRAND & \"${n}\" -e \"setTimeout(()=>{},40000)\" ${tag}-GRAND & wait`], { stdio: 'ignore' });",
      "spawn(process.execPath, ['-e', 'setTimeout(()=>{},40000)', `${tag}-CHILD`], { stdio: 'ignore' });",
      'setTimeout(() => {}, 40000);',
      '',
    ].join('\n'));
    fs.writeFileSync(parent, [
      "import { execFileSync } from 'node:child_process';",
      'const [jobrun, inner, bash, tag, mode] = process.argv.slice(2);',
      "const args = mode === 'job' ? [jobrun, process.execPath, inner, bash, tag] : [inner, bash, tag];",
      "try { execFileSync(process.execPath, args, { stdio: 'ignore' }); } catch {}",
      '',
    ].join('\n'));
    const psq = (cmd) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000 }).stdout.trim();
    const countTag = (tag) => {
      const [g, c] = psq(`$a = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '* ${tag}-GRAND' }).Count; $b = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '* ${tag}-CHILD' }).Count; "$a $b"`).split(' ').map(Number);
      return { grand: g, child: c };
    };
    const sweepTag = (tag) => psq(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    const run = async (mode) => {
      const tag = ['MWP', mode, process.pid, Date.now() % 100000].join('');
      const p = spawn(N, [parent, JOBRUN, inner, BASH, tag, mode, `${tag}-PARENT`], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 5000));
      const before = countTag(tag);
      const w = watch(p.pid, `${tag}-PARENT`, '1000');
      await new Promise((r) => setTimeout(r, 4000));
      const after = countTag(tag);
      const parentAlive = alive(p.pid);
      sweepTag(tag);
      return { before, after, code: w.code, parentAlive, log: w.log };
    };
    const c = await run('plain');
    ok(c.before.grand === 2 && c.before.child === 1 && c.code === 10 && !c.parentAlive && c.after.grand === 2,
      '（對照）停父程序・不經 jobrun：監看停了父程序之後，Git Bash 開的 2 個孫程序還活著（這個情境真的會漏）', JSON.stringify({ ...c, log: undefined }));
    const j = await run('job');
    ok(j.before.grand === 2 && j.before.child === 1, '（前提）停父程序・經 jobrun：停之前 2 個孫程序、1 個子程序都活著', JSON.stringify(j.before));
    ok(j.code === 10 && !j.parentAlive, '（前提）停父程序・經 jobrun：監看回 10、父程序真的停了', JSON.stringify({ code: j.code, parentAlive: j.parentAlive }));
    ok(j.after.grand === 0 && j.after.child === 0, '停父程序・經 jobrun：父程序（不在 Job 裡）被停之後，jobrun 底下的子孫剩 0', JSON.stringify(j.after));
  }
  {
    // 真的讀一次系統可用記憶體（不是假數字）：門檻設成 1 MB，一定不會停；取樣行要是正的數字
    const t = target(8, 'e');
    await new Promise((r) => setTimeout(r, 500));
    const log = path.join(TMP, 'real.log');
    const r = spawnSync(N, [WATCH, '--pid', String(t.pid), '--expect', `${MARK}-e`, '--every', '1', '--min-mb', '1', '--log', log], { encoding: 'utf8', timeout: 60000 });
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const m = /第 1 次：可用 (\d+) MB/.exec(text);
    ok(r.status === 0 && m && Number(m[1]) > 0, '監看・真的讀系統可用記憶體：讀得到正的數字、目標自己結束回 0', text.slice(-300));
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
done('memwatchtest');
