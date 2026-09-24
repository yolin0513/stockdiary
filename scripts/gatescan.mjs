// 掃推送閘門、公開前自查、閘門驗法有沒有已知的壞寫法（npm run gatescan；在 npm test 鏈裡）。
//
// 為什麼（共用慣例 v9 §5.16）：規則寫下、親手修過三次，下一次寫新程式還是會寫出舊寫法
// ——本 App 2026-09-24 深夜就是這樣（STATUS 接手者第 44 條）。所以已知的壞寫法做成機器掃，不靠記得。
//
// 母體是**登記制**（§5.2）：下面 FILES 寫死要掃哪幾支。新增閘門、自查、驗法的腳本要自己加進來。
// 每一種寫法都有對照組（§5.3）：當場組出來的合成樣本，加上本 App **真的出過事的原文**，必須被抓到；
// 另有乾淨的反例不能被抓到。對照組沒過就停，講明是「檢查器壞了」。
// 初篩類的命中（「不存在」的斷言、命令列上帶反斜線的樣式）逐條看過，確認是合理的寫進 EXCEPTIONS 並寫理由；
// 登記的例外如果對不到任何命中（程式改了、例外過期），也算失敗——例外不能默默留著。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, note } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---- 登記：要掃的檔（§5.2 登記制，不是「scripts/ 全部扣掉例外」）----
const FILES = ['scripts/gatepush.sh', 'scripts/precheck.mjs', 'scripts/piiscan.mjs', 'scripts/gatetest.sh', 'scripts/gateselftest.mjs', 'scripts/gatereason.mjs', 'scripts/buildverify.mjs', 'scripts/buildverifytest.mjs'];

// ---- 規則 ----
// 每一條：id、說明、scope（'sh'｜'mjs'｜'all'）、line(行) → 命中與否；或 file(全文) → 命中與否（檔案層級的規則）
// 不分大小寫：閘門裡是用變數呼叫的（`node "$PRECHECK" …`）。第一版分大小寫，對照組放的原文是小寫的
// `precheck.mjs` 所以照樣全過，卻漏掉閘門裡真正會出現的寫法——把一行壞寫法放進 gatepush.sh 的突變才抓出來（2026-09-24）。
const KEY_CMD = /(precheck|piiscan|gatepush|git\s+(?:-C\s+\S+\s+)?(?:push|fetch|ls-remote|log|diff|show))\b/i;
const isComment = (l) => /^\s*#/.test(l) || /^\s*\/\//.test(l);
const RULES = [
  {
    id: 'pipe', scope: 'sh',
    what: '自查、推送、取遠端狀態、取 diff 的那一行後面接管線（前一步失敗會被吞掉）',
    // 單一個 |（不是 ||），而且同一行有關鍵指令出現在它前面
    line: (l) => !isComment(l) && /[^|]\|[^|]/.test(l) && KEY_CMD.test(l.split(/[^|]\|[^|]/)[0]),
  },
  {
    id: 'or-true', scope: 'all',
    what: '自查或閘門裡的 `|| true`（失敗照樣當成功）',
    line: (l) => !isComment(l) && /\|\|\s*true\b/.test(l),
  },
  {
    id: 'empty-catch', scope: 'all',
    what: '空的 catch（錯誤被吞成「沒事」）',
    line: (l) => !isComment(l) && /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(l),
  },
  {
    id: 'plus3-header', scope: 'all',
    what: '用「以 +++ 開頭」判斷 diff 檔頭（內容以 ++ 開頭的新增行會被一起丟掉）',
    line: (l) => !isComment(l) && /startsWith\(\s*['"]\+\+\+['"]\s*\)|\^\\\+\\\+\\\+|['"]\+\+\+['"]/.test(l),
  },
  {
    id: 'format-no-meta', scope: 'all',
    what: '用 --format= 取 diff（-p 或 git show），整支卻沒有另外取 commit 訊息與作者欄（%B、%ae）',
    file: (text) => {
      const takesDiff = text.split('\n').some((l) => !isComment(l) && /--format=/.test(l)
        && /(['"\s])-p(['"\s,]|$)|--patch|\bshow\b/.test(l) && !/--numstat/.test(l));
      return takesDiff && !(text.includes('%B') && text.includes('%ae'));
    },
  },
  {
    id: 'absent-assert', scope: 'all', screen: true,
    what: '（初篩）斷言「不存在／不見了」——要逐條確認前面有沒有先確認它原本在',
    line: (l) => !isComment(l) && /!\s*(fs\.)?existsSync\(|\[\s*!\s*-[efsd]\s|不見|已刪/.test(l),
  },
  {
    id: 'shell-backslash', scope: 'sh', screen: true, multiline: true,
    what: '（初篩）grep／sed／node -e 的樣式含反斜線、寫在 shell 指令列上——要確認同一次執行裡跑過對照組',
    // 比對的是「一整個指令」：引號跨好幾行的（例如 node -e "…" 寫成好幾行），要接起來再看——
    // 第一版逐行比對，反斜線落在第二行以後就看不到（2026-09-24，登記的例外對不到命中才發現）
    line: (l) => !isComment(l) && /\b(grep|sed|node\s+-e)\b/.test(l) && /\\/.test(l),
  },
];

// 把 shell 腳本切成「指令」：一行裡雙引號沒配對（跨行的字串）就接到下一行，直到配對為止。回傳 [{ start, text }]
function shellCommands(text) {
  const out = [];
  const lines = text.split('\n');
  const openQuotes = (l) => (l.replace(/\\./g, '').match(/"/g) || []).length % 2 === 1;
  for (let i = 0; i < lines.length; i += 1) {
    let cmd = lines[i];
    const start = i;
    let open = openQuotes(lines[i]);
    while (open && i + 1 < lines.length) { i += 1; cmd += '\n' + lines[i]; if (openQuotes(lines[i])) open = false; }
    out.push({ start: start + 1, text: cmd });
  }
  return out;
}

// ---- 登記的例外（初篩命中逐條看過之後才列進來，每一條要寫理由）----
const EXCEPTIONS = [
  {
    file: 'scripts/gatetest.sh', rule: 'absent-assert', lineIncludes: 'die "情境 12：build 登記原本就在，前提沒造成"',
    why: '這是前提斷言「原本不在」（情境 12 要驗的是沒有登記時擋下），不是斷言「某個東西被刪掉了」；prep 每一種都先刪登記，這一行確認刪到了。',
  },
  {
    file: 'scripts/gatetest.sh', rule: 'absent-assert', lineIncludes: 'die "情境 12d：build 登記原本就在，前提沒造成"',
    why: '同上：情境 12d 的前提是「沒有登記」，這一行是確認前提成立，不是斷言被刪掉。',
  },
  {
    file: 'scripts/buildverify.mjs', rule: 'absent-assert', lineIncludes: 'const missing = GUARDED.filter((f) => !fs.existsSync(',
    why: '檢查器自己的故障停下：登記清單上的檔不在就不登記。情境在 buildverifytest「清單上的檔不見了」（先 commit 過、再拿掉）。',
  },
  {
    file: 'scripts/buildverify.mjs', rule: 'absent-assert', lineIncludes: 'if (!fs.existsSync(REG)) stop(',
    why: '沒有登記就擋（故障時停下，不放行）；情境在 buildverifytest「動到而沒有登記」與 gatetest 情境 12。',
  },
  {
    file: 'scripts/buildverifytest.mjs', rule: 'absent-assert', lineIncludes: "refuse('F9 登記・清單上的檔不見了：'",
    why: '初篩命中的是情境名稱裡的「不見」。前提「原本在」有明確斷言（下一行的 ls-files），再拿掉、commit。',
  },
  {
    file: 'scripts/piiscan.mjs', rule: 'absent-assert', lineIncludes: 'if (!existsSync(LIST)) {',
    why: '這不是驗證斷言，是檢查器自己的故障停下：黑名單檔不在就擋。它的反面情境（先確認在、再拿走）在 gatetest 情境 2c。',
  },
  {
    file: 'scripts/gatetest.sh', rule: 'absent-assert', lineIncludes: 'run "2c. 黑名單檔不見"',
    why: '初篩命中的是情境名稱裡的「不見」。這一條的前提（黑名單檔原本在）沒有明確斷言，已列進 v9 回報的盤點結果；'
      + '目前靠同一支驗法的 2b 與 5（需要黑名單檔在才會符合）間接證明它原本在。',
  },
  {
    file: 'scripts/gatetest.sh', rule: 'shell-backslash', lineIncludes: 'node -e "',
    why: '造「對照組壞掉」複本的 node -e 帶跳脫的引號。錨點對不上時 node 以 9 結束，驗法記一條不符；'
      + '造出來的複本若不對，2a／2b 比對的擋下理由也對不上而報不符——同一次執行裡有對照。',
  },
  {
    file: 'scripts/gatetest.sh', rule: 'shell-backslash', lineIncludes: "grep -m1 -E '^docs/",
    why: '情境 9 挑一個要刪的檔。樣式若被 shell 改壞而一個都抓不到，LAST 是空字串，下一行 `[ -n "$LAST" ] || die` 讓驗法中止——'
      + '不會默默放行；挑到的檔再由情境 9 的前置（numstat 讀成 0）確認真的是只刪不增。',
  },
];

// ---- 對照組（§5.3）：合成樣本＋本 App 真的出過事的原文；反例不能被抓到 ----
// 原文照當時的寫法抄，只把路徑換成泛稱；字串拆開拼，這支檔自己才不會被自己抓到（它不在 FILES 裡，但規則改了可能會被加進去）。
const P = '|';
const CONTROLS = {
  pipe: {
    hit: [
      // 真的出過事：推送前那一行，自查失敗被 tail 吞掉（2026-09-23 以前每次推送都這樣寫）
      'node "$S/precheck.mjs" HEAD ' + P + ' tail -1 && git push -q origin main',
      'node "$S/precheck.mjs" HEAD ' + P + ' tail -3 && git push -q origin main',
      // 真的出過事：情境 9 第一版的前置，git show 失敗 awk 照樣印 0（2026-09-24 深夜，寫完當下發現）
      '[ "$(git show --numstat --format= HEAD ' + P + " awk '{s+=$1} END {print s+0}')\" = \"0\" ]",
      // 合成：照閘門的寫法用變數呼叫自查（第一版分大小寫，漏掉這種）
      'node "$PRECHECK" "$RANGE" ' + P + ' tail -1 && git push -q "$REMOTE" "$BRANCH"',
      // 合成：推送本身後面接管線、取遠端狀態接管線
      'git push -q origin main 2>&1 ' + P + ' tail -1',
      'REMOTE_SHA="$(git ls-remote origin refs/heads/main ' + P + ' cut -f1)"',
    ],
    miss: [
      'git -C "$ROOT" push -q "$REMOTE" "$BRANCH" > "$OUT.push" 2>&1',
      '[ "$A" -ne 0 ] ' + P + P + ' [ "$B" -ne 0 ]',
      'LAST="$(git ls-files ' + P + " grep -m1 -E '^docs/')\"",
    ],
  },
  'or-true': {
    hit: ['node scripts/precheck.mjs HEAD ' + P + P + ' true', 'git fetch -q origin main ' + P + P + ' true'],
    miss: ['git fetch -q origin main ' + P + P + ' exit 1', 'const truth = a ' + P + P + ' b;'],
  },
  'empty-catch': {
    hit: ['try { run(); } catch {}', 'try { run(); } catch (e) { }'],
    miss: ['try { run(); } catch (e) { process.exit(1); }', '} catch { return null; }'],
  },
  'plus3-header': {
    hit: [
      // 真的出過事：舊 precheck 抽新增行（2026-09-24 以前）
      "const addedLines = raw.split('\\n').filter((l) => l.startsWith('+') && !l.startsWith('" + '++' + "+'));",
      "grep -v '^" + '\\+\\+' + "\\+'",
    ],
    miss: ["if (l.startsWith('@@')) { inHunk = true; continue; }", "if (inHunk && l.startsWith('+')) out.push(l);"],
  },
  'format-no-meta': {
    hit: [
      // 真的出過事：舊 precheck 取 diff 的寫法，整支沒有取訊息與作者（2026-09-24 以前）
      "const raw = execFileSync('git', ['-C', ROOT, 'show', rev, '--format=', '--unified=0']);",
      "const raw = execFileSync('git', ['-C', ROOT, 'log', '-p', '--format=', '--unified=0', rev]);",
    ],
    miss: [
      "const raw = git(['log', '-p', '--format=', rev]);\nconst meta = git(['log', '--format=%B%n%an <%ae>', rev]);",
      'git show --numstat --format= HEAD > "$T/ns9.txt"',
    ],
  },
  'absent-assert': {
    hit: ['ok(!fs.existsSync(reg), "登記檔不見了");', 'if [ ! -f "$REG" ]; then echo 已刪; fi'],
    miss: ['ok(fs.existsSync(reg), "登記檔還在");', '[ -s "$T/ns9.txt" ]'],
  },
  'shell-backslash': {
    hit: [
      // 真的出過事：用 node -e 造突變，錨點的反斜線被 shell 改寫、突變沒套上（2026-09-24）
      'node -e "const a=\\"const metaLines = metaRaw.split(\'\\\\\\\\n\')\\";"',
      "grep -E '^\\s+find:' scripts/x.mjs",
      "sed -n 's/\\(a\\)/b/p' x",
      // 跨行：反斜線落在第二行（逐行比對看不到；gatetest.sh 造對照組複本那段就是這種寫法）
      'node -e "\nconst x=\\"a\\";\nconsole.log(x);"',
    ],
    miss: ["grep -qF -- \"$must\" \"$T/out.txt\"", "grep -E '^【' \"$T/out.txt\""],
  },
};

// 一條規則對一段樣本有沒有命中——真實掃描與對照組共用這一段。
// 跨行的規則把樣本切成「指令」、整段接起來比對（換行當成空白），其他規則逐行比對。
const unitsOf = (rule, text) => (rule.multiline
  ? shellCommands(text).map((c) => ({ line: c.start, text: c.text.split('\n').join(' ') }))
  : text.split('\n').map((l, i) => ({ line: i + 1, text: l })));
const ruleHits = (rule, sample) => (rule.file ? rule.file(sample) : unitsOf(rule, sample).some((u) => rule.line(u.text)));

// ---------------------------------------------------------------------------
section('對照組：每一種壞寫法都抓得到（含本 App 真的出過事的原文），乾淨的反例不誤抓');
let controlsOk = true;
for (const rule of RULES) {
  const c = CONTROLS[rule.id];
  const missed = (c?.hit ?? []).filter((s) => !ruleHits(rule, s));
  const falsePos = (c?.miss ?? []).filter((s) => ruleHits(rule, s));
  const good = c && c.hit.length > 0 && c.miss.length > 0 && missed.length === 0 && falsePos.length === 0;
  if (!good) controlsOk = false;
  ok(good, `（對照）${rule.id}：正例 ${c?.hit.length ?? 0} 個都抓到、反例 ${c?.miss.length ?? 0} 個都沒誤抓`,
    `檢查器壞了——${missed.length ? `該抓沒抓到：${JSON.stringify(missed).slice(0, 200)}` : ''}${falsePos.length ? `；不該抓卻抓了：${JSON.stringify(falsePos).slice(0, 200)}` : ''}`);
}
if (!controlsOk) {
  console.log('\n對照組沒過：這支檢查器本身壞了，下面的掃描結果不可信，停下。');
  done('gatescan');
}

// ---------------------------------------------------------------------------
section('掃登記的檔');
const hits = [];
let totalLines = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { ok(false, `登記的檔 ${rel} 存在`, '登記的檔不見了——清單過期，或檔案被搬走'); continue; }
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  totalLines += lines.length;
  // §5.13：拿「0 命中」下結論時，寫下查了什麼、查了多少
  note(`${rel}：${lines.length} 行，雜湊 ${createHash('sha256').update(text).digest('hex').slice(0, 12)}`);
  const kind = rel.endsWith('.sh') ? 'sh' : 'mjs';
  for (const rule of RULES) {
    if (rule.scope !== 'all' && rule.scope !== kind) continue;
    if (rule.file) { if (rule.file(text)) hits.push({ rel, rule: rule.id, line: 0, text: '（整支）' }); continue; }
    for (const u of unitsOf(rule, text)) if (rule.line(u.text)) hits.push({ rel, rule: rule.id, line: u.line, text: u.text.trim() });
  }
}
ok(totalLines > 300, `（前提）登記的 ${FILES.length} 支共掃了 ${totalLines} 行`);

const isExcepted = (h) => EXCEPTIONS.some((e) => e.file === h.rel && e.rule === h.rule && h.text.includes(e.lineIncludes));
const real = hits.filter((h) => !isExcepted(h));
eq(real.map((h) => `${h.rel}:${h.line} [${h.rule}] ${h.text.slice(0, 80)}`), [],
  '登記的閘門、自查、驗法腳本裡沒有已知的壞寫法（登記的例外除外）');

// 例外不能默默留著：每一條都要對得到一個真的命中
const stale = EXCEPTIONS.filter((e) => !hits.some((h) => h.rel === e.file && h.rule === e.rule && h.text.includes(e.lineIncludes)));
eq(stale.map((e) => `${e.file} [${e.rule}] ${e.lineIncludes}`), [], `登記的 ${EXCEPTIONS.length} 條例外都還對得到命中（對不到的就是過期，要拿掉）`);
note(`初篩命中經登記例外放行 ${hits.length - real.length} 條（理由寫在這支檔的 EXCEPTIONS）`);

// ---------------------------------------------------------------------------
// 孤兒檢查（SPEC_檢查器修補 S5，F4）：登記制的洞是「沒登記的不會被掃」——v9 盤點實測：丟一支帶 `| tail -1`、
// 沒登記的推送腳本，這支照樣回 0。所以走訪整個 repo（含還沒 commit 的檔），看起來是推送、自查、閘門類的腳本，
// 不在 FILES 就要在 ORPHAN_SKIP 寫理由。判準：檔名帶 gate／precheck／piiscan／push，或不是註解的行裡呼叫了
// git push、precheck、piiscan、gatepush。
const ORPHAN_SKIP = {
  'scripts/gatescan.mjs': '就是這支掃描器；它提到 precheck、git push 的字串都是對照組的樣本',
  'scripts/mutationtest.mjs': '突變清單，不推送也不自查；提到 precheck、gatepush 的是突變要打的原文（S5 那幾條）',
};
const SCRIPT_EXT = /\.(sh|bash|mjs|js|cjs|ps1|bat|cmd)$/i;
const WALK_SKIP = new Set(['node_modules', '.git', '.logs', '.private']);
function walkScripts(root, dir = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) { if (!WALK_SKIP.has(ent.name)) out.push(...walkScripts(root, rel)); } else if (SCRIPT_EXT.test(ent.name)) out.push(rel);
  }
  return out;
}
const looksLikeGate = (rel, text) => /gate|precheck|piiscan|push/i.test(path.basename(rel))
  || text.split('\n').some((l) => !isComment(l) && (/\bgit\b[^\n|;&]*\bpush\b/.test(l) || /precheck|piiscan|gatepush/i.test(l)));
function gateOrphans(root, registered, skip) {
  const cand = walkScripts(root).filter((rel) => looksLikeGate(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
  return {
    scanned: walkScripts(root).length,
    orphans: cand.filter((rel) => !registered.includes(rel) && !(rel in skip)),
    skipStale: Object.keys(skip).filter((rel) => !cand.includes(rel)),
  };
}

section('孤兒檢查：看起來是推送、自查、閘門的腳本，都要登記或寫理由');
{
  // 對照組（§5.3）：當場造一個小 repo，跑的是跟下面真實檢查同一段 gateOrphans
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatescan-orphan-'));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    // v9 盤點實測放的那一種：沒登記、帶 | tail -1 的推送腳本（檔名看不出來，靠內容抓）
    put('scripts/ship.sh', 'node scripts/precheck.mjs HEAD ' + P + ' tail -1 && git push -q origin main\n');
    // 檔名就看得出來的
    put('tools/push-now.mjs', "console.log('ok');\n");
    // 已登記的、只在註解裡提到 git push 的、跟推送無關的：都不該報
    put('scripts/gatepush.sh', 'git push -q "$REMOTE" "$BRANCH" > "$OUT.push" 2>&1\n');
    put('scripts/build.mjs', "// 這支不會 git push\nconsole.log('build');\n");
    put('node_modules/x/push.js', 'git push\n');
    const c = gateOrphans(dir, ['scripts/gatepush.sh'], { 'scripts/gone.sh': '理由' });
    ok(c.orphans.includes('scripts/ship.sh'), 'gatescan 孤兒對照一：沒登記、帶 | tail -1 的推送腳本要報出來', `報了：${c.orphans.join('、') || '（沒有）'}`);
    ok(c.orphans.includes('tools/push-now.mjs'), 'gatescan 孤兒對照二：檔名帶 push 的腳本要報出來', `報了：${c.orphans.join('、') || '（沒有）'}`);
    eq(c.orphans.filter((r) => r !== 'scripts/ship.sh' && r !== 'tools/push-now.mjs'), [], 'gatescan 孤兒對照三（必過）：已登記的、只在註解提到的、node_modules 裡的都不報');
    eq(c.skipStale, ['scripts/gone.sh'], 'gatescan 孤兒對照四：理由寫給一支不存在（或不像閘門）的腳本，要報出來');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const g = gateOrphans(ROOT, FILES, ORPHAN_SKIP);
  ok(g.scanned > 50, `（前提）走訪了 ${g.scanned} 支腳本`);
  eq(g.orphans, [], 'gatescan 孤兒：repo 裡看起來是推送、自查、閘門的腳本都登記了（或寫了理由）');
  eq(g.skipStale, [], 'gatescan 理由過期：ORPHAN_SKIP 的每一條都還對得到一支像閘門的腳本');
}

done('gatescan');
