// 【本質一次性，保留供重做】範圍外第 2 件：新舊端點擷取比對。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
// cwd＝暫存複本。新的 endpointsIn（livejudge.mjs）與 S9 盤點用的樣式，對同一批 app 檔各跑一次。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { endpointsIn } = await import(pathToFileURL(path.resolve('scripts/livejudge.mjs')).href);
const s9 = (text) => new Set([...text.matchAll(/\/(?:exchangeReport|rwd\/zh\/afterTrading|rwd\/zh\/[\w/]+)\/([A-Z0-9_]+)/g)].map((m) => m[1]));
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) files.push(p); } };
walk('js'); for (const f of ['sw.js', 'worker/src/index.js']) if (fs.existsSync(f)) files.push(f);
const a = new Set(); const b = new Set();
for (const f of files) { const t = fs.readFileSync(f, 'utf8'); for (const x of endpointsIn(t)) a.add(x); for (const x of s9(t)) b.add(x); }
console.log(`  掃了 ${files.length} 支檔；新樣式 ${a.size} 個：${[...a].sort().join('、')}；S9 樣式 ${b.size} 個：${[...b].sort().join('、')}`);
console.log(`  新樣式少掉的：${[...b].filter((x) => !a.has(x)).join('、') || '（沒有）'}；多出的：${[...a].filter((x) => !b.has(x)).join('、') || '（沒有）'}`);
const live = (t) => endpointsIn(t);
const oldText = fs.readFileSync(process.env.OLDLC || 'scripts/livecheck.mjs', 'utf8');
console.log(`  livecheck 打的端點：現在 ${live(fs.readFileSync('scripts/livecheck.mjs', 'utf8')).join('、')}`);
