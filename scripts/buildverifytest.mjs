// F9 build 驗法登記（scripts/buildverify.mjs）的測試：登記什麼時候寫、什麼時候不寫；推送前的比對什麼時候擋。
//
// 在暫存目錄建一個小 repo：放被守的那幾支（從本 repo 複製）＋工作區的 buildverify.mjs，
// buildtest.mjs 換成**假的**（照 STUB_MODE 印總計、失敗、或跑到一半改檔），幾秒跑完；真的 buildtest 由 buildtest 自己驗。
//
// 三種常設情境（統籌者 2026-09-24：另外兩家各缺過一種，缺的那一種用突變拿掉、其餘情境照樣全過）：
//   · 被守的檔工作區有改動時跑驗法 → 不登記，而且舊登記被刪（先確認舊登記原本在）
//   · 沒動到被守的檔 → 不看登記、放行
//   · 前一個 commit 動到、最後一個乾淨 → 照樣比對、擋下
// 每一條的訊息開頭有固定標籤（「F9 登記・…：」「F9 比對・…：」），突變的 expect 對它。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done } from './tap.mjs';
import { GUARDED } from './buildverify.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'buildverifytest-'));
const W = path.join(T, 'w');
const REG = path.join(W, '.logs', 'build-verified.txt');
const git = (...a) => execFileSync('git', ['-C', W, ...a], { encoding: 'utf8' }).trim();

const STUB = `// 假的 buildtest（buildverifytest 用）
const SCRIPTS = ['build-calendar.mjs', 'build-dividends.mjs', 'build-stocks.mjs', 'buildguard.mjs', 'testfetch.mjs'];
import fs from 'node:fs';
const mode = process.env.STUB_MODE || 'ok';
const sum = (b, c) => '  · 矩陣共 54 格：擋 ' + b + '、碰巧擋下 ' + c + '、沒擋 0';
if (mode === 'fail') { console.log('  ✗ 某一格沒擋'); process.exit(1); }
if (mode === 'nosum') { console.log('buildtest：1 項通過'); process.exit(0); }
if (mode === 'partial') { console.log(sum(53, 1)); process.exit(0); }
if (mode === 'elsewhere') { console.log('說明：' + sum(54, 0)); process.exit(0); }
if (mode === 'touch') fs.appendFileSync(new URL('./buildguard.mjs', import.meta.url), '// 跑的期間改了\\n');
console.log(sum(54, 0));
`;

/** 跑 buildverify：回傳 { code, out, reg（跑完登記檔的內容或 null） }。 */
function bv(args = [], env = {}) {
  const r = spawnSync(process.execPath, ['scripts/buildverify.mjs', ...args], { cwd: W, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, reg: fs.existsSync(REG) ? fs.readFileSync(REG, 'utf8') : null };
}
/** 某個固定開頭的那一行（只認行首；「出現過」不等於「是理由」）。 */
const lineOf = (out, head) => out.replace(/\r/g, '').split('\n').find((l) => l.startsWith(head)) ?? null;
const seed = () => { fs.mkdirSync(path.dirname(REG), { recursive: true }); fs.writeFileSync(REG, 'commit 舊的\n'); return fs.readFileSync(REG, 'utf8') === 'commit 舊的\n'; };
const commitAll = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };

// lineOf 自己的對照（兩個方向）
eq(lineOf('a\n【不登記】x\n', '【不登記】'), '【不登記】x', '（對照）lineOf：行首是那個開頭 → 抽得到');
eq(lineOf('說明：【不登記】x\n', '【不登記】'), null, '（對照）lineOf：只在行中間出現 → 不算');

try {
  execFileSync('git', ['init', '-q', W]);
  git('config', 'user.name', execFileSync('git', ['-C', ROOT, 'config', 'user.name'], { encoding: 'utf8' }).trim());
  git('config', 'user.email', execFileSync('git', ['-C', ROOT, 'config', 'user.email'], { encoding: 'utf8' }).trim());
  git('config', 'core.autocrlf', 'false');
  for (const f of [...GUARDED, 'scripts/buildverify.mjs']) {
    fs.mkdirSync(path.dirname(path.join(W, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(W, f));
  }
  fs.writeFileSync(path.join(W, 'scripts/buildtest.mjs'), STUB);
  fs.writeFileSync(path.join(W, '.gitignore'), '.logs/\n');
  fs.writeFileSync(path.join(W, 'README.md'), '合成的小 repo\n');
  const BASE = commitAll('起點');
  const reset = () => { git('reset', '-q', '--hard', BASE); git('clean', '-fdq', '-e', '.logs'); fs.rmSync(REG, { force: true }); };

  section('登記：什麼時候寫');
  {
    reset();
    const r = bv();
    ok(r.code === 0 && lineOf(r.out, 'build 驗法登記：已寫入') != null, 'F9 登記・乾淨而且全擋：回 0、寫入登記', r.out);
    const lines = (r.reg ?? '').trim().split('\n');
    eq(lines[0], `commit ${BASE}`, 'F9 登記・乾淨而且全擋：登記的是 HEAD 那個 commit');
    eq(lines.slice(1), GUARDED.map((f) => `${f} ${git('rev-parse', `HEAD:${f}`)}`), 'F9 登記・乾淨而且全擋：每一支的雜湊＝HEAD 那一版');
  }

  section('登記：什麼時候不寫（每一種都先放一份舊登記，確認它原本在）');
  const refuse = (label, head, prepare, env = {}) => {
    reset();
    prepare?.();
    const seeded = seed();
    const r = bv([], env);
    ok(seeded, `（前提）${label}跑之前先放了一份舊登記`);
    ok(r.code !== 0 && r.reg == null, `${label}回非 0、舊登記被刪、沒有新登記`, `回傳 ${r.code}；登記 ${JSON.stringify(r.reg)}`);
    ok((lineOf(r.out, '【不登記】') ?? '').startsWith(`【不登記】${head}`), `${label}理由（【不登記】那一行）是「${head}」`, r.out.slice(-400));
  };
  refuse('F9 登記・工作區有改動：', '工作區跟 HEAD 不一樣：js/twse.js', () => fs.appendFileSync(path.join(W, 'js/twse.js'), '// 沒 commit 的改動\n'));
  refuse('F9 登記・驗法沒過：', '驗法沒過', null, { STUB_MODE: 'fail' });
  refuse('F9 登記・沒有全擋：', '驗法沒有全部擋下：矩陣共 54 格，擋 53', null, { STUB_MODE: 'partial' });
  refuse('F9 登記・沒有總計：', '驗法的輸出裡找不到矩陣總計那一行', null, { STUB_MODE: 'nosum' });
  refuse('F9 登記・總計不在該在的位置：', '驗法的輸出裡找不到矩陣總計那一行', null, { STUB_MODE: 'elsewhere' });
  refuse('F9 登記・跑的期間改了檔：', '驗法跑的期間，工作區的檔變了：scripts/buildguard.mjs', null, { STUB_MODE: 'touch' });
  refuse('F9 登記・相依不在清單上：', 'build 或驗法用到、卻不在登記清單上的檔：js/extra.js', () => {
    fs.writeFileSync(path.join(W, 'js/extra.js'), 'export const x = 1;\n');
    fs.appendFileSync(path.join(W, 'scripts/buildguard.mjs'), "import { x } from '../js/extra.js';\n");
    commitAll('多一個相依');
  });
  refuse('F9 登記・清單上的檔不見了：', '登記清單上的檔不存在：js/roc.js', () => {
    ok(git('ls-files', 'js/roc.js') === 'js/roc.js', '（前提）F9 登記・拿掉清單上的檔之前：js/roc.js 原本在（已 commit）');
    fs.rmSync(path.join(W, 'js/roc.js'));
    commitAll('拿掉一支');
  });

  section('推送前的比對（gatepush.sh 的 F9 那一段呼叫這個）');
  const chk = (range) => bv(['--check', range, 'HEAD']);
  const touchBuild = (msg) => { fs.appendFileSync(path.join(W, 'scripts/buildguard.mjs'), `// ${msg}\n`); return commitAll(msg); };
  const other = (msg) => { fs.appendFileSync(path.join(W, 'README.md'), `${msg}\n`); return commitAll(msg); };
  {
    reset();
    other('只改說明');
    const r = chk(`${BASE}..HEAD`);
    ok(r.reg == null, '（前提）F9 比對・沒動到：沒有登記檔');
    ok(r.code === 0 && lineOf(r.out, 'F9：這次要推的 1 個 commit 沒動到') != null, 'F9 比對・沒動到：不看登記、放行', r.out);
  }
  {
    reset();
    touchBuild('改 build');
    const r = chk(`${BASE}..HEAD`);
    ok(r.code !== 0 && lineOf(r.out, '【F9 擋下】這次要推的 commit 動到 scripts/buildguard.mjs，但沒有 build 驗法登記') != null,
      'F9 比對・動到而沒有登記：擋下', r.out);
  }
  {
    reset();
    ok(bv().reg != null, '（前提）F9 比對・前一個 commit 動到：起點那一版登記成驗過');
    touchBuild('改 build');
    other('又疊一個乾淨的');
    eq(git('diff', '--name-only', 'HEAD~1', 'HEAD'), 'README.md', '（前提）F9 比對・前一個 commit 動到：最後一個 commit 只動 README.md');
    const r = chk(`${BASE}..HEAD`);
    ok(r.code !== 0 && lineOf(r.out, '【F9 擋下】build 驗法登記跟要推的版本對不上：scripts/buildguard.mjs') != null,
      'F9 比對・前一個 commit 動到：最後一個乾淨也照樣擋下', r.out);
  }
  {
    reset();
    touchBuild('改 build');
    const reg = bv();
    ok(reg.reg != null, '（前提）F9 比對・登記相符：改完 commit 之後重跑驗法、登記成功', reg.out.slice(-300));
    const r = chk(`${BASE}..HEAD`);
    ok(r.code === 0 && lineOf(r.out, 'F9：這次要推的 commit 動到 scripts/buildguard.mjs，build 驗法登記相符') != null, 'F9 比對・登記相符：放行', r.out);
  }
  {
    reset();
    const r = chk('沒有這個分支..HEAD');
    ok(r.code !== 0 && lineOf(r.out, '【F9 擋下】算不出這次要推哪些 commit') != null, 'F9 比對・範圍算不出：擋下（不當成沒動到）', r.out);
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done('buildverifytest');
