// 不在 npm test 裡的檢查器，它們的「判斷邏輯自己有沒有壞」每版在這裡跑（npm run controltest；在 npm test 鏈裡）。
//
// 為什麼要這支（SPEC_檢查器修補 F1）：assertaudit（9 分鐘、手動）這類檢查器很久才跑一次；
// 它們的判斷邏輯壞掉時，以前沒有任何東西會發現（v9 盤點實測：篩選條件改壞，報告照樣回 0）。
// 判斷邏輯抽成模組、在這裡用合成樣本跑——跟那支檢查器自己開頭跑的是同一組對照、同一段程式。
//
// 每一組對照用**寫死的標籤**斷言（共用慣例 §5.9：突變的 expect 要有固定的錨點），
// 而且逐一點名：哪一組對照不見了，那一條就紅（不能靠「全部都 ok」——少一組也是全部都 ok）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done } from './tap.mjs';
import { controls as auditControls, chainOf, auditOrphans } from './auditjudge.mjs';
import { controls as sweepControls } from './sweepjudge.mjs';
import { controls as liveControls, stageControls as liveStageControls, endpointsIn, endpointOrphans } from './livejudge.mjs';
import { controls as routeControls, registeredRoutes, routeOrphans } from './routes.mjs';
import { selftest as gateReasonSelftest } from './gatereason.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const expectEach =(tool, results, labels) => {
  ok(results.length === Object.keys(labels).length,
    `（前提）${tool} 的對照組有 ${results.length} 組，登記的是 ${Object.keys(labels).length} 組`);
  for (const [key, label] of Object.entries(labels)) {
    const c = results.find((r) => r.key === key);
    ok(c?.ok === true, label, c ? c.detail : `對照組「${key}」不見了`);
  }
};

section('assertaudit 的判斷邏輯（scripts/auditjudge.mjs）');
expectEach('assertaudit', auditControls(), {
  fail: 'assertaudit 對照一：一條一定失敗的斷言，要判成紅了但資料有寫出來',
  empty: 'assertaudit 對照二：空母體的 noneOf，它那一筆要被母體 ≤ 2 挑出來',
  crash: 'assertaudit 對照三：寫出資料前就崩掉，要判成沒收到任何資料',
  clean: 'assertaudit 對照四（必過）：母體 3 的乾淨測試，要判成通過、不被挑出來',
  'orphan-missing': 'assertaudit 對照五：鏈上多了一支沒登記的，要報出它',
  'orphan-stale': 'assertaudit 對照六：清單裡有一支不在鏈上，要報出它',
  'orphan-skip-stale': 'assertaudit 對照七：不收的理由寫給不在鏈上的，要報出它',
  'orphan-clean': 'assertaudit 對照八（必過）：鏈上全部登記或寫了理由，什麼都不報',
});

// 孤兒檢查（S5，F4）：assertaudit 的清單要涵蓋 npm test 鏈上的每一支——以前 v9 新加進鏈的兩支沒補進去，沒有東西會發現。
// 跟上面對照五到八同一段程式（auditjudge.mjs 的 chainOf、auditOrphans）。
section('assertaudit 的清單 ＝ npm test 鏈（孤兒檢查）');
const chain = chainOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test);
ok(chain.length >= 30, `（前提）從 package.json 的 npm test 取到 ${chain.length} 支`);
const orphans = auditOrphans(chain);
eq(orphans.missing, [], 'assertaudit 孤兒：npm test 鏈上的每一支，都在 assertaudit 的清單裡或寫了不收的理由');
eq(orphans.stale, [], 'assertaudit 過期：assertaudit 清單裡的每一支都還在 npm test 鏈上');
eq(orphans.skipStale, [], 'assertaudit 理由過期：寫了不收理由的每一支都還在 npm test 鏈上');

section('sweep 的判斷邏輯（scripts/sweepjudge.mjs；合成回應，不打網路）');
expectEach('sweep', sweepControls(), {
  'sw-old': 'sweep 對照一：線上 sw.js 是舊版，版本比對要報 sw.js',
  'html-old': 'sweep 對照二：線上 index.html 載入舊版，版本比對要報 index.html',
  'sw-missing': 'sweep 對照三：sw.js 讀不到版本，要報、不能當成一致',
  'cache-stale': 'sweep 對照四：還留著舊版的快取，要挑出那一個',
  'real-error': 'sweep 對照五：不是新聞上游的錯誤，要算進真的錯誤',
  clean: 'sweep 對照六（必過）：全部一致、只有新聞上游 502，什麼都不報',
});

section('livecheck 的判斷邏輯（scripts/livejudge.mjs；錄好的回應，不打證交所）');
expectEach('livecheck', liveControls(), {
  cors: 'livecheck 對照一：CORS 標頭不見，要報',
  sda: 'livecheck 對照二：STOCK_DAY_ALL 的表裡少了 2330，要報',
  sd: 'livecheck 對照三：STOCK_DAY 的除權息標記不見，要報',
  otc: 'livecheck 對照四：上櫃代號查得到資料了，要報',
  t48u: 'livecheck 對照五：TWT48U 的欄位改名，要報格式變了',
  refprice: 'livecheck 對照六：參考價跟公式差 0.01，要挑出那一筆',
  calendar: 'livecheck 對照七：證交所那個月少一個交易日，要報出是哪一天',
  stocks: 'livecheck 對照八：市場上多了一檔代號表沒有的，要報出那一檔',
  gaps: 'livecheck 對照九：請求間隔不到 2 秒或一個都沒量到，要報',
  'calendar-closed': 'livecheck 對照十：日曆休市日多年格式要讀得到、認不得的格式要拋錯',
  fmtqik: 'livecheck 對照十二：FMTQIK 的欄位改名，要報格式變了',
  endpoints: 'livecheck 對照十三：app 多用一個沒登記的端點要報、登記了卻沒打的也要報',
});
{
  // 端點的孤兒檢查（範圍外發現第 2 件）：app 端用到的證交所端點，每一個都要登記、而且 livecheck 真的有打
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) files.push(p); } };
  walk('js');
  for (const f of ['sw.js', 'worker/src/index.js']) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  const appEps = [...new Set(files.flatMap((f) => endpointsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))))];
  ok(appEps.length >= 4, `（前提）app 端 ${files.length} 支檔用到 ${appEps.length} 個證交所端點：${appEps.join('、')}`);
  const o = endpointOrphans(appEps, fs.readFileSync(path.join(ROOT, 'scripts/livecheck.mjs'), 'utf8'));
  eq(o.missing, [], '端點孤兒：app 用到的每一個證交所端點都登記了（或寫了不打的理由）');
  eq(o.notChecked, [], '端點沒打：登記的每一個端點 livecheck 都真的有打');
  eq(o.skipStale, [], '端點理由過期：寫了不打理由的每一個，app 都還在用');
}
expectEach('livecheck 段落', await liveStageControls(), {
  stages: 'livecheck 對照十一：中間一段崩了，要記成那一段失敗、講出段名，後面照跑',
});

section('逐頁清單（scripts/routes.mjs；sweep 與 upgradecheck 共用）＝ js/app.js 註冊的路由（孤兒檢查）');
expectEach('路由清單', routeControls(), {
  clean: '路由對照一（必過）：註冊的全部登記或寫了理由，什麼都不報；註解裡的 route 不算',
  missing: '路由對照二：多註冊一條沒登記的，要報出它',
  stale: '路由對照三：清單裡有一條沒註冊的，要報出它',
  'skip-stale': '路由對照四：不巡的理由寫給沒註冊的，要報出它',
});
{
  const reg = registeredRoutes(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  ok(reg.length >= 7, `（前提）從 js/app.js 取到 ${reg.length} 條註冊的路由`);
  const o = routeOrphans(reg);
  eq(o.missing, [], '路由孤兒：js/app.js 註冊的每一條路由，都在逐頁清單裡或寫了不巡的理由');
  eq(o.stale, [], '路由過期：逐頁清單裡的每一條都還註冊著');
  eq(o.skipStale, [], '路由理由過期：寫了不巡理由的每一條都還註冊著');
}

// 推送閘門驗法的「擋下理由」比對（補充說明（四）第 1 點）：gatetest 一分鐘、不是每版跑，比對程式一改壞，每版在這裡就看得到
section('推送閘門驗法的理由比對（scripts/gatereason.mjs）：只在錯誤訊息的位置比，兩個方向');
{
  const r = gateReasonSelftest();
  ok(r.length >= 10, `（前提）理由比對的對照有 ${r.length} 組`);
  for (const c of r) ok(c.ok, `閘門理由比對：${c.name}`);
}

// ---------------------------------------------------------------------------
section('公開前自查取 commit 訊息與作者欄（scripts/precheck.mjs 的 commitMeta）：有 commit 卻取不到就是檢查器壞了');
{
  // 2026-09-24：MealMate 與統籌者的自查各中一次——有 commit 卻取不到訊息與作者欄，被當成「0 命中、通過」。
  // 「執行 git」的函式當參數傳進去（F10 第 1b 點第 2 種），才能只讓其中一個子指令失敗、或只回空的。
  const { commitMeta } = await import('./precheck.mjs');
  const { execFileSync } = await import('node:child_process');
  const two = '訊息一\n作者：甲 <a@x>\n提交者：甲 <a@x>\n\n訊息二\n作者：乙 <b@x>\n提交者：乙 <b@x>\n';
  const fake = (count, log) => (args) => {
    if (args[0] === 'rev-list') { if (count instanceof Error) throw count; return `${count}\n`; }
    if (args[0] === 'log') { if (log instanceof Error) throw log; return log; }
    throw new Error(`沒料到的 git 指令：${args.join(' ')}`);
  };
  const r = (count, log, rev = 'a..b') => commitMeta(fake(count, log), rev);
  ok(r(2, two).problem === null && r(2, two).lines.length === 6, '自查訊息與作者（必過）：2 個 commit、取到 2 組作者與提交者 → 放行、6 行', JSON.stringify(r(2, two)));
  ok(r(0, '').problem === null, '自查訊息與作者（必過）：範圍裡 0 個 commit、取到空的 → 放行（沒有東西要推）', JSON.stringify(r(0, '')));
  ok(/有 2 個 commit，卻取到 0 個作者欄/.test(r(2, '').problem ?? ''), '自查訊息與作者：有 commit 卻取到空的 → 擋（檢查器壞了）', JSON.stringify(r(2, '')));
  ok(/有 2 個 commit，卻取到 1 個作者欄/.test(r(2, '訊息\n作者：甲 <a@x>\n提交者：甲 <a@x>\n').problem ?? ''), '自查訊息與作者：只取到一部分 → 擋', '');
  ok(/git 失敗/.test(r(2, new Error('log 壞了')).problem ?? ''), '自查訊息與作者：取訊息的 git 失敗 → 擋並講明（不丟給外層當崩潰）', JSON.stringify(r(2, new Error('x'))));
  ok(/git 失敗/.test(r(new Error('rev-list 壞了'), two).problem ?? ''), '自查訊息與作者：數 commit 的 git 失敗 → 擋', '');
  ok(/算不出/.test(r('不是數字', two).problem ?? ''), '自查訊息與作者：commit 數算不出來 → 擋', '');
  {
    const seen = [];
    commitMeta((args) => { seen.push(args.join(' ')); return args[0] === 'rev-list' ? '1' : '作者：甲 <a@x>\n提交者：甲 <a@x>\n'; }, 'HEAD');
    ok(seen.length === 2 && seen.every((s) => s.includes('-1 HEAD')), '自查訊息與作者：單一 commit 兩個子指令都只看那一個（-1）', JSON.stringify(seen));
  }
  // 真的 git（F10 第 1b 點第 1 種）：正常的 HEAD 放行；GIT_DIR 指向不存在的目錄，真的 git 失敗，要擋
  const realGit = (env) => (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  eq(commitMeta(realGit({}), 'HEAD').problem, null, '自查訊息與作者（必過）：真的 git、真的 HEAD → 放行');
  ok(/git 失敗/.test(commitMeta(realGit({ GIT_DIR: path.join(ROOT, '.logs', 'no-such-git-dir') }), 'HEAD').problem ?? ''),
    '自查訊息與作者：真的 git 失敗（GIT_DIR 指向不存在的目錄）→ 擋', '');
}

done('controltest');
