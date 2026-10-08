// scripts/docguard.mjs 的測試（共用慣例 §6.5）。npm test 鏈；不開子程序、不到 1 秒。
// 從真實入口（guardedWrite 寫真的檔）驗：被擋的那幾種，檔案內容一個字都沒變（先確認原本的內容在，再驗它還在）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok, section, done } from './tap.mjs';
import { guardedWrite } from './docguard.mjs';

section('用腳本改文件：行數只准變多、章節標題都要在');
const ORIG = '# 標題\n\n## 第一節\n內容一\n\n## 第二節\n內容二\n';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'docguardtest-'));
try {
  const F = path.join(T, 'doc.md');
  /** 放回原文 → 試著寫 → 回傳 { threw, why, after } */
  const attempt = (text, opts) => {
    fs.writeFileSync(F, ORIG);
    const seeded = fs.readFileSync(F, 'utf8') === ORIG;
    let threw = false; let why = '';
    try { guardedWrite(F, text, opts); } catch (e) { threw = true; why = String(e.message); }
    return { seeded, threw, why, after: fs.readFileSync(F, 'utf8') };
  };
  const grow = attempt(ORIG + '新增一行\n');
  ok(grow.seeded && !grow.threw && grow.after === ORIG + '新增一行\n', '文件守門・變多（必過）：多一行、標題都在 → 寫回', grow.why);
  const cut = attempt('# 標題\n\n## 第一節\n內容一\n');
  ok(cut.seeded && cut.threw && cut.why.includes('行數變少：') && cut.after === ORIG, '文件守門・截斷：後半份不見（行數變少）→ 不寫、原檔一字不變', cut.why);
  const shrinkOk = attempt('# 標題\n\n## 第一節\n\n## 第二節\n內容二\n', { allowShrink: true });
  ok(shrinkOk.seeded && !shrinkOk.threw, '文件守門・明講要刪（必過）：allowShrink、標題都在 → 寫回', shrinkOk.why);
  const renamed = attempt('# 標題\n\n## 第一節\n內容一\n\n## 第二節（改名）\n內容二\n');
  ok(renamed.seeded && renamed.threw && renamed.why.includes('章節標題不見：## 第二節') && !renamed.why.includes('行數變少') && renamed.after === ORIG,
    '文件守門・標題不見：行數沒變、有一個標題被改掉 → 不寫、原檔一字不變', renamed.why);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done('docguardtest');
