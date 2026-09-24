// 【本質一次性，保留供重做】用途：共用：逐條套突變、看紅了哪幾組｜比較：不適用（共用的小工具，被同目錄的量測腳本呼叫）｜數字在：docs/EVIDENCE_檢查器修補.md「## 盤點：哪些有常設情境守著」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// 在目前目錄（暫存複本）逐條套「名稱以 PFX 開頭」的突變，跑它指定的測試，印出紅了哪幾條；每條之後還原並比雜湊。
// 用法：node each.mjs <前綴> <條數>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [PFX, N] = process.argv.slice(2);
const src = fs.readFileSync('scripts/mutationtest.mjs', 'utf8');
// 從突變清單的原文取出那幾條（清單是 JS 不是 JSON；每個欄位都寫在同一行、用引號包）
const blocks = src.split('\n  {\n').filter((b) => b.includes("name: '" + PFX));
if (blocks.length !== Number(N)) { console.error(`${PFX} 突變應有 ${N} 條，取到 ${blocks.length}`); process.exit(1); }
const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 7);
for (const b of blocks) {
  const get = (k) => {
    const m = new RegExp(`\\n    ${k}: (".*"|'.*'),\\n`).exec(`\n${b}`);
    if (!m) throw new Error(`取不到 ${k}`);
    return Function(`return ${m[1]}`)();
  };
  const name = get('name'); const file = get('file'); const find = get('find'); const replace = get('replace');
  const expect = get('expect'); const test = get('test');
  const orig = fs.readFileSync(file, 'utf8');
  if (orig.split(find).length !== 2) { console.log(`  ✗ ${name}：錨點對不上`); continue; }
  fs.writeFileSync(file, orig.split(find).join(replace));
  if (h(fs.readFileSync(file, 'utf8')) === h(orig)) { console.log(`  ✗ ${name}：沒套上`); continue; }
  const r = spawnSync(process.execPath, [`scripts/${test}.mjs`], { encoding: 'utf8' });
  const reds = r.stdout.split('\n').filter((l) => l.trim().startsWith('✗')).map((l) => l.trim().replace(/^✗ /, '').split('：')[0]);
  console.log(`  ${name}（${test}，expect「${expect}」）→ exit=${r.status}，紅的：${reds.join('／') || '（沒有）'}`);
  fs.writeFileSync(file, orig);
  if (h(fs.readFileSync(file, 'utf8')) !== h(orig)) { console.log(`  ✗ ${file} 沒還原`); process.exit(1); }
}
