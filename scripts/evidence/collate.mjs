// 【本質一次性，保留供重做】用途：判定改嚴時「多紅了別組」的逐條清單（27 條）｜比較：舊判定（只要一條對上 expect）vs 新判定（只紅對應的那一種）｜數字在：docs/EVIDENCE_檢查器修補.md「**判定器：突變要「只紅對應的那一種」」｜不用守：對明確的舊 commit 量一次，舊版不會再變；新版由常設測試守著（證據檔「盤點」一節）
// 在目前目錄（開發複本）逐條套指定的突變、跑測試，取出**全部**失敗的斷言，列出不含 expect 的那幾條（多紅的），
// 並替每一條找出在測試原始碼裡對得到的最長字面開頭（alsoRed 要用字面）。每條之後還原並比雜湊。
// 用法：node collate.mjs <名稱清單檔（一行一個）> <輸出 JSON>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [listFile, outFile] = process.argv.slice(2);
const names = fs.readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const { loadMutations, failedAssertions, applyMutation } = await import(pathToFileURL(path.resolve('scripts/mutjudge.mjs')).href);
const APP_VERSION = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync('js/version.js', 'utf8'))[1];
const MUTS = loadMutations(fs.readFileSync('scripts/mutationtest.mjs', 'utf8'), APP_VERSION);
const h = (s) => crypto.createHash('sha1').update(s).digest('hex');
const out = {};
for (const name of names) {
  const m = MUTS.find((x) => x.name === name);
  if (!m) { out[name] = { error: '找不到這條突變' }; console.log(`✗ ${name}：找不到`); continue; }
  const orig = fs.readFileSync(m.file, 'utf8');
  if (orig.split(m.find).length !== 2) { out[name] = { error: '錨點不是剛好一次' }; console.log(`✗ ${name}：錨點`); continue; }
  fs.writeFileSync(m.file, applyMutation(orig, m.find, m.replace));
  const r = spawnSync(process.execPath, [`scripts/${m.test}.mjs`], { encoding: 'utf8', timeout: 300000 });
  fs.writeFileSync(m.file, orig);
  if (h(fs.readFileSync(m.file, 'utf8')) !== h(orig)) { console.log(`✗ ${m.file} 沒還原`); process.exit(1); }
  const failed = failedAssertions(`${r.stdout}${r.stderr}`);
  const testSrc = fs.readFileSync(`scripts/${m.test}.mjs`, 'utf8');
  // 還沒寫 expect 的突變，全部失敗都要列出來（2026-09-24 補 expect 第一批時發現：以前 includes(undefined) 會比對字串
  // 「undefined」，訊息裡剛好印出 undefined 的那幾條被濾掉，漏列成 alsoRed）
  const extras = m.expect ? failed.filter((f) => !f.includes(m.expect)) : failed;
  // 最長字面開頭：從整句往前縮，直到測試原始碼裡找得到（至少 6 個字）
  const anchor = (msg) => {
    for (let n = msg.length; n >= 6; n -= 1) { const p = msg.slice(0, n); if (testSrc.includes(p)) return p; }
    return null;
  };
  const anchors = [...new Set(extras.map(anchor))];
  out[name] = { test: m.test, expect: m.expect, status: r.status, hitExpect: failed.some((f) => f.includes(m.expect)), extras, anchors };
  console.log(`● ${name}（${m.test}）：紅 ${failed.length} 條、多紅 ${extras.length} 條；字面開頭 ${JSON.stringify(anchors)}`);
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
