// 【本質一次性，保留供重做】用途：S6 本機假證交所（s6ev.sh 呼叫）｜比較：cb81089 vs 6734a22｜數字在：docs/EVIDENCE_檢查器修補.md「**S6 `livecheck` 用錄好的回應當合成對照」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// S6 三段證據（在暫存複本裡跑，cwd＝複本）。不打證交所：起一個本機假證交所，送錄好的回應、但拿掉 CORS 標頭。
// 盲點：livecheck 的 CORS 判斷壞了（永遠成立）。修正前：沒有東西發現；修正後：對照組先擋、一個請求都沒發。
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 7);
const patch = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (s.split(a).length !== 2) throw new Error(`錨點對不上（${s.split(a).length - 1} 次）：${f}：${a.slice(0, 50)}`);
  const t = s.split(a).join(b);
  if (t === s || !t.includes(b)) throw new Error(`沒改到：${f}`);
  fs.writeFileSync(f, t);
};

let hits = [];
const fx = (n) => fs.readFileSync(`scripts/fixtures/${n}`);
const server = http.createServer((req, res) => {
  hits.push(req.url);
  // 故意錄壞的：全部不帶 access-control-allow-origin
  if (req.url.startsWith('/rwd/zh/afterTrading/STOCK_DAY_ALL')) { res.writeHead(200, { 'content-type': 'text/csv' }); res.end(fx('stock-day-all.csv')); return; }
  if (req.url.includes('stockNo=2330')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fx('stock-day-2330-202606.json')); return; }
  if (req.url.includes('stockNo=')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fx('stock-day-otc-6488.json')); return; }
  if (req.url.includes('TWT48U')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fx('twt48u-forecast.json')); return; }
  if (req.url.includes('TWT49U')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fx('twt49u-result.json')); return; }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const run = (file) => new Promise((resolve) => {
  hits = [];
  const p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, hits: hits.length }); });
});
const show = (r, pat) => r.out.split('\n').filter((l) => pat.test(l)).slice(0, 6).map((l) => `    ${l.trim()}`).join('\n');

// ---- 修正前：cb81089 的 livecheck（已放進複本的 scripts/livecheck-old.mjs） ----
const OLD = 'scripts/livecheck-old.mjs';
if (fs.readFileSync(OLD, 'utf8').includes('livejudge')) throw new Error('取到的修正前已經有 S6');
if (sha(OLD) === sha('scripts/livecheck.mjs')) throw new Error('新舊同一份');
console.log(`修正前 ${sha(OLD)}／修正後 ${sha('scripts/livecheck.mjs')}`);
patch(OLD, "const TWSE = 'https://www.twse.com.tw';", `const TWSE = '${BASE}';`);
patch(OLD, "  eq(res.headers.get('access-control-allow-origin'), '*',\n    'CORS 標頭還在（少了它", "  eq('*', '*',\n    'CORS 標頭還在（少了它");
const before = await run(OLD);
console.log(`\n【修正前：CORS 判斷改成永遠成立，假證交所不帶 CORS 標頭】exit=${before.code}，假證交所收到 ${before.hits} 個請求`);
console.log(show(before, /CORS|對照/));

// ---- 修正後：同一種壞法打在 livejudge ----
patch('scripts/livecheck.mjs', "const TWSE = 'https://www.twse.com.tw';", `const TWSE = '${BASE}';`);
const judge = fs.readFileSync('scripts/livejudge.mjs', 'utf8');
patch('scripts/livejudge.mjs', "export const corsProblem = (value) => (value === '*' ? null :", "export const corsProblem = (value) => (true ? null :");
const after = await run('scripts/livecheck.mjs');
console.log(`\n【修正後：同一種壞法打在 livejudge.mjs】exit=${after.code}，假證交所收到 ${after.hits} 個請求`);
console.log(show(after, /✗|對照組沒過/));

// ---- 突變：把「對照組沒過就停」拿掉 ----
patch('scripts/livecheck.mjs', 'if (ctrl.some((c) => !c.ok)) {', 'if (false) {');
const mut = await run('scripts/livecheck.mjs');
console.log(`\n【突變：再拿掉「對照組沒過就停」】exit=${mut.code}，假證交所收到 ${mut.hits} 個請求`);
console.log(show(mut, /CORS 標頭還在|對照組沒過/));

// ---- 對照：判斷沒壞時，正式巡檢對著不帶 CORS 的假證交所會報 CORS ----
fs.writeFileSync('scripts/livejudge.mjs', judge);
patch('scripts/livecheck.mjs', 'if (false) {', 'if (ctrl.some((c) => !c.ok)) {');
const clean = await run('scripts/livecheck.mjs');
console.log(`\n【對照：判斷沒壞，假證交所不帶 CORS 標頭】exit=${clean.code}，假證交所收到 ${clean.hits} 個請求`);
console.log(show(clean, /✗ .*CORS|對照組沒過/));
server.close();
