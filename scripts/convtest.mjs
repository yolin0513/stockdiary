// 共用慣例副本跟主檔一致（scripts/convcheck.mjs）的測試（2026-10-08，Dispatch）。npm test 鏈每次都跑；不開子程序、不到 1 秒。
// 對照組走真實入口（convCheck 讀真的檔）：在暫存目錄放一份副本與幾種主檔，各自只差一個條件；每一種的判定理由照固定標籤的開頭比。
// 最後一條是真的去比本 repo 的副本與統籌工作區的主檔——換一台沒有統籌工作區的機器會紅（讀不到主檔），照設計，不靜默跳過。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, section, done } from './tap.mjs';
import { convCheck, MASTER_REL, COPY_REL } from './convcheck.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

section('共用慣例副本跟主檔一致');
ok(!path.isAbsolute(MASTER_REL) && !/^[A-Za-z]:/.test(MASTER_REL) && !MASTER_REL.includes('\\'),
  '（前提）副本比對：主檔路徑用相對於 repo 根目錄的寫法登記（repo 公開，不寫本機絕對路徑）', MASTER_REL);

const copyText = fs.readFileSync(path.join(ROOT, COPY_REL), 'utf8');
const first = copyText.split('\n')[0];
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'convtest-'));
try {
  const put = (name, text) => { fs.writeFileSync(path.join(T, name), text); return fs.readFileSync(path.join(T, name), 'utf8') === text; };
  const otherVer = copyText.split(first).join('<!-- CONVENTIONS v0.0 2000-01-01 -->');
  const otherBody = copyText.split('適用：').join('適應：');
  ok(put('copy.md', copyText) && put('same.md', copyText) && put('ver.md', otherVer) && put('body.md', otherBody)
    && otherVer !== copyText && otherBody !== copyText && otherVer.split('\n')[0] !== first && otherBody.split('\n')[0] === first,
    '（前提）副本比對：四份樣本都寫進檔、讀回相同；改版本那份只有第一行不同，改內文那份第一行相同');
  const at = (masterRel) => convCheck(T, { copyRel: 'copy.md', masterRel });
  const same = at('same.md');
  ok(same.ok && same.why.startsWith('一致'), '副本比對・原樣（必過）：內容一樣的另一個檔 → 一致', same.why);
  const ver = at('ver.md');
  ok(!ver.ok && ver.why.startsWith('版本不同：'), '副本比對・版本不同：主檔第一行的版本跟副本不同 → 紅、理由是版本不同', ver.why);
  const body = at('body.md');
  ok(!body.ok && body.why.startsWith('全文不同：'), '副本比對・全文不同：版本行相同、內文差一個字 → 紅、理由是全文不同', body.why);
  const gone = at('沒有這個檔/CONVENTIONS.md');
  ok(!fs.existsSync(path.join(T, '沒有這個檔')) && !gone.ok && gone.why === '讀不到主檔', '副本比對・讀不到主檔：主檔不在 → 紅、講明讀不到主檔（不當成通過）', gone.why);
  const self = at('copy.md');
  ok(!self.ok && self.why.startsWith('同一個實體檔：'), '副本比對・同一個實體檔：主檔路徑指到副本自己 → 紅（拿自己比自己永遠一致）', self.why);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

const real = convCheck(ROOT);
ok(real.ok, `副本比對・真的去比：本 repo 的 ${COPY_REL} 跟統籌工作區的主檔一致`, real.why);

done('convtest');
