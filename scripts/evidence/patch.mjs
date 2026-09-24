// 【本質一次性，保留供重做】用途：共用：改一處（錨點要剛好一次）｜比較：不適用（共用的小工具，被同目錄的量測腳本呼叫）｜數字在：docs/EVIDENCE_檢查器修補.md「## 盤點：哪些有常設情境守著」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// 用法：node patch.mjs <檔> <原文> <改成>——錨點必須剛好一次；改完確認新字串在、內容真的變了。
import fs from 'node:fs';
const [f, a, b] = process.argv.slice(2);
const s = fs.readFileSync(f, 'utf8');
if (s.split(a).length !== 2) { console.error(`錨點對不上（出現 ${s.split(a).length - 1} 次）：${f}`); process.exit(1); }
const t = s.split(a).join(b);
if (t === s || !t.includes(b)) { console.error(`沒改到：${f}`); process.exit(1); }
fs.writeFileSync(f, t);
