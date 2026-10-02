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
  const t = timingOf(lines, firstCat);
  problems.push(...t.problems);
  return { picked: picked.length, results: results.length, unique: seen.size, counts, sum, verdictLines: vTotal, problems, timing: t };
}

/** 算數的類別：這幾類代表「測試跑完了、判了紅或綠」——一定要有結算行。 */
export const COUNTED = ['紅在對的地方', '沒紅', '紅錯地方', '多紅了別組'];
/** 耗時短於基準的這個比例，列成「可能被中斷、需重驗」（MealMate 那筆是 9 秒對 50 秒，約 0.18）。 */
export const SHORT_RATIO = 1 / 3;

/**
 * 第二個來源（2026-10-03，MealMate 同日）：「基準耗時｜測試｜秒」與「耗時｜名稱｜測試｜秒｜結算行有/沒有」。
 *   · 算數的結果，耗時行卻寫「結算行沒有」→ 判定器漏了（被中斷的被記成紅／綠），對不上
 *   · 新格式（有基準耗時行）的 log，每一條有結果、而且跑過測試的（算數或情境未成立），都要恰好一行耗時
 *   · 耗時短於那支基準的 SHORT_RATIO → 列成「可能被中斷、需重驗」（提醒，不擋：有結算行就是跑完了）
 * 舊格式（沒有基準耗時行）的 log：掃不到，照實回 legacy=true，不當成「沒有偏短的」。
 */
export function timingOf(lines, firstCat) {
  const base = new Map();
  const runs = new Map();
  const problems = [];
  for (const l of lines) {
    let m = /^ {2}· 基準耗時｜([^｜]+)｜([\d.]+)$/.exec(l);
    if (m) { base.set(m[1], Number(m[2])); continue; }
    m = /^ {2}· 耗時｜(.+)｜([^｜]+)｜([\d.]+)｜結算行(有|沒有)$/.exec(l);
    if (m) {
      if (runs.has(m[1])) problems.push(`同一條有不只一行耗時：${m[1]}`);
      runs.set(m[1], { test: m[2], sec: Number(m[3]), summary: m[4] === '有' });
    }
  }
  if (base.size === 0) return { legacy: true, short: [], problems: runs.size ? ['有耗時行卻沒有基準耗時行'] : [] };
  const short = [];
  for (const [name, cat] of firstCat) {
    const ranTest = COUNTED.includes(cat) || cat === '情境未成立';
    const r = runs.get(name);
    if (!ranTest) continue;
    if (!r) { problems.push(`有結果（${cat}）卻沒有耗時行：${name}`); continue; }
    if (COUNTED.includes(cat) && !r.summary) problems.push(`算數的結果（${cat}）卻沒有跑到結算行——判定器漏了：${name}`);
    const b = base.get(r.test);
    if (b == null) { problems.push(`${name} 的測試 ${r.test} 沒有基準耗時`); continue; }
    if (COUNTED.includes(cat) && r.sec < b * SHORT_RATIO) short.push({ name, test: r.test, sec: r.sec, base: b, cat });
  }
  return { legacy: false, short, problems };
}

function main() {
  const f = process.argv[2];
  if (!f) { console.error('用法：node scripts/mutlog.mjs <log>'); process.exit(2); }
  const r = countLog(fs.readFileSync(f, 'utf8'));
  console.log(`從 log 逐行數：挑選 ${r.picked} 條｜結果行 ${r.results} 行（不重複 ${r.unique}）｜判定行 ${r.verdictLines} 行`);
  console.log(`各類：${CATEGORIES.map((c) => `${c} ${r.counts[c]}`).join('、')}｜相加 ${r.sum}`);
  if (r.timing.legacy) console.log('耗時：這份 log 沒有基準耗時行（2026-10-03 以前的格式）——掃不到被中斷的，不是「沒有被中斷的」');
  else {
    console.log(`耗時：算數的結果裡，短於該支基準 1/${Math.round(1 / SHORT_RATIO)} 的 ${r.timing.short.length} 條`);
    for (const s of r.timing.short) console.log(`  可能被中斷、需重驗：${s.name}（${s.test} ${s.sec} 秒，基準 ${s.base} 秒，記成${s.cat}）`);
  }
  if (r.picked === 0) { console.log('對不上：log 裡一條挑選都沒有（不是這種 log，或沒跑到開始）'); process.exit(1); }
  if (r.problems.length) { for (const p of r.problems) console.log('對不上：' + p); process.exit(1); }
  console.log('對得上：每一條挑選恰好一個結果、一行判定，相加＝挑選＝不重複的結果');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
