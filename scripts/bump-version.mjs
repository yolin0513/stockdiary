// 一次改完三個地方的版本號（npm run bump -- stockdiary-v0.5.2）。
//
// 版本號必須同時出現在 js/version.js、sw.js、index.html 的 ?v= 參數裡。
// 漏改一個，瀏覽器就可能把新舊檔案湊在一起 —— 那就是「按按鈕跳回首頁」的成因。
// shelltest 會斷言三者一致。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const next = process.argv[2];

if (!/^stockdiary-v\d+\.\d+\.\d+$/.test(String(next))) {
  console.error('用法：npm run bump -- stockdiary-v0.5.2');
  process.exit(1);
}

const files = {
  'js/version.js': (s) => s.replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${next}';`),
  'sw.js': (s) => s.replace(/const VERSION = '[^']+';/, `const VERSION = '${next}';`),
  'index.html': (s) => s.replace(/\?v=stockdiary-v\d+\.\d+\.\d+/g, `?v=${next}`),
};

for (const [rel, fn] of Object.entries(files)) {
  const full = path.join(ROOT, rel);
  const before = fs.readFileSync(full, 'utf8');
  const after = fn(before);
  if (before === after) {
    console.error(`✗ ${rel} 沒有被改到 —— 版本號的寫法可能變了，請檢查`);
    process.exit(1);
  }
  fs.writeFileSync(full, after, 'utf8');
  console.log(`${rel} → ${next}`);
}
console.log('\n記得跑 npm test');
