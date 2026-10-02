// 外部記憶體監看（2026-10-03，Dispatch；照 MealMate 的做法）。不碰閘門、不動 scripts/。
//
//   node tools/memwatch.mjs --pid <要守的程序> --expect <它的指令列一定含的字> [--min-mb 2048] [--every 5] [--times 3] [--log <檔>]
//
// 為什麼：只在每條突變開跑前查一次的記憶體下限，在最需要它的時刻是瞎的——記憶體最低的時候正是一條突變跑到一半
// （MealMate 2026-10-03 16:18 掉到 2,005 MB，下限 2 GB，沒攔到）。這支在外面每 N 秒看一次系統可用記憶體：
//   · **連續 times 次**低於 min-mb 才停（單次會把正常起伏當危險）
//   · 停之前把記憶體用量前 10 名寫進 log
//   · 停的對象只限 --pid 那一個，而且每次動手前都重新確認身分：名稱是 node.exe、指令列含 --expect、建立時間跟開始監看時一樣
//     （PID 被重用時建立時間會不同）。底下的子孫靠 Job Object 收（mutationtest 每支測試都經 scripts/jobrun.mjs 跑），這支不另外找子孫殺
//   · 停完如果留下突變的還原紀錄（scripts/.mutation-pending.json），跑 `node scripts/mutationtest.mjs --restore` 還原
// 回傳：0＝目標自己結束了；10＝記憶體不足、停了目標；2＝用法錯或一開始身分就對不上（什麼都沒動）；
//       4＝連續讀不到可用記憶體（監看失效、自己停下，目標**沒動**——照實記下，不當成「記憶體正常」）。
// --fake-free "3000,1000,…"：測試用，依序回這些數字（x＝讀取失敗），用完就沿用最後一個。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const PID = Number(opt('pid'));
const EXPECT = opt('expect');
const MIN_MB = Number(opt('min-mb', '2048'));
const EVERY = Number(opt('every', '5')) * 1000;
const TIMES = Number(opt('times', '3'));
const LOG = opt('log', path.join(ROOT, '.logs', `memwatch-${new Date().toISOString().slice(0, 10)}-${PID}.log`));
const FAKE = opt('fake-free');
const FAIL_LIMIT = 3;

const stamp = () => new Date().toLocaleString('sv-SE');   // 本機時間（跟其他 log 對得起來）
const log = (msg) => { const l = `${stamp()} ${msg}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };

if (!Number.isInteger(PID) || PID <= 0 || !EXPECT || !(MIN_MB > 0) || !(EVERY > 0) || !(TIMES >= 1)) {
  console.error('用法：node tools/memwatch.mjs --pid <程序> --expect <指令列含的字> [--min-mb 2048] [--every 5] [--times 3] [--log <檔>]');
  process.exit(2);
}
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });

/** 目標現在的身分；不在了回 null。讀不到就丟例外。 */
function identityOf(pid) {
  const out = ps(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "{0}\`t{1}\`t{2}" -f $p.Name, $p.CreationDate.ToUniversalTime().ToString("o"), $p.CommandLine }`).trim();
  if (!out) return null;
  const [name, created, ...cmd] = out.split('\t');
  return { name, created, cmd: cmd.join('\t') };
}

let fakeIdx = 0;
const fakeList = FAKE ? FAKE.split(',') : null;
function freeMB() {
  if (fakeList) {
    const v = fakeList[Math.min(fakeIdx++, fakeList.length - 1)];
    if (v === 'x') throw new Error('（假）讀取失敗');
    return Number(v);
  }
  const kb = Number(ps('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory').trim());
  if (!Number.isFinite(kb) || kb <= 0) throw new Error('讀不到 FreePhysicalMemory');
  return Math.round(kb / 1024);
}

function top10() {
  const out = ps('Get-CimInstance Win32_Process | Sort-Object WorkingSetSize -Descending | Select-Object -First 10 | ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.Name, [math]::Round($_.WorkingSetSize / 1MB) }');
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [pid, name, mb] = l.split('\t'); return `${name}（${pid}）${mb} MB`; });
}

const first = identityOf(PID);
if (!first || first.name.toLowerCase() !== 'node.exe' || !first.cmd.includes(EXPECT)) {
  console.error(`【身分對不上】PID ${PID}：${first ? `${first.name}，指令列${first.cmd.includes(EXPECT) ? '' : '不'}含「${EXPECT}」` : '不在了'}——什麼都沒動`);
  process.exit(2);
}
log(`開始監看 PID ${PID}（${first.name}，建立於 ${first.created}）；可用記憶體連續 ${TIMES} 次低於 ${MIN_MB} MB 才停；每 ${EVERY / 1000} 秒一次`);

let low = 0;
let fails = 0;
let n = 0;
const timer = setInterval(() => {
  n += 1;
  let cur;
  try { cur = identityOf(PID); } catch (e) { cur = undefined; }
  if (cur === null || (cur && cur.created !== first.created)) {   // 自己結束了（或 PID 已被別人重用）
    log(`目標 PID ${PID} 已經結束${cur ? '（PID 被重用：建立時間不同）' : ''}，監看結束；取樣 ${n - 1} 次`);
    clearInterval(timer);
    process.exit(0);
  }
  let mb;
  try { mb = freeMB(); fails = 0; } catch (e) {
    fails += 1;
    log(`第 ${n} 次：讀不到可用記憶體（${String(e?.message ?? e).split('\n')[0]}），連續 ${fails} 次`);
    if (fails >= FAIL_LIMIT) {
      log(`【監看失效】連續 ${fails} 次讀不到可用記憶體，監看自己停下；目標沒動、仍在跑——這段期間沒有記憶體保護`);
      clearInterval(timer);
      process.exit(4);
    }
    return;
  }
  low = mb < MIN_MB ? low + 1 : 0;
  log(`第 ${n} 次：可用 ${mb} MB${low ? `（低於 ${MIN_MB}，連續 ${low} 次）` : ''}`);
  if (low < TIMES) return;
  clearInterval(timer);
  log(`【記憶體不足】連續 ${low} 次低於 ${MIN_MB} MB，停下 PID ${PID}。停之前的前 10 名：`);
  try { for (const l of top10()) log(`  ${l}`); } catch (e) { log(`  （讀不到前 10 名：${String(e?.message ?? e).split('\n')[0]}）`); }
  const again = identityOf(PID);   // 動手前最後一次確認身分
  if (!again || again.created !== first.created || !again.cmd.includes(EXPECT)) {
    log('【沒動手】動手前身分已經對不上（結束了或 PID 被重用）');
    process.exit(10);
  }
  try { process.kill(PID); log(`已停下 PID ${PID}`); } catch (e) { log(`停不下 PID ${PID}：${String(e?.message ?? e).split('\n')[0]}`); }
  const pending = path.join(ROOT, 'scripts', '.mutation-pending.json');
  setTimeout(() => {
    if (fs.existsSync(pending)) {
      try {
        const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mutationtest.mjs'), '--restore'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
        log(`有殘留突變，已還原：${out.trim().split('\n').slice(-1)[0]}`);
      } catch (e) { log(`【還原失敗】${String(e?.message ?? e).split('\n')[0]}——推送閘門會擋（回 6），手動跑 node scripts/mutationtest.mjs --restore`); }
    } else log('沒有殘留突變的還原紀錄');
    process.exit(10);
  }, 3000);
}, EVERY);
