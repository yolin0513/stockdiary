// 【本質一次性，保留供重做】範圍外第 1 件：三個 commit 對本機假證交所各跑一次。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
// 第 1 件的證據（cwd＝暫存複本）：三個明確的 commit 的 livecheck，各自對本機假證交所跑一次。
// 假證交所送錄好的回應（帶 CORS 標頭）；日曆段會多打兩個月的 2330，一律回 115 年 6 月那份（核對會不符，但不會崩）。
// 量的是：跑到了哪幾段、有沒有「段落崩潰」的失敗、最後有沒有 done() 的總結、回傳值。
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const REVS = process.argv.slice(2);
const fx = (n) => fs.readFileSync(`scripts/fixtures/${n}`);
let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  const h = { 'access-control-allow-origin': '*' };
  if (req.url.startsWith('/rwd/zh/afterTrading/STOCK_DAY_ALL')) { res.writeHead(200, h); res.end(fx('stock-day-all.csv')); return; }
  if (req.url.includes('stockNo=2330')) { res.writeHead(200, h); res.end(fx('stock-day-2330-202606.json')); return; }
  if (req.url.includes('stockNo=')) { res.writeHead(200, h); res.end(fx('stock-day-otc-6488.json')); return; }
  if (req.url.includes('TWT48U')) { res.writeHead(200, h); res.end(fx('twt48u-forecast.json')); return; }
  if (req.url.includes('TWT49U')) { res.writeHead(200, h); res.end(fx('twt49u-result.json')); return; }
  res.writeHead(404, h); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 7);

for (const rev of REVS) {
  const src = execFileSync('git', ['show', `${rev}:scripts/livecheck.mjs`], { encoding: 'utf8' });
  const anchor = "const TWSE = 'https://www.twse.com.tw';";
  if (src.split(anchor).length !== 2) throw new Error(`${rev}：TWSE 網址的錨點對不上`);
  // 那個 commit 的 livejudge.mjs 也要用它自己的（舊版沒有 livejudge 的話就不用）
  const file = `scripts/livecheck-${rev}.mjs`;
  let body = src.split(anchor).join(`const TWSE = '${BASE}';`);
  const hasJudge = body.includes("from './livejudge.mjs'");
  if (hasJudge) {
    fs.writeFileSync(`scripts/livejudge-${rev}.mjs`, execFileSync('git', ['show', `${rev}:scripts/livejudge.mjs`], { encoding: 'utf8' }));
    body = body.split("from './livejudge.mjs'").join(`from './livejudge-${rev}.mjs'`);
  }
  fs.writeFileSync(file, body);
  const facts = {
    日曆段讀頂層_closed: src.includes('for (const c of cal.closed)'),
    有_stage: src.includes('await stage('),
  };
  hits = 0;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill(), 180000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  const sections = r.out.split('\n').filter((l) => /^— .* —$/.test(l.trim())).map((l) => l.trim().slice(2, -2).trim());
  const crashes = r.out.split('\n').filter((l) => /段落崩潰/.test(l) && /✗/.test(l)).map((l) => l.trim());
  const uncaught = /TypeError: cal\.closed is not iterable/.test(r.out) && !crashes.length;
  const summary = r.out.split('\n').find((l) => /^livecheck：/.test(l.trim()));
  console.log(`\n【${rev}】livecheck ${sha(src)}（${JSON.stringify(facts)}）`);
  console.log(`  回傳 ${r.code}；假證交所收到 ${hits} 個請求；跑到 ${sections.length} 段`);
  console.log(`  最後三段：${sections.slice(-3).join('／')}`);
  console.log(`  段落崩潰的失敗：${crashes.join('｜') || '（沒有）'}`);
  console.log(`  沒被接住的 cal.closed 例外：${uncaught ? '有（整支崩在這裡）' : '沒有'}`);
  console.log(`  done() 的總結：${summary ? summary.trim() : '（沒有——沒跑到結尾）'}`);
}
server.close();
