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
  // 四類自查的每一個分支各有自己的合成樣本（2026-09-25，補充說明（十一）第 3 點：以前 (a) 四種金鑰只測到 gh 一種、
  // (b) 沒有 noreply 的反例、(d) 的 /Users/ 沒有自己的樣本——拿掉那幾個分支，對照組照樣全過）
  const { controlResults } = await import('./precheck.mjs');
  const cr = controlResults('someone-test');
  eq(cr.map((c) => `${c.cat} ${c.label}`), [
    'a gh 權杖', 'a sk-ant 金鑰', 'a AIza 金鑰', 'a xox 權杖',
    'b 一般信箱', 'b noreply@github.com 不算', 'b noreply@anthropic.com 不算', 'b users.noreply.github.com 不算',
    'c 本機使用者名稱',
    'd 磁碟機（反斜線）', 'd 磁碟機（斜線）', 'd /home/ 家目錄', 'd /Users/ 家目錄',
  ], '（前提）自查對照：每個分支一個樣本，登記的 13 個都在（母體用登記制）');
  for (const c of cr) ok(c.ok, `${c.cat} ${c.label}：自查對照判對`);   // 標籤在開頭（突變的 expect 比開頭，2026-10-03）
  // 第五類的語境樣式：每個分支一個樣本（以前一個樣本只打到 9 個分支裡的 3 個）
  const { contextControls } = await import('./piiscan.mjs');
  const pc = contextControls();
  eq(pc.map((c) => c.label), [
    '指認詞「使用者的」', '指認詞「他的」', '指認詞「你的」', '指認詞「Yolin 的」', '指認詞「我的定期定額」',
    '代號 00 開頭', '代號四位數', '金額（沒有千分位）', '沒有指認詞不算', '有指認詞、沒有代號也沒有金額不算',
  ], '（前提）第五類對照：每個分支一個樣本，登記的 10 個都在');
  for (const c of pc) ok(c.ok, `第五類對照：${c.label}：判對`);
  // 真的 git（F10 第 1b 點第 1 種）：正常的 HEAD 放行；GIT_DIR 指向不存在的目錄，真的 git 失敗，要擋
  const realGit = (env) => (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  eq(commitMeta(realGit({}), 'HEAD').problem, null, '自查訊息與作者（必過）：真的 git、真的 HEAD → 放行');
  ok(/git 失敗/.test(commitMeta(realGit({ GIT_DIR: path.join(ROOT, '.logs', 'no-such-git-dir') }), 'HEAD').problem ?? ''),
    '自查訊息與作者：真的 git 失敗（GIT_DIR 指向不存在的目錄）→ 擋', '');
}

// ---------------------------------------------------------------------------
section('殘留突變的還原紀錄（scripts/precheck.mjs 的 pendingRecord；推送閘門、自查、mutationtest 共用）');
{
  // 2026-10-03：突變跑到一半被殺掉，壞檔留在工作區、紀錄還在，以前沒有任何東西擋在 commit 與推送之間；
  // 紀錄壞掉時 mutationtest 刪掉它、當成乾淨。檔案系統當參數傳進去，每一種狀態一個樣本（母體用登記制）。
  const { pendingRecord, pendingMessage, PENDING_REL } = await import('./precheck.mjs');
  const fakeFs = (text) => ({
    exists: (p) => text !== undefined && p.endsWith(PENDING_REL.split('/').join(path.sep)),
    read: () => { if (text instanceof Error) throw text; return text; },
  });
  const st = (text) => pendingRecord('/r', fakeFs(text));
  // 每一種一個固定標籤（共用慣例 §5.9：突變的 expect 比對的是原始碼裡的字面，標籤不能用樣板組出來）
  const PENDING_OK = JSON.stringify({ file: 'js/version.js', content: '原檔', at: '2026-10-03' });
  const PENDING_BAD_JSON = '{"file":"js/vers';
  const SAMPLES = [
    ['殘留突變判斷・沒有紀錄：', undefined, 'none'],
    ['殘留突變判斷・有效紀錄：', PENDING_OK, 'pending'],
    ['殘留突變判斷・紀錄解析不了：', PENDING_BAD_JSON, 'broken'],
    ['殘留突變判斷・紀錄缺欄位：', JSON.stringify({ file: 'js/version.js' }), 'broken'],
    ['殘留突變判斷・紀錄讀不了：', new Error('EACCES'), 'broken'],
  ];
  eq(SAMPLES.length, 5, '（前提）殘留突變：登記的 5 種狀態都有樣本');
  for (const [label, text, want] of SAMPLES) eq(st(text).state, want, `${label}判成 ${want}`);
  ok(st(PENDING_OK).file === 'js/version.js' && st(PENDING_OK).content === '原檔', '殘留突變判斷・有效紀錄：取得出被改壞的檔與原檔內容');
  ok(pendingMessage(st(PENDING_OK)).startsWith('【殘留突變擋下】突變測試上一次跑到一半被殺掉，js/version.js'),
    '殘留突變訊息：有紀錄時點名被改壞的那一支（閘門的驗法用這個開頭比對）');
  ok(pendingMessage(st(PENDING_BAD_JSON)).startsWith('【殘留突變擋下】還原紀錄壞了'), '殘留突變訊息：紀錄壞了時講明是紀錄壞了');
  // 不在這裡斷言「真的工作區沒有紀錄」：mutationtest 跑這支當突變的測試時，紀錄本來就在，會紅錯地方。
  // 推送閘門與自查的真實入口由 gatetest.sh 的 19、19b、19c 在暫存複本裡驗。
}

// ---------------------------------------------------------------------------
section('殘留突變的還原（mutationtest --restore，從命令列入口、在複本裡跑）');
{
  // 2026-10-03：還原這條路以前從沒被觸發過（本機 log 0 次）；紀錄壞了會被刪掉、當成乾淨；先刪紀錄再寫回，
  // 寫回失敗紀錄就沒了。這裡在 .logs/ 底下放一份 scripts 與 js 的複本（工作區的版本，含還沒 commit 的改動），
  // 造出每一種狀態、從命令列入口跑 --restore（只還原、不跑突變；秒級），兩個方向都驗。
  const { spawnSync } = await import('node:child_process');
  const { PENDING_REL } = await import('./precheck.mjs');
  const C = path.join(ROOT, '.logs', `controltest-restore-${process.pid}`);
  const V = path.join(C, 'js', 'version.js');
  const P = path.join(C, PENDING_REL);
  const fresh = () => {
    if (fs.existsSync(V)) fs.chmodSync(V, 0o644);
    fs.rmSync(C, { recursive: true, force: true });
    for (const d of ['scripts', 'js']) fs.cpSync(path.join(ROOT, d), path.join(C, d), { recursive: true });
    fs.rmSync(P, { force: true });   // 工作區自己若有紀錄（例如 mutationtest 正拿這支當突變的測試），不帶進複本
  };
  const restore = () => {
    const r = spawnSync(process.execPath, ['scripts/mutationtest.mjs', '--restore'], { cwd: C, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const putRecord = (text) => {
    fs.writeFileSync(P, text);
    if (fs.readFileSync(P, 'utf8') !== text) throw new Error('還原紀錄沒寫進去，前提沒造成');   // v11.3：造樣本後先讀回
  };
  try {
    // 一、有效的紀錄、檔案真的被改壞 → 寫回原檔、刪紀錄、回 0
    fresh();
    const orig = fs.readFileSync(V, 'utf8');
    fs.writeFileSync(V, orig + '\n// 殘留突變\n');
    putRecord(JSON.stringify({ file: 'js/version.js', content: orig, at: 'controltest' }));
    ok(fs.readFileSync(V, 'utf8') !== orig, '（前提）殘留突變還原・一：檔案真的被改壞了');
    const r1 = restore();
    ok(r1.code === 0 && fs.readFileSync(V, 'utf8') === orig && !fs.existsSync(P),
      '殘留突變還原・一：有紀錄 → 寫回原檔、刪掉紀錄、回 0', `回傳 ${r1.code}；紀錄${fs.existsSync(P) ? '還在' : '已刪'}；${r1.out.slice(-200)}`);
    // 二、沒有紀錄（必過的那個方向）→ 什麼都不動、回 0
    fresh();
    const before = fs.readFileSync(V, 'utf8');
    const r2 = restore();
    ok(r2.code === 0 && r2.out.replace(/\r/g, '').split('\n').some((l) => l.startsWith('--restore：沒有還原紀錄')) && fs.readFileSync(V, 'utf8') === before,
      '殘留突變還原・二（必過）：沒有紀錄 → 不動任何檔、回 0', `回傳 ${r2.code}；${r2.out.slice(-200)}`);
    // 三、紀錄壞了 → 停下（非 0）、講明是紀錄壞了、紀錄留著（閘門與自查才擋得到）
    fresh();
    putRecord('{"file":"js/vers');
    const r3 = restore();
    ok(r3.code !== 0 && r3.out.split('\n').some((l) => l.startsWith('【殘留突變擋下】還原紀錄壞了')) && fs.existsSync(P),
      '殘留突變還原・三：紀錄壞了 → 停下、講明、紀錄留著', `回傳 ${r3.code}；紀錄${fs.existsSync(P) ? '還在' : '被刪了'}；${r3.out.slice(-200)}`);
    // 四、寫回失敗（檔案唯讀）→ 非 0、紀錄留著（以前先刪紀錄再寫回）
    fresh();
    const orig4 = fs.readFileSync(V, 'utf8');
    fs.writeFileSync(V, orig4 + '\n// 殘留突變\n');
    putRecord(JSON.stringify({ file: 'js/version.js', content: orig4, at: 'controltest' }));
    fs.chmodSync(V, 0o444);
    let writable = true;
    try { fs.writeFileSync(V, fs.readFileSync(V, 'utf8')); } catch { writable = false; }
    ok(!writable, '（前提）殘留突變還原・四：檔案真的寫不進去');
    const r4 = restore();
    ok(r4.code !== 0 && fs.existsSync(P),
      '殘留突變還原・四：寫回失敗 → 非 0、紀錄留著', `回傳 ${r4.code}；紀錄${fs.existsSync(P) ? '還在' : '被刪了'}`);
  } finally {
    if (fs.existsSync(V)) fs.chmodSync(V, 0o644);
    fs.rmSync(C, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('突變執行器：逾時判成「情境未成立」（從命令列入口、在複本裡跑一條假突變）');
{
  // 2026-10-03：逾時的 exit code 非 0，沒帶 expect 的突變就被判成「變紅」——gateselftest（實測約 55 分鐘、逾時 15 分鐘）
  // 的兩條突變每次都這樣被記成被抓到。這裡在複本裡把突變清單換成一條假突變（只換資料，判定與迴圈跑的是真的程式），
  // 對一支假測試跑三個方向：逾時 → 不算數；同一條不逾時 → 沒紅（證明上一個「不算數」是逾時造成的）；真的紅 → 紅。
  const { spawnSync } = await import('node:child_process');
  const C = path.join(ROOT, '.logs', `controltest-timeout-${process.pid}`);
  const verLine = /export const APP_VERSION = '[^']+';/.exec(fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8'))?.[0];
  ok(Boolean(verLine), '（前提）逾時對照：找得到 js/version.js 的版本行（假突變要改它）');
  const fakeTest = [
    "import fs from 'node:fs';",
    "import { ok, done } from './tap.mjs';",
    "const v = fs.readFileSync(new URL('../js/version.js', import.meta.url), 'utf8');",
    "if (v.includes('PROBE_SLEEP')) { const t = Date.now(); while (Date.now() - t < 3000) { /* 忙等：模擬跑很久的測試 */ } }",
    "if (fs.existsSync(new URL('./sleeptest.exit0', import.meta.url))) process.exit(0);   // 沒印結算行就以 0 結束",
    "ok(!v.includes('PROBE_RED'), '假測試：版本行沒有 PROBE_RED 標記');",
    "done('sleeptest');",
    '',
  ].join('\n');
  const runFake = (marker, timeoutMs, exit0 = false, expect = null) => {
    fs.rmSync(C, { recursive: true, force: true });
    for (const d of ['scripts', 'js']) fs.cpSync(path.join(ROOT, d), path.join(C, d), { recursive: true });
    fs.rmSync(path.join(C, 'scripts', '.mutation-pending.json'), { force: true });
    fs.writeFileSync(path.join(C, 'scripts', 'sleeptest.mjs'), fakeTest);
    if (exit0) fs.writeFileSync(path.join(C, 'scripts', 'sleeptest.exit0'), '');
    const F = path.join(C, 'scripts', 'mutationtest.mjs');
    let s = fs.readFileSync(F, 'utf8');
    const swap = (a, b) => { if (s.split(a).length !== 2) throw new Error(`逾時對照：mutationtest.mjs 的錨點不是剛好一次：${a.slice(0, 50)}`); s = s.split(a).join(b); };
    const fake = { name: '假突變：逾時對照', why: '驗執行器把逾時判成什麼（controltest）', file: 'js/version.js', find: verLine, replace: `${verLine} // ${marker}`, test: 'sleeptest', ...(expect ? { expect } : {}) };
    swap('  return MUTATIONS;\n})();', `  return [${JSON.stringify(fake)}];\n})();`);
    swap('const TEST_TIMEOUT = { gateselftest: 90 * 60 * 1000 };', `const TEST_TIMEOUT = { gateselftest: 90 * 60 * 1000, sleeptest: ${timeoutMs} };`);
    fs.writeFileSync(F, s);
    if (!fs.readFileSync(F, 'utf8').includes(`sleeptest: ${timeoutMs}`)) throw new Error('逾時對照：假突變沒寫進複本，前提沒造成');   // v11.3：讀回
    const r = spawnSync(process.execPath, ['scripts/mutationtest.mjs'], { cwd: C, encoding: 'utf8', timeout: 120000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  // 一律以行首錨定，不用子字串（MealMate 2026-10-03：✓ 行的訊息裡帶 ✗，被子字串比對當成紅）
  const linesOf = (out) => out.replace(/\r/g, '').split('\n');
  const has = (out, head) => linesOf(out).some((l) => l.startsWith(head));
  /** 以 head 開頭的那一行的下一行（斷言的細節行） */
  const detailOf = (out, head) => { const ls = linesOf(out); const i = ls.findIndex((l) => l.startsWith(head)); return i < 0 ? null : (ls[i + 1] ?? ''); };
  /** 結算分類那一行（tap 的說明行：兩格縮排＋「· 」） */
  const tallyOf = (out) => linesOf(out).find((l) => l.startsWith('  · 結果分開數：')) ?? '';
  // 擷取程式自己的對照（§5.11 第二層，兩個方向）：
  {
    const good = '  ✗ 假突變：逾時對照 → sleeptest 變紅\n      【情境未成立】逾時；重跑了 2 次都沒成立。\n  · 結果分開數：情境成立 0 條（…）；情境未成立 1 條（不算）；過期 0 條';
    const fake = '  ✓ 假突變：逾時對照 說明裡寫著 ✗ 與【情境未成立】逾時；\n      【情境未成立】逾時；重跑了 2 次都沒成立。\n說明：  · 結果分開數：情境成立 0 條';
    ok((detailOf(good, '  ✗ 假突變：逾時對照') ?? '').startsWith('      【情境未成立】逾時；') && tallyOf(good).startsWith('  · 結果分開數：情境成立 0 條'),
      '（對照）逾時對照的擷取：已知的輸出抽得到細節行與分類行');
    ok(detailOf(fake, '  ✗ 假突變：逾時對照') === null && tallyOf(fake) === '' && !has(fake, '  ✗ 假突變'),
      '（對照）逾時對照的擷取：✓ 行訊息裡帶 ✗、說明裡提到同一句，都不算');
  }
  try {
    const a = runFake('PROBE_SLEEP', 1000);
    const aWhat = `回傳 ${a.code}；${a.out.split('\n').filter((l) => /假突變|情境|結果分開數/.test(l)).join(' ⏎ ').slice(0, 400)}`;
    ok((detailOf(a.out, '  ✗ 假突變：逾時對照') ?? '').startsWith('      【情境未成立】逾時；'), '逾時對照・一a：測試逾時 → 判成「情境未成立」，理由是逾時（不是別的）', aWhat);
    ok((detailOf(a.out, '  ✗ 假突變：逾時對照') ?? '').includes('；重跑了 2 次都沒成立。'), '逾時對照・一b：情境沒成立就重跑，到上限（2 次）才放棄', aWhat);
    ok(a.code !== 0 && tallyOf(a.out).startsWith('  · 結果分開數：情境成立 0 條') && tallyOf(a.out).includes('；情境未成立 1 條（不算）；') && !has(a.out, '  ✓ 假突變：逾時對照'),
      '逾時對照・一c：不算紅也不算過（不印 ✓、分開數成「未成立 1」、整支非 0）', aWhat);
    const b = runFake('PROBE_SLEEP', 10000);
    ok((detailOf(b.out, '  ✗ 假突變：逾時對照') ?? '').startsWith('      【沒紅】') && tallyOf(b.out).startsWith('  · 結果分開數：情境成立 1 條'),
      '逾時對照・二（同一條、不逾時）：判成「沒紅」——上一條的「不算數」是逾時造成的', `回傳 ${b.code}；${b.out.split('\n').filter((l) => /假突變|沒紅|結果分開數/.test(l)).join(' ⏎ ').slice(0, 400)}`);
    const c = runFake('PROBE_RED', 10000);
    ok(c.code === 0 && has(c.out, '  ✓ 假突變：逾時對照 → sleeptest 變紅') && tallyOf(c.out).startsWith('  · 結果分開數：情境成立 1 條（紅在對的地方 1、'),
      '逾時對照・三（必過）：真的紅、沒逾時 → 判成紅（這套情境分得出紅）', `回傳 ${c.code}；${c.out.split('\n').filter((l) => /假突變|結果分開數/.test(l)).join(' ⏎ ').slice(0, 400)}`);
    const d = runFake('PROBE_RED', 10000, true);
    ok(d.code !== 0 && has(d.out, '基準就不是綠的') && (detailOf(d.out, '  ✗ sleeptest 在乾淨的程式碼上通過') ?? '').startsWith('      【情境未成立】沒有 sleeptest 自己的結算行')
      && !has(d.out, '  ✓ 假突變：逾時對照') && !has(d.out, '  ✗ 假突變：逾時對照'),
      '逾時對照・四：基準 exit 0 卻沒有結算行（沒跑完）→ 不算通過、停下、一條突變都不跑', `回傳 ${d.code}；${d.out.split('\n').filter((l) => /基準|情境|sleeptest/.test(l)).join(' ⏎ ').slice(0, 400)}`);
    // 預期清單過期（2026-10-03，TripQuest 同日）：expect 在測試裡找不到 → 獨立的結果，不是「紅錯地方」；找得到 → 照常判
    const e = runFake('PROBE_RED', 10000, false, '不存在的標籤：zz');
    ok((detailOf(e.out, '  ✗ 假突變：逾時對照') ?? '').startsWith('      【預期清單過期】') && tallyOf(e.out).includes('；預期清單過期 1 條；')
      && tallyOf(e.out).includes('紅錯地方 0、'),
      '預期清單過期・執行時：expect 在測試裡找不到 → 獨立報成「預期清單過期」、不算紅錯地方', `回傳 ${e.code}；${linesOf(e.out).filter((l) => /假突變|預期清單|結果分開數/.test(l)).join(' ⏎ ').slice(0, 400)}`);
    const f = runFake('PROBE_RED', 10000, false, '假測試：版本行沒有 PROBE_RED 標記');
    ok(f.code === 0 && has(f.out, '  ✓ 假突變：逾時對照 → sleeptest 紅在「假測試：版本行沒有 PROBE_RED 標記」') && tallyOf(f.out).includes('；預期清單過期 0 條；'),
      '預期清單過期・執行時（必過）：expect 找得到 → 照常判紅', `回傳 ${f.code}；${linesOf(f.out).filter((l) => /假突變|預期清單|結果分開數/.test(l)).join(' ⏎ ').slice(0, 400)}`);
  } finally {
    fs.rmSync(C, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('殺程序樹（scripts/proctree.mjs）：只殺我們開的、比父程序晚建立的、名稱在清單裡的');
{
  // 2026-10-03：workertest 以前用 taskkill /PID <殼> /T。PID 被重用時會殺到不相干的程序（JLPT 撞到 OneDrive 的同步服務），
  // /T 自己找子孫也只看父 PID。合成的程序表，每一種情境一個樣本（答案事先寫好）。
  const { pickKillTargets, windowsProcessTable, killTargets } = await import('./proctree.mjs');
  const T0 = Date.parse('2026-10-03T10:00:00Z');
  const ALLOW = ['cmd.exe', 'node.exe', 'workerd.exe'];
  const P = (pid, ppid, name, dt) => ({ pid, ppid, name, created: T0 + dt });
  const tree = [P(100, 1, 'cmd.exe', 0), P(101, 100, 'node.exe', 1000), P(102, 101, 'workerd.exe', 2000)];
  const sorted = (a) => [...a].sort((x, y) => x - y);
  const n = pickKillTargets(tree, 100, T0, ALLOW);
  eq(sorted(n.kill), [100, 101, 102], '殺程序樹・正常的樹：根、子、孫都殺');
  const reuse = pickKillTargets([...tree, P(200, 100, 'OneDrive.exe', -5 * 3600 * 1000), P(201, 100, 'node.exe', -3600 * 1000)], 100, T0, ALLOW);
  ok(!reuse.kill.includes(200) && !reuse.kill.includes(201) && reuse.skipped.some((s) => s.pid === 201 && s.why.includes('比父程序早建立')),
    '殺程序樹・PID 重用的舊程序：記著同一個父 PID、卻比父程序早建立的，就算名稱在清單裡也不殺', JSON.stringify(reuse));
  const notAllowed = pickKillTargets([...tree, P(103, 100, 'conhost.exe', 1000), P(104, 103, 'node.exe', 1500)], 100, T0, ALLOW);
  ok(!notAllowed.kill.includes(103) && !notAllowed.kill.includes(104) && notAllowed.skipped.some((s) => s.pid === 103 && s.why.includes('不在可殺清單')),
    '殺程序樹・不在清單：名稱不在可殺清單的不殺、只印出來，它底下的也不往下認', JSON.stringify(notAllowed));
  const rootReused = pickKillTargets([P(100, 1, 'cmd.exe', 3600 * 1000), P(105, 100, 'node.exe', 3601 * 1000)], 100, T0, ALLOW);
  ok(rootReused.kill.length === 0 && rootReused.why != null, '殺程序樹・根程序被重用：根的建立時刻跟開它的時刻對不上 → 一個都不殺', JSON.stringify(rootReused));
  const rootGone = pickKillTargets([P(101, 100, 'node.exe', 1000), P(102, 101, 'workerd.exe', 2000)], 100, T0, ALLOW);
  eq(sorted(rootGone.kill), [101, 102], '殺程序樹・根程序已結束：殼不在了，開它之後才建立的子孫照樣殺（不留殭屍）');

  // 真的程序表（Windows）：開一個 node 子程序、它再開一個孫程序，挑出來的要剛好是這兩個；殺完兩個都不在
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    const sleeper = 'setTimeout(() => {}, 20000);';
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore' }); ${sleeper}`], { stdio: 'ignore' });
    try {
      let table = [];
      let grand = null;
      for (let i = 0; i < 20 && !grand; i++) {
        await new Promise((r) => setTimeout(r, 250));
        table = windowsProcessTable();
        grand = table.find((p) => p.ppid === child.pid);
      }
      ok(Boolean(grand), '（前提）殺程序樹・真的程序表：讀得到我們開的子程序與它開的孫程序');
      const pick = pickKillTargets(table, child.pid, spawnedAt, ['node.exe']);
      eq(sorted(pick.kill), sorted([child.pid, grand?.pid]), '殺程序樹・真的程序表：挑出來的剛好是我們開的子程序與孫程序');
      ok(!pick.kill.includes(process.pid), '殺程序樹・真的程序表：不含 controltest 自己');
      killTargets(child.pid, spawnedAt, ['node.exe'], { table });
      await new Promise((r) => setTimeout(r, 500));
      const after = windowsProcessTable();
      ok(!after.some((p) => p.pid === child.pid && p.created === table.find((q) => q.pid === child.pid)?.created)
        && !after.some((p) => p.pid === grand?.pid && p.created === grand?.created),
        '殺程序樹・真的程序表：殺完之後子程序與孫程序都不在了（同一個 PID＋同一個建立時刻）');
    } finally {
      if (child.exitCode == null) child.kill();
    }
  }
}

// ---------------------------------------------------------------------------
section('長跑的包裝（scripts/longrun.mjs）：跑完只認結算行、資源紀錄取樣一次就寫一行');
{
  // 2026-10-03（TripQuest 同日）：「看到 exit= 就算跑完」把被停掉的那一輪算成完成；資源紀錄跑完才寫，被停掉就什麼都沒留下。
  const { sampleLine, judgeRun } = await import('./longrun.mjs');
  const T0 = Date.parse('2026-10-03T10:00:00Z');
  const P = (pid, ppid, name, dt, mem = 50 * 1024 * 1024) => ({ pid, ppid, name, created: T0 + dt, mem });
  const s = sampleLine([P(10, 1, 'node.exe', 0), P(11, 10, 'bash.exe', 1000), P(12, 11, 'node.exe', 2000), P(13, 10, 'OneDrive.exe', -3600 * 1000),
    P(20, 1, 'node.exe', -100, 30 * 1024 * 1024)], 10, T0, 4096);
  ok(s.workers === 2 && s.all === 3 && /\t工作程序 2\t全部 3\t記憶體 150MB\t/.test(s.line),
    '長跑資源紀錄・取樣：工作程序只數 node（bash 不算）、PID 重用的舊程序不數進這棵樹', JSON.stringify(s));
  ok(/\t記憶體 150MB\t其他 node 30MB\t非 node 50MB\t系統可用 4096MB$/.test(s.line),
    '長跑資源紀錄・記憶體拆三份：這棵樹／樹外的 node／樹外的非 node（被 PID 重用騙進來的舊程序算在樹外）', s.line);
  eq(judgeRun('…\n結束，exit=127\n', 'x'), 'not-done', '長跑判定・只有 exit= 沒有結算行：判成沒跑完');
  eq(judgeRun('…\nx：12 項通過\n結束，exit=0\n', 'x'), 'done', '長跑判定（必過）・有自己的結算行：判成跑完');

  if (process.platform === 'win32') {
    const { spawn, spawnSync } = await import('node:child_process');
    const { killTargets } = await import('./proctree.mjs');
    const W = path.join(ROOT, '.logs', `controltest-longrun-${process.pid}`);
    fs.rmSync(W, { recursive: true, force: true });
    fs.mkdirSync(W, { recursive: true });
    const fake = path.join(W, 'fake.mjs');
    fs.writeFileSync(fake, [
      "import { spawn } from 'node:child_process';",
      "const mode = process.argv[2];",
      "const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + (mode === 'long' ? 8000 : 2500) + ')'], { stdio: 'ignore' });",
      "kid.on('close', () => { if (mode === 'done') console.log('\\nfakerun：1 項通過'); process.exit(0); });",
      '',
    ].join('\n'));
    const logsOf = (tag) => fs.readdirSync(path.join(ROOT, '.logs')).filter((f) => f.startsWith(`ctl-longrun-${process.pid}-${tag}-`)).map((f) => path.join(ROOT, '.logs', f));
    const read = (tag, ext) => { const f = logsOf(tag).find((x) => x.endsWith(ext)); return f ? fs.readFileSync(f, 'utf8') : ''; };
    const run = (tag, mode) => spawnSync(process.execPath, ['scripts/longrun.mjs', `ctl-longrun-${process.pid}-${tag}`, 'fakerun', '--every', '500', '--', process.execPath, fake, mode], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    try {
      const a = run('a', 'done');
      const resA = read('a', '.res.txt');
      ok(a.status === 0 && read('a', '.log').includes('判定：跑完（有 fakerun 自己的結算行）') && /\t工作程序 [1-9]/.test(resA),
        '長跑・跑完：有結算行 → 判成跑完；跑著的時候資源紀錄記到的工作程序不是 0', `回傳 ${a.status}；${resA.split('\n').slice(0, 3).join(' ⏎ ')}`);
      const b = run('b', 'nodone');
      ok(b.status === 3 && read('b', '.log').includes('判定：沒跑完（沒有 fakerun 自己的結算行）'),
        '長跑・沒有結算行：以 0 結束也判成沒跑完、回 3', `回傳 ${b.status}`);
      // 外殼被停掉：開跑 3 秒後**先殺包裝本身**（用 handle，模擬外殼被停掉；子孫還在跑），已經寫下的取樣要在、不能有判定行、
      // 讀 log 判成沒跑完。讀完才把留下來的子孫清掉。（第一版用 killTargets 由下往上殺：子孫先死，包裝來得及寫判定行——情境沒成立）
      const spawnedAt = Date.now();
      const c = spawn(process.execPath, ['scripts/longrun.mjs', `ctl-longrun-${process.pid}-c`, 'fakerun', '--every', '500', '--', process.execPath, fake, 'long'], { cwd: ROOT, stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 3000));
      c.kill();
      await new Promise((r) => setTimeout(r, 500));
      const resC = read('c', '.res.txt');
      const logC = read('c', '.log');
      killTargets(c.pid, spawnedAt, ['node.exe']);   // 清掉包裝死後留下的假長跑與它的子程序
      ok(resC.split('\n').filter((l) => /\t工作程序 \d/.test(l)).length >= 1 && !logC.includes('判定：') && judgeRun(logC, 'fakerun') === 'not-done',
        '長跑・中途被殺：已經取的樣本都寫進檔了、沒有判定行、讀 log 判成沒跑完', `取樣 ${resC.split('\n').filter((l) => /\t工作程序/.test(l)).length} 行；log 結尾：${logC.slice(-120).split('\n').join(' ⏎ ')}`);
    } finally {
      for (const t of ['a', 'b', 'c']) for (const f of logsOf(t)) fs.rmSync(f, { force: true });
      fs.rmSync(W, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
section('突變挑選器（scripts/affected.mjs）：判斷不出範圍就全跑，不是「沒有關係」');
{
  // 2026-10-03：以前讀不到的檔直接跳過，範圍默默變小（實測：一支中間的模組讀不到，改 js/avgcost.js 從 168 條變成 11 條，
  // 回傳 0、沒有任何訊息）。這裡用假的檔案系統，每一條從寬規則一個樣本；答案事先寫好。
  // （挑選器原本的斷言在 shelltest；shelltest 要開瀏覽器，新的放在這支只用 node 的。）
  const { closureReport, selectWithReason } = await import('./affected.mjs');
  const FS = {
    'scripts/at.mjs': "im" + "port { settle } from '../js/settle.js';",
    'scripts/bt.mjs': "im" + "port { x } from '../js/b.js';",
    // 拆開拼：原樣寫在這支檔裡的話，挑選器掃 controltest 自己時會把這兩段當成它真的 import（誤認成動態路徑與 js/c.js）
    'scripts/dyn.mjs': 'const m = await im' + 'port(`./js/views/${name}.js`);',
    'scripts/ver.mjs': 'const m = await im' + 'port(`./js/c.js${V}`);',
    'js/settle.js': "import { toMicro } from './money.js';",
    'js/money.js': '// 沒有 import',
    'js/b.js': '// 沒有 import',
    'js/c.js': '// 沒有 import',
  };
  const reader = (missing = []) => (rel) => { if (!(rel in FS) || missing.includes(rel)) throw new Error('讀不到：' + rel); return FS[rel]; };
  const MUTS = [
    { name: 'a1', file: 'js/settle.js', test: 'at' },
    { name: 'b1', file: 'js/b.js', test: 'bt' },
  ];
  const pickWith = (read, muts = MUTS, changed = ['js/money.js']) => selectWithReason(muts, changed, (t) => closureReport(`scripts/${t}.mjs`, read));

  const okRead = pickWith(reader());
  ok(!okRead.all && okRead.selected.map((m) => m.name).join() === 'a1' && okRead.reasons.length === 0,
    '判斷得出範圍（必過）：照相依挑、不全跑——改 js/money.js 只挑 a1（at 經由 settle.js 碰得到）', JSON.stringify(okRead));
  const midMissing = closureReport('scripts/at.mjs', reader(['js/settle.js']));
  ok(midMissing.unresolved.some((u) => u.includes('讀不到 js/settle.js')), '判斷不出範圍・讀不到中間的模組：記成理由，不是跳過', JSON.stringify(midMissing));
  const testMissing = closureReport('scripts/不存在.mjs', reader());
  ok(testMissing.unresolved.some((u) => u.includes('讀不到測試檔 scripts/不存在.mjs')), '判斷不出範圍・讀不到測試檔：記成理由', JSON.stringify(testMissing));
  const dyn = closureReport('scripts/dyn.mjs', reader());
  ok(dyn.unresolved.some((u) => u.includes('動態組出來的 import 路徑')), '判斷不出範圍・動態路徑：樣板字串的路徑裡有 ${…}，記成理由', JSON.stringify(dyn));
  const ver = closureReport('scripts/ver.mjs', reader());
  ok(ver.unresolved.length === 0 && ver.modules.includes('js/c.js'), '判斷不出範圍・版本參數不算動態（必過）：`./js/c.js${V}` 的路徑是固定的', JSON.stringify(ver));
  const allRun = pickWith(reader(['js/settle.js']));
  ok(allRun.all && allRun.selected.length === MUTS.length && allRun.reasons.some((r) => r.startsWith('at：讀不到 js/settle.js')),
    '判斷不出範圍 → 全跑：一支測試的範圍算不出來，就全部都跑，並講出是哪一支、為什麼', JSON.stringify(allRun));

  // 從真實入口（命令列，只列不跑）：在 clone 裡改一支 js，--changed --list 要講出全跑與理由
  const { spawnSync } = await import('node:child_process');
  const G = path.join(ROOT, '.logs', `controltest-changed-${process.pid}`);
  try {
    fs.rmSync(G, { recursive: true, force: true });
    const cl = spawnSync('git', ['clone', '-q', ROOT, G], { encoding: 'utf8' });
    if (cl.status !== 0) throw new Error('clone 失敗：' + cl.stderr);
    for (const d of ['scripts', 'js']) fs.cpSync(path.join(ROOT, d), path.join(G, d), { recursive: true });   // 帶上工作區還沒 commit 的改動
    fs.rmSync(path.join(G, 'scripts', '.mutation-pending.json'), { force: true });
    spawnSync('git', ['-C', G, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', G, '-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-qm', 'wt'], { encoding: 'utf8' });
    fs.appendFileSync(path.join(G, 'js', 'money.js'), '\n// controltest：改一行\n');
    const r = spawnSync(process.execPath, ['scripts/mutationtest.mjs', '--changed', '--list'], { cwd: G, encoding: 'utf8', timeout: 60000 });
    const out = `${r.stdout}${r.stderr}`;
    const ls = out.replace(/\r/g, '').split('\n');
    const why = ls.find((l) => l.startsWith('  · 判斷不出範圍 → 全跑（')) ?? '';
    ok(r.status === 0 && ls.some((l) => l.startsWith('  ✓ git 說改到了 1 個檔：js/money.js')) && why.includes('dcatest：scripts/dcatest.mjs 有動態組出來的 import 路徑')
      && !ls.some((l) => l.startsWith('— 基準：')),
      '判斷不出範圍・真實入口：--changed --list 在現在的 repo 上講出「全跑」與理由（dcatest 的動態路徑），而且沒有跑基準',
      `回傳 ${r.status}；${out.split('\n').filter((l) => /git 說|判斷不出|只列不跑|基準/.test(l)).join(' ⏎ ').slice(0, 500)}`);
  } finally {
    fs.rmSync(G, { recursive: true, force: true });
  }
}

done('controltest');
