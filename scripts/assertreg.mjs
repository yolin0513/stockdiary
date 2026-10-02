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

function main() {
  const [cmd, test, log] = process.argv.slice(2);
  if (cmd !== 'build' || !test || !log) { console.error('用法：node scripts/assertreg.mjs build <測試名> <log>'); process.exit(2); }
  const reg = buildRegistry(test, fs.readFileSync(log, 'utf8'));
  fs.mkdirSync(REG_DIR, { recursive: true });
  fs.writeFileSync(path.join(REG_DIR, `${test}.json`), JSON.stringify(reg, null, 1) + '\n');
  console.log(`斷言登記表：${test} ${reg.count} 條、版本 ${reg.version} → docs/assertions/${test}.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
