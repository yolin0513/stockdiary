// 【本質一次性，保留供重做】S4 逐條突變紅了哪幾組（s4ev.sh 呼叫）。對明確的舊 commit 量「修正前」，結果記在 docs/EVIDENCE_檢查器修補.md；不在任何測試鏈裡。
// 在目前目錄（暫存複本）逐條套 S4 突變，跑 controltest，印出紅了哪幾組；每條之後還原並比雜湊。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const src = fs.readFileSync('scripts/mutationtest.mjs', 'utf8');
// 從突變清單的原文取出 S4 那幾條的 find／replace（用 JSON 不行，清單是 JS；只取單引號或雙引號包的一行）
const blocks = src.split('\n  {\n').filter((b) => b.includes("name: 'S4："));
if (blocks.length !== 6) { console.error(`S4 突變應有 6 條，取到 ${blocks.length}`); process.exit(1); }
const F = 'scripts/sweepjudge.mjs';
const orig = fs.readFileSync(F, 'utf8');
const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 7);
for (const b of blocks) {
  const get = (k) => {
    const m = new RegExp(`\\n    ${k}: (".*"|'.*'),\\n`).exec(`\n${b}`);
    if (!m) throw new Error(`取不到 ${k}`);
    return Function(`return ${m[1]}`)();
  };
  const name = get('name'); const find = get('find'); const replace = get('replace'); const expect = get('expect');
  if (orig.split(find).length !== 2) { console.log(`  ✗ ${name}：錨點對不上`); continue; }
  const bad = orig.split(find).join(replace);
  fs.writeFileSync(F, bad);
  if (h(fs.readFileSync(F, 'utf8')) === h(orig)) { console.log(`  ✗ ${name}：沒套上`); continue; }
  const r = spawnSync(process.execPath, ['scripts/controltest.mjs'], { encoding: 'utf8' });
  const reds = r.stdout.split('\n').filter((l) => l.trim().startsWith('✗')).map((l) => l.trim().replace(/^✗ /, '').split('：')[0]);
  console.log(`  ${name}（expect「${expect}」）→ exit=${r.status}，紅的：${reds.join('／') || '（沒有）'}`);
  fs.writeFileSync(F, orig);
}
console.log(`  還原後 ${h(fs.readFileSync(F, 'utf8'))} ＝ 原本 ${h(orig)}`);
