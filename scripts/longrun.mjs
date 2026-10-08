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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasSummary } from './mutjudge.mjs';
import { descendants, windowsProcessTable, windowsFreeMemoryMB, WORKER_NAMES } from './proctree.mjs';

/**
 * 逐一計數的峰值（scripts/proccount.mjs 寫的事件檔照時間重播）。回傳 { workers, all, events }。
 * 工作程序＝node（每個 node 自己記的「node:」）＋它開的瀏覽器／python；全部＝每一筆。
 * **這個峰值目前不可信，不是「高估、保守一點」**（2026-10-08 改正；以前這裡寫「只會高估」，是錯的註解）：重播是只加不減的形狀——
 * 被硬殺、或被 Job Object 一起收掉的程序不會記「-」，從那一刻起一直算在場上，之後每一刻的數字都被墊高。
 * MealMate 同一個形狀實測過：還記著的 37 支裡 36 支其實早就不在，峰值 41 是假的——偏差大到這個數字沒有意義。本 repo 偏差多少**沒量到**（`.logs/` 沒留下事件檔）。
 * 待辦（照 MealMate 的修法，等本專案解除暫停再排）：結算時逐支核對還記著的那幾支（程序編號＋建立時間），分出「真的還活著」與
 * 「已經不在、但沒收到結束通知」，有後者就把那一次的峰值作廢、不報數字。
 */
export function peakOf(eventsText) {
  const ev = String(eventsText).split('\n').filter(Boolean).map((l) => l.split('\t')).filter((x) => x.length >= 3)
    .map(([t, op, id, name]) => ({ t: Number(t), op, id, name: name || '' }));
  ev.sort((a, b) => a.t - b.t || (a.op === '+' ? -1 : 1));
  const live = new Map();
  let workers = 0, all = 0;
  const isWorker = (id, name) => id.startsWith('node:') || WORKER_NAMES.includes(name) || /chrome|python|msedge/.test(name);
  for (const e of ev) {
    if (e.op === '+') live.set(e.id, e.name); else live.delete(e.id);
    all = Math.max(all, live.size);
    workers = Math.max(workers, [...live].filter(([id, name]) => isWorker(id, name)).length);
  }
  return { workers, all, events: ev.length };
}

/** 讀 log 判定這一輪跑完了沒：只認那支測試自己的結算行。回傳 'done' 或 'not-done'。 */
export function judgeRun(logText, test) {
  return hasSummary(logText, test) ? 'done' : 'not-done';
}

/**
 * 一次取樣的那一行（純函式，測試用合成的程序表驗）。
 * 記憶體拆三份（Dispatch 2026-10-03：遊戲那邊量到最低那一刻，自己的樹 42 MB、其他 node 244 MB、非 node 12,302 MB——
 * 壓力可能主要不是來自我們）：這一次的樹／這棵樹以外的 node／這棵樹以外的非 node。累積幾筆才看得出壓力從哪來。
 */
export function sampleLine(table, rootPid, spawnedAt, freeMB, now = new Date()) {
  const tree = descendants(table, rootPid, spawnedAt);
  const inTree = new Set(tree.map((p) => p.pid));
  const workers = tree.filter((p) => WORKER_NAMES.includes(p.name.toLowerCase()));
  const MB = (list) => Math.round(list.reduce((s, p) => s + (p.mem || 0), 0) / 1024 / 1024);
  const mb = MB(tree);
  const otherNode = MB(table.filter((p) => !inTree.has(p.pid) && p.name.toLowerCase() === 'node.exe'));
  const nonNode = MB(table.filter((p) => !inTree.has(p.pid) && p.name.toLowerCase() !== 'node.exe'));
  return {
    line: `${now.toISOString()}\t工作程序 ${workers.length}\t全部 ${tree.length}\t記憶體 ${mb}MB\t其他 node ${otherNode}MB\t非 node ${nonNode}MB\t系統可用 ${freeMB}MB`,
    workers: workers.length, all: tree.length, mb, otherNode, nonNode,
  };
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
  put(RES, `# ${name} @ ${head}｜每 ${every / 1000} 秒一行｜時間\t工作程序\t全部\t記憶體（這棵樹）\t其他 node\t非 node\t系統可用\n`);
  console.log(`長跑：${name}｜log ${path.relative(ROOT, LOG)}｜資源 ${path.relative(ROOT, RES)}`);

  // 逐一計數：整棵樹的每一個 node 都預先載入 proccount.mjs，事件寫進這一場的 .events.txt
  const EVENTS = path.join(ROOT, '.logs', `${name}-${head}-${stamp}.events.txt`);
  fs.writeFileSync(EVENTS, '');
  const counter = pathToFileURL(path.join(ROOT, 'scripts', 'proccount.mjs')).href;
  const env = { ...process.env, SD_PROCCOUNT: EVENTS, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${counter}`.trim() };
  const spawnedAt = Date.now();
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
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
    put(RES, `# 峰值（取樣）：${peak ? peak.line : '（沒有取到任何一次）'}\n`);
    // 兩種峰值並列：差多少就是取樣漏掉多少（短命的子程序取樣抓不到）
    const counted = peakOf(fs.readFileSync(EVENTS, 'utf8'));
    put(RES, `# 峰值（逐一計數，${counted.events} 筆事件）：工作程序 ${counted.workers}｜全部 ${counted.all}；取樣：工作程序 ${peak ? peak.workers : '—'}｜全部 ${peak ? peak.all : '—'}\n`);
    put(LOG, `峰值：逐一計數 工作程序 ${counted.workers}／全部 ${counted.all}；取樣 工作程序 ${peak ? peak.workers : '—'}／全部 ${peak ? peak.all : '—'}\n`);
    console.log(`長跑：${name} 結束，exit=${code}，${verdict === 'done' ? '跑完' : '沒跑完（不算數）'}，耗時 ${Math.round((Date.now() - spawnedAt) / 1000)} 秒`);
    process.exit(verdict === 'done' ? (code ?? 1) : 3);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
