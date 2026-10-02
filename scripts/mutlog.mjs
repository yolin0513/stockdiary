// 從一場 mutationtest 的 log 逐行數結果（2026-10-03）：
//
//   node scripts/mutlog.mjs <log>        回 0＝對得上；1＝對不上（點名）；2＝用法錯
//
// 為什麼：「各類相加等於母體」如果是逐條走清單、缺的就補成某一類，相加永遠等於清單長度——恆等式，擋不下任何東西
// （遊戲 2026-10-03 早上的「相加 225」、MealMate、本 App 的 mutationtest 都中）。所以從這一場**實際產生的 log** 數：
//   · 母體：log 裡的「挑選｜名稱」行（開跑前印的）——名稱重複就報
//   · 結果：log 裡的「結果｜名稱｜類別」行——同一條出現兩次以上、log 有而挑選沒有、挑選有而沒有結果，都報
//   · 獨立核對：每一條挑選的突變，log 裡要恰好有一行它自己的判定行（行首「  ✓ 」或「  ✗ 」接著它的名稱）——
//     判定行是 tap 印的、「結果｜」行是執行器另外印的，兩個來源的條數都印出來
//   · 各類分開數，相加和「挑選數」「不重複的結果數」三個數字一起印
// 帳本還沒有（§5.18 第 4 點，排在 v11.x 實作），所以「帳本那一側」暫時沒有；有了之後在這裡加第三個來源。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATEGORIES = ['紅在對的地方', '沒紅', '紅錯地方', '多紅了別組', '情境未成立', '過期', '預期清單過期', '還原失敗'];

/** 回傳 { picked, results, counts, verdictLines, problems }。純函式，測試餵合成的 log。 */
export function countLog(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const picked = [];
  const results = [];
  const problems = [];
  for (const l of lines) {
    let m = /^ {2}· 挑選｜(.+)$/.exec(l);
    if (m) { picked.push(m[1]); continue; }
    m = /^ {2}· 結果｜(.+)｜([^｜]+)$/.exec(l);
    if (m) results.push({ name: m[1], cat: m[2] });
  }
  const pickedSet = new Set(picked);
  if (pickedSet.size !== picked.length) problems.push(`挑選清單有重複的名稱：${picked.filter((n, i) => picked.indexOf(n) !== i).join('、')}`);
  const seen = new Map();
  for (const r of results) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k}（${n} 次）`);
  if (dup.length) problems.push(`同一條在 log 裡有不只一個結果：${dup.join('、')}`);
  const extra = [...seen.keys()].filter((k) => !pickedSet.has(k));
  if (extra.length) problems.push(`log 有結果、挑選清單卻沒有：${extra.join('、')}`);
  const missing = picked.filter((k) => !seen.has(k));
  if (missing.length) problems.push(`挑選了、log 裡卻沒有結果（沒跑到或被中斷）：${missing.join('、')}`);
  const badCat = results.filter((r) => !CATEGORIES.includes(r.cat));
  if (badCat.length) problems.push(`不認得的類別：${badCat.map((r) => `${r.name}｜${r.cat}`).join('、')}`);
  // 每一類只數一次（同名重複的結果已經報過）
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const firstCat = new Map();
  for (const r of results) if (!firstCat.has(r.name)) firstCat.set(r.name, r.cat);
  for (const c of firstCat.values()) if (c in counts) counts[c] += 1;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (sum !== picked.length) problems.push(`各類相加 ${sum} 條，挑選 ${picked.length} 條，對不上`);
  // 獨立核對：判定行（tap 印的，行首 ✓／✗ 接著名稱）——每一條挑選的突變恰好一行
  const verdictLines = new Map(picked.map((n) => [n, 0]));
  for (const l of lines) {
    if (!/^ {2}[✓✗] /.test(l)) continue;
    const body = l.slice(4);
    for (const n of picked) {
      if (body === n || body.startsWith(`${n} → `) || body === `${n}：還原失敗`) verdictLines.set(n, verdictLines.get(n) + 1);
    }
  }
  const vBad = [...verdictLines].filter(([, n]) => n !== 1).map(([k, n]) => `${k}（${n} 行）`);
  if (vBad.length) problems.push(`判定行不是恰好一行：${vBad.join('、')}`);
  const vTotal = [...verdictLines.values()].reduce((a, b) => a + b, 0);
  return { picked: picked.length, results: results.length, unique: seen.size, counts, sum, verdictLines: vTotal, problems };
}

function main() {
  const f = process.argv[2];
  if (!f) { console.error('用法：node scripts/mutlog.mjs <log>'); process.exit(2); }
  const r = countLog(fs.readFileSync(f, 'utf8'));
  console.log(`從 log 逐行數：挑選 ${r.picked} 條｜結果行 ${r.results} 行（不重複 ${r.unique}）｜判定行 ${r.verdictLines} 行`);
  console.log(`各類：${CATEGORIES.map((c) => `${c} ${r.counts[c]}`).join('、')}｜相加 ${r.sum}`);
  if (r.picked === 0) { console.log('對不上：log 裡一條挑選都沒有（不是這種 log，或沒跑到開始）'); process.exit(1); }
  if (r.problems.length) { for (const p of r.problems) console.log('對不上：' + p); process.exit(1); }
  console.log('對得上：每一條挑選恰好一個結果、一行判定，相加＝挑選＝不重複的結果');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
