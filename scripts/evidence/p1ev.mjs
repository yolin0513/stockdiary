// 【本質一次性，保留供重做】用途：補充說明（四）第 1 點的修正前（理由在整份輸出裡找）｜比較：3e7b009 的 gatetest.sh vs 新驗法｜數字在：docs/EVIDENCE_檢查器修補.md「**補充說明（四）第 1 點」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// 補充說明（四）第 1 點的證據（cwd＝暫存複本）。造「那句話出現了，但不是它擋的」：
//   · 自查改壞：(a) 金鑰／token 不看 commit 訊息與作者欄
//   · 情境 7 的 commit 訊息裡除了 token，再放一個 email——(b) 會抓到那一行、原樣印出來
// 舊版驗法（3e7b009：整份輸出找「[commit 訊息／作者] +gatetest：合成 token 只放在訊息裡」）→ 7 判符合（假的）
// 新版驗法（只在 (a) 類的命中行裡找）→ 7 判不符
// 用法：node p1ev.mjs <old|new>   （old＝把 gatetest.sh、gatepush.sh 換成 3e7b009 的版本）
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const which = process.argv[2];
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const patch = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (s.split(a).length !== 2) throw new Error(`${f}：錨點出現 ${s.split(a).length - 1} 次：${a.slice(0, 50)}`);
  fs.writeFileSync(f, s.split(a).join(b));
};
if (which === 'old') {
  for (const f of ['scripts/gatetest.sh', 'scripts/gatepush.sh']) fs.writeFileSync(f, git('show', `3e7b009:${f}`) + '\n');
  if (fs.readFileSync('scripts/gatetest.sh', 'utf8').includes('gatereason')) throw new Error('取到的舊版已經有 gatereason');
  if (!fs.readFileSync('scripts/gatetest.sh', 'utf8').includes('has "$T/out.txt" "$must"')) throw new Error('舊版沒有「整份輸出找一句話」的寫法');
}
patch('scripts/precheck.mjs', "  ['(a) 金鑰／token', hitsIn(CTRL.a, TOKEN).length, hitsIn(added, TOKEN)],",
  "  ['(a) 金鑰／token', hitsIn(CTRL.a, TOKEN).length, hitsIn(added.filter((l) => SOURCE.get(l) !== 'commit 訊息／作者'), TOKEN)],");
patch('scripts/gatetest.sh', 'git commit -q --allow-empty -m "gatetest：合成 token 只放在訊息裡 $TOK"',
  'git commit -q --allow-empty -m "gatetest：合成 token 只放在訊息裡 $TOK some""one@exam""ple.com"');
git('commit', '-q', '-am', `p1ev：${which}`);
const r = spawnSync('bash', ['scripts/gatetest.sh'], { encoding: 'utf8' });
const out = `${r.stdout}${r.stderr}`;
const line7 = out.split('\n').find((l) => /^ {2}(✓|✗) 7\. /.test(l)) ?? '（找不到情境 7 的結論）';
console.log(`【${which === 'old' ? '修正前（3e7b009 的 gatetest.sh）' : '修正後'}】gatetest 回傳 ${r.status}`);
console.log(`  ${line7.slice(0, 260)}`);
