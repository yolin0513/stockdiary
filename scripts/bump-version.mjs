// 一次改完四個地方的版本號（npm run bump -- stockdiary-v0.5.2）。
//
// 版本號必須同時出現在 js/version.js、sw.js、index.html 的 ?v= 參數裡。
// 漏改一個，瀏覽器就可能把新舊檔案湊在一起 —— 那就是「按按鈕跳回首頁」的成因。
//
// package.json 的 version 是第四處。它不影響執行期（沒有程式讀它），
// 但它是別人判斷「這包是哪一版」的第一個地方 —— 停在 0.1.0 而 App 已經 0.7.x，
// 看的人會以為 repo 沒在動。去掉 stockdiary-v 前綴以符合 npm 的 semver 格式。
//
// shelltest 會斷言四者一致。

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
  // npm 的 version 不吃 stockdiary-v 前綴，只放 x.y.z
  'package.json': (s) => s.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${next.replace('stockdiary-v', '')}"`),
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
  // package.json 寫的是去掉前綴的 0.7.16，印成 stockdiary-v0.7.16 會讓人以為寫錯了
  const shown = rel === 'package.json' ? next.replace('stockdiary-v', '') : next;
  console.log(`${rel} → ${shown}`);
}
console.log('\n記得跑 npm test');
