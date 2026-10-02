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
