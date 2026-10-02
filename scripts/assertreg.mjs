// 斷言登記表（2026-10-03，Dispatch：唯一性與涵蓋性共用同一份資料）。
//
//   node scripts/assertreg.mjs build <測試名> <那支測試一次跑完的 log>    從實跑的輸出建表，寫進 docs/assertions/<測試名>.json
//
// 為什麼：突變的預期（expect）比的是失敗訊息的開頭，但「同一段開頭可能是好幾條斷言共同的開頭」（遊戲那邊 31 條、本 App 的 GV 兩條）——
// 隨便哪一條紅都算過。要知道一段預期對應到幾條斷言，得先有那支測試真正的斷言名稱，靜態讀原始碼看不出樣板在迴圈裡長出幾條。
// 表從一次「跑完」的 log 建（只認那支測試自己的結算行，跟 longrun 同一個判準；沒跑完就不建）：
//   · 每一條斷言一個編號（照出現順序），名稱不得重複——重複就不建、點名是哪幾條
//   · 表的「版本」＝條數＋名稱清單的雜湊。每條突變的預期戳著寫它的時候那一版（regStamp）；版本變了而預期沒跟上 → 預期需要複審
// 名稱來自測試輸出，只含斷言訊息（不含細節行），所以不會帶進路徑或資料。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hasSummary } from './mutjudge.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REG_DIR = path.join(ROOT, 'docs', 'assertions');

/** 從一支測試的輸出取出全部斷言名稱（行首「  ✓ 」或「  ✗ 」；tap 只讓判定行出現在行首）。 */
export function assertionNames(out) {
  const names = [];
  for (const l of String(out).replace(/\r/g, '').split('\n')) {
    const m = /^ {2}[✓✗] (.+)$/.exec(l);
    if (m) names.push(m[1]);
  }
  return names;
}

/** 名稱清單的版本：條數＋雜湊。 */
export const versionOf = (names) => `${names.length}:${crypto.createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 12)}`;

/** 建表；名稱重複或沒跑完就丟例外（不建一份不可信的表）。 */
export function buildRegistry(test, out) {
  if (!hasSummary(out, test)) throw new Error(`${test} 這一份輸出沒有它自己的結算行（沒跑完），不建表`);
  // 要全綠才建（2026-10-03：第一版只認結算行，一場有斷言紅了的輸出照樣建了表——結算行在紅的時候也會印）
  const summary = String(out).replace(/\r/g, '').split('\n').find((l) => l.startsWith(`${test}：`) && /^\d+ 項通過/.test(l.slice(test.length + 1))) ?? '';
  if (/項失敗/.test(summary)) throw new Error(`${test} 這一場不是全綠（${summary.trim()}），不建表`);
  const names = assertionNames(out);
  if (!names.length) throw new Error(`${test} 的輸出裡一條斷言都沒有`);
  const seen = new Map();
  const dup = [];
  names.forEach((n, i) => { if (seen.has(n)) dup.push(`第 ${seen.get(n) + 1} 與第 ${i + 1} 條：${n.slice(0, 60)}`); else seen.set(n, i); });
  if (dup.length) throw new Error(`${test} 有重名的斷言（編號不唯一）：${dup.join('；')}`);
  return { test, version: versionOf(names), count: names.length, assertions: names.map((name, i) => ({ id: `${test}#${i + 1}`, name })) };
}

/** 讀一支測試的表；沒有就回 null。 */
export function loadRegistry(test, dir = REG_DIR) {
  const f = path.join(dir, `${test}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/** 以 prefix 開頭的斷言（判定比的是開頭，所以對應到的就是這些）。 */
export const matchesOf = (reg, prefix) => reg.assertions.filter((a) => a.name.startsWith(prefix));

/**
 * 預期的版本戳記（突變名稱 → 寫那條預期時的登記表版本）。突變清單裡寫了 regStamp 的以清單為準。
 * 由 `assertreg stamp <測試>` 寫：只戳「剛好對到 1 條、alsoRed 都對得到」的——有問題的不戳，留著讓檢查報出來。
 */
export const STAMPS = path.join(REG_DIR, 'stamps.json');
export function loadStamps(file = STAMPS) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

async function main() {
  const [cmd, test, log] = process.argv.slice(2);
  if (cmd === 'build' && test && log) {
    const reg = buildRegistry(test, fs.readFileSync(log, 'utf8'));
    fs.mkdirSync(REG_DIR, { recursive: true });
    fs.writeFileSync(path.join(REG_DIR, `${test}.json`), JSON.stringify(reg, null, 1) + '\n');
    console.log(`斷言登記表：${test} ${reg.count} 條、版本 ${reg.version} → docs/assertions/${test}.json`);
    return;
  }
  if (cmd === 'stamp' && test) {
    // 複審完才戳：每一條帶 expect、測試是這一支的突變，剛好對到 1 條、alsoRed 都對得到，才記下這一版
    const { loadMutations } = await import('./mutjudge.mjs');
    const reg = loadRegistry(test);
    if (!reg) { console.error(`${test} 沒有斷言登記表，先 build`); process.exit(1); }
    const ver = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];
    const muts = loadMutations(fs.readFileSync(path.join(ROOT, 'scripts/mutationtest.mjs'), 'utf8'), ver).filter((m) => m.test === test && m.expect);
    const stamps = loadStamps();
    const skipped = [];
    let stamped = 0;
    for (const m of muts) {
      const one = matchesOf(reg, m.expect).length === 1;
      const also = (m.alsoRed || []).every((a) => matchesOf(reg, a).length > 0);
      if (one && also) { stamps[m.name] = reg.version; stamped += 1; } else skipped.push(`${m.name}（${one ? 'alsoRed 對不到' : `對到 ${matchesOf(reg, m.expect).length} 條`}）`);
    }
    fs.writeFileSync(STAMPS, JSON.stringify(Object.fromEntries(Object.entries(stamps).sort()), null, 1) + '\n');
    console.log(`戳記：${test} 帶 expect 的 ${muts.length} 條，戳了 ${stamped} 條（版本 ${reg.version}），沒戳 ${skipped.length} 條${skipped.length ? `：${skipped.join('、')}` : ''}`);
    return;
  }
  console.error('用法：node scripts/assertreg.mjs build <測試名> <log>｜stamp <測試名>');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
