// 長跑的包裝（2026-10-03）：gateselftest 這種要跑幾十分鐘的東西，用這支跑。
//
//   node scripts/longrun.mjs <名稱> <測試名> [--every <毫秒>] -- <指令> [參數…]
//   例：node scripts/longrun.mjs gateselftest gateselftest -- node scripts/gateselftest.mjs
//
// 為什麼（TripQuest 同日撞到的兩件，都是「中斷了卻看起來正常」）：
//   1. **「跑完」只認那支測試自己的結算行**（「<測試名>：N 項通過」，tap.mjs 的 done() 印的），不認「exit=」那一行——
//      外殼被停掉的那一刻還來得及寫下 exit=127，被中斷的那一輪就被記成完成。
//   2. **資源紀錄每取樣一次就寫一行**，不是跑完才寫——跟外殼一起被停掉時，最後才寫就什麼都沒留下。
// 輸出也是每來一段就寫進 .logs/（不留在記憶體裡等最後）。
//
// 資源紀錄量的是**本 repo 這一次開的那棵樹**（不寫「全機」）：工作程序數（node／python／瀏覽器）與全部程序數分開記、
// 它們合計的記憶體、系統可用記憶體。認子孫程序照 scripts/proctree.mjs 防 PID 重用（子程序一定比父程序晚建立）。
// 這支不殺任何程序。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasSummary } from './mutjudge.mjs';
import { descendants, windowsProcessTable, windowsFreeMemoryMB, WORKER_NAMES } from './proctree.mjs';

/** 讀 log 判定這一輪跑完了沒：只認那支測試自己的結算行。回傳 'done' 或 'not-done'。 */
export function judgeRun(logText, test) {
  return hasSummary(logText, test) ? 'done' : 'not-done';
}

/** 一次取樣的那一行（純函式，測試用合成的程序表驗）。 */
export function sampleLine(table, rootPid, spawnedAt, freeMB, now = new Date()) {
  const tree = descendants(table, rootPid, spawnedAt);
  const workers = tree.filter((p) => WORKER_NAMES.includes(p.name.toLowerCase()));
  const mb = Math.round(tree.reduce((s, p) => s + (p.mem || 0), 0) / 1024 / 1024);
  return { line: `${now.toISOString()}\t工作程序 ${workers.length}\t全部 ${tree.length}\t記憶體 ${mb}MB\t系統可用 ${freeMB}MB`, workers: workers.length, all: tree.length, mb };
}

function main() {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  if (dash < 2) { console.error('用法：node scripts/longrun.mjs <名稱> <測試名> [--every <毫秒>] -- <指令> [參數…]'); process.exit(2); }
  const [name, test] = argv;
  const ei = argv.indexOf('--every');
  const every = ei >= 0 && ei < dash ? Number(argv[ei + 1]) : 60000;
  const [cmd, ...args] = argv.slice(dash + 1);
  const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(path.join(ROOT, '.logs'), { recursive: true });
  const LOG = path.join(ROOT, '.logs', `${name}-${head}-${stamp}.log`);
  const RES = path.join(ROOT, '.logs', `${name}-${head}-${stamp}.res.txt`);
  const put = (f, s) => fs.appendFileSync(f, s);
  put(LOG, `開始 ${new Date().toISOString()}，commit ${head}，指令：${[cmd, ...args].join(' ')}\n`);
  put(RES, `# ${name} @ ${head}｜每 ${every / 1000} 秒一行｜時間\t工作程序\t全部\t記憶體（這棵樹）\t系統可用\n`);
  console.log(`長跑：${name}｜log ${path.relative(ROOT, LOG)}｜資源 ${path.relative(ROOT, RES)}`);

  const spawnedAt = Date.now();
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => put(LOG, b.toString()));   // 每來一段就寫（被停掉時，已經寫下的都在）
  child.stderr.on('data', (b) => put(LOG, b.toString()));
  let peak = null;
  const sample = () => {
    try {
      const s = sampleLine(windowsProcessTable(), child.pid, spawnedAt, windowsFreeMemoryMB());
      put(RES, s.line + '\n');                                // 取樣一次就寫一行
      if (!peak || s.workers > peak.workers || (s.workers === peak.workers && s.mb > peak.mb)) peak = s;
    } catch (e) {
      put(RES, `${new Date().toISOString()}\t取樣失敗：${String(e?.message ?? e).split('\n')[0]}\n`);   // 不靜默：失敗也寫一行
    }
  };
  const first = setTimeout(sample, Math.min(5000, every));
  const timer = setInterval(sample, every);
  child.on('close', (code, signal) => {
    clearTimeout(first); clearInterval(timer);
    const verdict = judgeRun(fs.readFileSync(LOG, 'utf8'), test);
    put(LOG, `\n結束 ${new Date().toISOString()}，exit=${code}${signal ? `、signal=${signal}` : ''}，耗時 ${Math.round((Date.now() - spawnedAt) / 1000)} 秒\n`);
    put(LOG, verdict === 'done' ? `判定：跑完（有 ${test} 自己的結算行）\n` : `判定：沒跑完（沒有 ${test} 自己的結算行）——不算數\n`);
    put(RES, `# 峰值：${peak ? peak.line : '（沒有取到任何一次）'}\n`);
    console.log(`長跑：${name} 結束，exit=${code}，${verdict === 'done' ? '跑完' : '沒跑完（不算數）'}，耗時 ${Math.round((Date.now() - spawnedAt) / 1000)} 秒`);
    process.exit(verdict === 'done' ? (code ?? 1) : 3);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
