// 【本質一次性，保留供重做】共用：改一處（錨點要剛好一次）。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
// 用法：node patch.mjs <檔> <原文> <改成>——錨點必須剛好一次；改完確認新字串在、內容真的變了。
import fs from 'node:fs';
const [f, a, b] = process.argv.slice(2);
const s = fs.readFileSync(f, 'utf8');
if (s.split(a).length !== 2) { console.error(`錨點對不上（出現 ${s.split(a).length - 1} 次）：${f}`); process.exit(1); }
const t = s.split(a).join(b);
if (t === s || !t.includes(b)) { console.error(`沒改到：${f}`); process.exit(1); }
fs.writeFileSync(f, t);
