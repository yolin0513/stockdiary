// 新聞轉發 Worker 的稽核（npm run workertest）。
//
// **用 wrangler 真的把 Worker 跑起來**，不是讀程式碼、也不是自己 mock 一個
// Request/Response 假裝跑過。白名單擋不擋得住、CORS 標頭有沒有送出去、
// 快取有沒有生效，都只有真跑才算數。
//
// 這支**不進 `npm test`**：它要起 wrangler，而且「白名單來源」那幾條會真的
// 去打一次上游 RSS（慣例 10：打真網路的測試另開指令）。
//
// 一個來源只打一次，不連打。

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, done, noneOf, everyOf, detects } from './tap.mjs';
import { stripComments } from './srcscan.mjs';
import { SOURCES, CACHE_SECONDS } from '../workers/sources.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把整棵行程樹殺掉。
 *
 * Windows 上 `proc.kill()` 只會殺掉 npx.cmd 這層殼，底下的 wrangler 與 workerd
 * 會活下來 —— 跑幾次之後就堆了二十幾個殭屍行程，佔著連接埠，下一次測試直接卡死。
 * （實際發生過。）所以要用 taskkill /T 連子孫一起殺。
 */
async function killTree(proc) {
  const pid = proc.pid;
  if (pid == null) return;
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* 已經死了就算了 */ }
  await sleep(300);
}

/** 先要一個空閒的連接埠。不解析 wrangler 的輸出 —— 它安靜起來時什麼都不印。 */
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 起 wrangler dev，探到它真的收請求為止。 */
async function startWrangler() {
  const port = await freePort();
  const proc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--port', String(port), '--inspector-port', '0'],
    { cwd: path.join(ROOT, 'workers'), stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  let out = '';
  proc.stdout.on('data', (b) => { out += b.toString(); });
  proc.stderr.on('data', (b) => { out += b.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return { proc, base, out: () => out };
    } catch { /* 還沒好 */ }
    if (proc.exitCode != null) break;
    await sleep(500);
  }
  await killTree(proc);
  throw new Error(`wrangler dev 起不來（${base}）：
${out.slice(0, 3000) || '（wrangler 沒有任何輸出）'}`);
}

const { proc, base } = await startWrangler();

try {
  // -------------------------------------------------------------------------
  section('前提：Worker 真的跑起來了');
  const health = await fetch(`${base}/health`);
  eq(health.status, 200, '/health 回 200');
  const h = await health.json();
  eq(h.ok, true, '/health 說它活著');
  eq(h.cacheSeconds, CACHE_SECONDS, `快取秒數是 ${CACHE_SECONDS}`);
  eq(h.sources.map((s) => s.id).sort(), Object.keys(SOURCES).sort(), '四個來源都在');

  // -------------------------------------------------------------------------
  section('白名單：不是清單裡的一律 400');
  const bad = ['evil', 'udn', 'http://example.com/rss', 'https://news.ltn.com.tw/rss/business.xml', '../health', 'cna2', 'CNA'];
  const badResults = [];
  for (const src of bad) {
    const r = await fetch(`${base}/rss?src=${encodeURIComponent(src)}`);
    badResults.push({ src, status: r.status, cors: r.headers.get('access-control-allow-origin') });
  }
  everyOf(badResults, (r) => r.status === 400, '每一個非白名單來源都回 400');
  everyOf(badResults, (r) => r.cors === '*', '400 也要送 CORS 標頭（不然瀏覽器連錯誤訊息都讀不到）');
  // 直接給網址必須被擋掉 —— 不然這就是一台開放代理，會被拿去打別人。
  ok(badResults.filter((r) => r.src.startsWith('http')).every((r) => r.status === 400),
    '直接塞網址進來會被擋（這不是開放代理）');
  // 大小寫不一樣就是不同的代號，不要自作聰明正規化
  ok(badResults.find((r) => r.src === 'CNA')?.status === 400, '代號大小寫不相符也擋掉');

  const noSrc = await fetch(`${base}/rss`);
  eq(noSrc.status, 400, '完全不給 src 也回 400');
  const noSrcBody = await noSrc.json();
  ok(Array.isArray(noSrcBody.sources) && noSrcBody.sources.length === 4,
    '而且把允許的來源列出來，不是只丟一句錯誤', JSON.stringify(noSrcBody.sources));

  eq((await fetch(`${base}/nope`)).status, 404, '沒有的端點回 404，不是 400');

  // -------------------------------------------------------------------------
  section('對照組：白名單裡的來源不會被擋');
  // 少了這一條，一個「無論如何都回 400」的壞 Worker 也會讓上面全過。
  // 只打一家（中央社，robots 最乾淨的那個），不連打。
  const good = await fetch(`${base}/rss?src=cna`);
  ok(good.status !== 400, `白名單來源沒有被當成非法（實際 ${good.status}）`);
  if (good.status === 200) {
    eq(good.headers.get('access-control-allow-origin'), '*', '轉發的回應有 CORS 標頭');
    eq(good.headers.get('x-sd-source'), 'cna', '標了來源代號');
    ok(/max-age=600/.test(good.headers.get('cache-control') || ''), '快取十分鐘');
    const xml = await good.text();
    ok(/<rss|<feed|<channel/i.test(xml), '回來的是 RSS 原文', xml.slice(0, 120));

    section('快取：同一個來源第二次不再打上游');
    const again = await fetch(`${base}/rss?src=cna`);
    eq(again.status, 200, '第二次也是 200');
    eq(again.headers.get('x-sd-cache'), 'hit', '第二次是快取命中（沒有再打上游）');

    // 多帶一個無關參數不可以繞過快取 —— 不然誰都能逼我們一直去打上游。
    const noisy = await fetch(`${base}/rss?src=cna&cb=${Date.now()}`);
    eq(noisy.headers.get('x-sd-cache'), 'hit', '多帶無關參數也還是走快取，繞不過去');
  } else {
    ok(false, '上游沒給 200，快取那幾條這次沒驗到', `狀態 ${good.status}：${(await good.text()).slice(0, 200)}`);
  }

  // -------------------------------------------------------------------------
  section('這個 Worker 什麼都不存');
  // 規劃就是 N1：無狀態轉發。綁了 KV／D1／R2／Cron 就不是這個方案了。
  const toml = (await import('node:fs')).readFileSync(path.join(ROOT, 'workers/wrangler.toml'), 'utf8');
  const declared = toml.replace(/^\s*#.*$/gm, '');
  noneOf(['kv_namespaces', 'd1_databases', 'r2_buckets', 'triggers', 'crons', 'vars'],
    (k) => new RegExp(`\\b${k}\\b`).test(declared),
    'wrangler.toml 沒有綁任何會存東西的資源');

  // 看的是**程式碼**，不是註解。註解裡寫「AI 是瀏覽器直連 api.anthropic.com」
  // 是在解釋為什麼不碰金鑰，把它當成命中就等於罰人寫註解。
  const workerCode = stripComments(
    (await import('node:fs')).readFileSync(path.join(ROOT, 'workers/worker.mjs'), 'utf8'));
  noneOf(['sk-ant-', 'ANTHROPIC', 'api.anthropic.com', 'x-api-key'], (k) => workerCode.includes(k),
    'Worker 的程式碼裡完全沒有金鑰相關的東西（AI 是瀏覽器直連，不經這裡）');
  detects((t) => stripComments(t).includes('api.anthropic.com'), {
    shouldHit: [
      "fetch('https://api.anthropic.com/v1/messages')", // 網址裡的 // 不是註解
      'const u = "api.anthropic.com";',
      'const u = "api.anthropic.com"; // 直連',
    ],
    shouldMiss: [
      '// 不經過 api.anthropic.com',
      '/* api.anthropic.com 由瀏覽器直連 */',
      '  //   · 不碰金鑰（AI 直連 api.anthropic.com）',
    ],
  }, '這個掃描器分得出「程式碼」「註解」與「網址裡的 //」');
} finally {
  await killTree(proc);
}

done('workertest');
