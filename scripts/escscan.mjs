// 跳脫掃描（npm run escscan；在 npm test 鏈裡）——補充說明（四）第 4 點，2026-09-24。
//
// 為什麼：含反斜線的樣式寫錯，分三種下場——
//   · 變成語法錯誤：一執行就炸，反而安全
//   · **語法正確、但 regex 被多跳脫一次**（/\\s/ 變成「反斜線＋s」）：永遠不命中、不報錯，檢查默默空轉
//   · 字串裡少跳脫一次（'\s' 在 JS 裡就是 's'）：拿去組 regex 就少了反斜線，一樣默默空轉
// 寫的當下攔不到（heredoc 會把 \\ 變成 \，本 App 這一輪就又踩了兩次），所以做成每版都跑的掃描。
// 以前只有 gatescan 對登記的閘門腳本做 shell 那一種；這裡把**母體擴到 repo 裡所有腳本**，並拿 git 追蹤清單做孤兒核對。
//
// 規則：
//   E1  regex 字面裡，「跳脫的反斜線」後面緊接 s d w b S D W B（例：/\\s+/）——多跳脫了一次
//   E2  一般字串（'…'、"…"、`…`）裡，單一反斜線接 s d w S D W（例：'\s+'）——JS 會把它變成單一字母
//   E3  .sh 裡 grep／sed／node -e 的指令含反斜線（初篩，命中的逐條確認同一次執行裡有對照組）
// `.` 不在名單裡：/\\./ 是正常寫法（比對一個反斜線加任意字元），跟「\. 被多跳脫一次」在字面上分不出來——已知盲區。
// 母體：走訪 repo（跳過 node_modules、.git、.logs、.private），.mjs .js .cjs .sh 全部；
//       孤兒核對：git 追蹤中的腳本，每一支都要在母體裡（走訪漏掉就報）；跳過的要在 SKIP 寫理由，理由過期也報。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, note } from './tap.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = /\.(mjs|js|cjs|sh)$/;
const WALK_SKIP = new Set(['node_modules', '.git', '.logs', '.private']);
/** 走訪到、但刻意不掃的檔：路徑 → 理由。 */
const SKIP = {};
/** 初篩命中、逐條看過確認沒問題的：{ file, rule, lineIncludes, why }。對不到命中的就是過期，也報。 */
const EXCEPTIONS = [
  {
    file: 'scripts/gatetest.sh', rule: 'E3', lineIncludes: 'node -e "',
    why: '造「對照組壞掉」複本的 node -e 帶跳脫的引號。錨點對不上時 node 以 9 結束、驗法中止；造出來的複本若不對，2a／2b 的擋下理由也對不上而報不符——同一次執行裡有對照（gatescan 同一條例外）。',
  },
  {
    file: 'scripts/gatetest.sh', rule: 'E3', lineIncludes: "grep -m1 -E '^docs/",
    why: '情境 9 挑一個要刪的檔。樣式若被 shell 改壞而一個都抓不到，下一行的 [ -n \"$last\" ] || die 讓驗法中止——不會默默放行（gatescan 同一條例外）。',
  },
  // scripts/evidence/：量「修正前」的一次性腳本（2026-09-24 收進 repo，保留供重做）。雙引號裡的 \[ 與 \s，bash 原樣交給 grep。
  ...['f3ev.sh', 'f3evB.sh', 'f3evC.sh', 'f34ev.sh'].map((f) => ({
    file: `scripts/evidence/${f}`, rule: 'E3', lineIncludes: 'grep -q "^const ROUTES = ',
    why: '證明取到的是舊版（舊 sweep 自己寫死路由清單）。樣式若被 shell 改壞而抓不到，|| exit 1 讓整支停下、不讀後面的輸出——壞了是停，不是放行。',
  })),
  {
    file: 'scripts/evidence/b5old.sh', rule: 'E3', lineIncludes: 'grep -E "^',
    why: '只把失敗的斷言印出來給人看，不拿來判斷任何事；判斷看的是上一行的回傳值。',
  },
];

// ---------------------------------------------------------------------------
// JS 的詞法切割：分出字串、樣板字串、regex 字面、註解。只做到「分得出來」的程度，不是完整的解析器。
const REGEX_BEFORE = new Set([...'=(,:!&|?{};[>~+-*%<^'].concat(['']));
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|throw)\s*$/;
/** 回傳 [{ kind: 'regex'|'string', body, line }]。 */
export function jsTokens(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let lastSig = '';           // 上一個有意義的字元（決定 / 是除號還是 regex 開頭）
  let lastText = '';          // 最近的一段程式碼（看是不是 return 之類的關鍵字）
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; lastText += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const seg = src.slice(i, e < 0 ? n : e + 2); line += (seg.match(/\n/g) || []).length; i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const start = i; const startLine = line; i += 1;
      let body = '';
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          // 樣板字串的 ${…}：跳過（裡面的程式碼另外不掃，夠用）
          let depth = 1; i += 2;
          while (i < n && depth > 0) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; else if (src[i] === '\n') line += 1; i += 1; }
          body += '${…}';
          continue;
        }
        if (src[i] === '\n') line += 1;
        body += src[i]; i += 1;
      }
      i += 1;
      out.push({ kind: 'string', body, line: startLine, quote: c, start });
      lastSig = c; lastText = '';
      continue;
    }
    if (c === '/') {
      const isRegex = REGEX_BEFORE.has(lastSig) || REGEX_KEYWORDS.test(lastText);
      if (isRegex) {
        const startLine = line; i += 1;
        let body = ''; let inClass = false;
        while (i < n && src[i] !== '\n') {
          const d = src[i];
          if (d === '\\') { body += d + (src[i + 1] ?? ''); i += 2; continue; }
          if (d === '[') inClass = true; else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          body += d; i += 1;
        }
        i += 1;
        while (i < n && /[a-z]/.test(src[i])) i += 1;   // 旗標
        out.push({ kind: 'regex', body, line: startLine });
        lastSig = ')'; lastText = '';
        continue;
      }
    }
    if (!/\s/.test(c)) { lastSig = c; }
    lastText = (lastText + c).slice(-40);
    i += 1;
  }
  return out;
}

/** E1：regex 字面裡，跳脫的反斜線（\\）後面緊接類別字母。逐個跳脫單位往後讀，不被「\\\n」這種正常寫法騙到。 */
export function doubledEscape(body) {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') continue;
    if (body[i + 1] === '\\' && /[sdwbSDWB]/.test(body[i + 2] ?? '')) return true;
    i += 1;    // 跳過這個跳脫單位的第二個字元
  }
  return false;
}
/** E2：一般字串裡，單一反斜線接類別字母（JS 會把它變成那個字母本身）。 */
export function underEscape(body) {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') continue;
    if (/[sdwSDW]/.test(body[i + 1] ?? '')) return true;
    i += 1;
  }
  return false;
}
/** E3：.sh 的一行（或跨行接起來的一個指令）是 grep／sed／node -e，而且含反斜線。 */
export const shellBackslash = (cmd) => /\b(grep|sed|node\s+-e)\b/.test(cmd) && /\\/.test(cmd);

/** 一支檔的命中：[{ rule, line, text }]。 */
export function scanText(rel, text) {
  const hits = [];
  if (rel.endsWith('.sh')) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      let cmd = lines[i]; const start = i;
      // 雙引號沒配對（跨行的字串）就接到下一行
      const open = (l) => (l.replace(/\\./g, '').match(/"/g) || []).length % 2 === 1;
      let o = open(lines[i]);
      while (o && i + 1 < lines.length) { i += 1; cmd += ' ' + lines[i]; if (open(lines[i])) o = false; }
      if (/^\s*#/.test(cmd)) continue;
      if (shellBackslash(cmd)) hits.push({ rule: 'E3', line: start + 1, text: cmd.trim().slice(0, 100) });
    }
    return hits;
  }
  for (const t of jsTokens(text)) {
    if (t.kind === 'regex' && doubledEscape(t.body)) hits.push({ rule: 'E1', line: t.line, text: `/${t.body.slice(0, 80)}/` });
    if (t.kind === 'string' && underEscape(t.body)) hits.push({ rule: 'E2', line: t.line, text: `${t.quote}${t.body.slice(0, 80)}${t.quote}` });
  }
  return hits;
}

// ---------------------------------------------------------------------------
section('對照組：擷取 regex 字面（各種位置要抽得到；除號、字串、網址、註解不算）');
{
  const src = [
    "a.test(x) && /aa/.test(y);",
    "s.replace(/bb/g, '');",
    "const R = /cc/;",
    "if (!/dd/.test(z)) {}",
    "function f() { return /ee/.exec(q); }",
    "const r = [/ff/, /gg/];",
    "const half = total / 2 / 3;",
    "const url = 'https://x.y/zz/';",
    "// 註解裡的 /hh/ 不算",
    "const t = `樣板 /ii/ ${a / b}`;",
  ].join('\n');
  const got = jsTokens(src).filter((t) => t.kind === 'regex').map((t) => t.body);
  eq(got, ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg'], '（對照）regex 字面：.test／.replace／常數／!…／return／陣列裡的都抽得到；除號、字串裡的斜線、網址、註解、樣板字串不算');
}

section('對照組：每一條規則兩個方向（該抓的抓到、正常寫法不誤抓）');
{
  const hitE1 = ['/\\\\s+/', '/[\\\\d]+/', '/a\\\\wb/'];            // 原始碼裡的 /\\s+/ 等
  const missE1 = ['/\\s+/', "/[^'\\\\\\n]/", '/\\\\\\s/', '/\\\\./', '/\\//'];
  const e1 = (code) => scanText('x.mjs', `const r = ${code};`).some((h) => h.rule === 'E1');
  ok(hitE1.every(e1) && !missE1.some(e1), `（對照）E1 多跳脫：${hitE1.length} 個正例都抓到、${missE1.length} 個正常寫法都沒誤抓`,
    JSON.stringify({ 漏抓: hitE1.filter((c) => !e1(c)), 誤抓: missE1.filter(e1) }));
  const hitE2 = ["'\\s+'", '"\\d{3}"', '`\\w+`'];
  const missE2 = ["'\\\\s+'", "'\\n'", "'\\t'", "'dir\\\\Users'", '`\\\\d`'];   // 不寫磁碟機代號：公開前自查的 (d) 類會把它當成本機路徑
  const e2 = (code) => scanText('x.mjs', `const r = ${code};`).some((h) => h.rule === 'E2');
  ok(hitE2.every(e2) && !missE2.some(e2), `（對照）E2 少跳脫：${hitE2.length} 個正例都抓到、${missE2.length} 個正常寫法都沒誤抓`,
    JSON.stringify({ 漏抓: hitE2.filter((c) => !e2(c)), 誤抓: missE2.filter(e2) }));
  const e3 = (code) => scanText('x.sh', code).some((h) => h.rule === 'E3');
  ok(e3("grep -E '^\\s+find:' x") && e3('node -e "\nconst x=\\"a\\";"') && !e3('grep -qF -- "$must" "$T/out.txt"') && !e3('# grep -E "\\s" 註解'),
    '（對照）E3 shell：grep 樣式帶反斜線、跨行的 node -e 抓到；沒有反斜線的、註解不抓');
}

// ---------------------------------------------------------------------------
section('母體：repo 裡所有腳本（走訪＋git 追蹤清單核對）');
const walked = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) walk(rel); } else if (EXT.test(e.name)) walked.push(rel);
  }
};
walk('');
const tracked = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter((f) => EXT.test(f));
ok(tracked.length > 80, `（前提）git 追蹤中的腳本有 ${tracked.length} 支`);
eq(tracked.filter((f) => !walked.includes(f)), [], '跳脫掃描孤兒：git 追蹤中的每一支腳本都在走訪到的母體裡');
eq(Object.keys(SKIP).filter((f) => !walked.includes(f)), [], '跳脫掃描理由過期：SKIP 的每一條都還對得到一支檔');
const scanned = walked.filter((f) => !(f in SKIP));

section('掃描');
const hits = [];
let lines = 0;
const tokenCount = { regex: 0, string: 0 };
for (const rel of scanned) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  lines += text.split('\n').length;
  for (const h of scanText(rel, text)) hits.push({ rel, ...h });
  if (!rel.endsWith('.sh')) for (const t of jsTokens(text)) tokenCount[t.kind] += 1;
}
note(`掃了 ${scanned.length} 支、${lines} 行（走訪到 ${walked.length} 支，跳過 ${Object.keys(SKIP).length} 支）`);
// §5.13：拿「0 命中」下結論之前，確認切割真的在真實檔案上抽到東西——切割走偏的話，一路把程式碼當字串，命中照樣是 0
ok(tokenCount.regex > 150 && tokenCount.string > 5000, `（前提）全 repo 抽到 ${tokenCount.regex} 個 regex 字面、${tokenCount.string} 個字串（切割沒有走偏）`);
const isExcepted = (h) => EXCEPTIONS.some((e) => e.file === h.rel && e.rule === h.rule && h.text.includes(e.lineIncludes));
eq(hits.filter((h) => !isExcepted(h)).map((h) => `${h.rel}:${h.line} [${h.rule}] ${h.text}`), [], '跳脫：repo 裡所有腳本都沒有多跳脫或少跳脫的樣式（登記的例外除外）');
eq(EXCEPTIONS.filter((e) => !hits.some((h) => h.rel === e.file && h.rule === e.rule && h.text.includes(e.lineIncludes))).map((e) => `${e.file} [${e.rule}]`), [],
  `跳脫例外過期：登記的 ${EXCEPTIONS.length} 條例外都還對得到命中`);

done('escscan');
