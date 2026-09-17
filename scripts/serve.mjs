// 極簡靜態檔伺服器，給測試與 npm run dev 用（不裝任何相依）。
// 只服務專案根目錄底下的檔案，路徑一律正規化後再比對，不讓 ../ 跑出去。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
};

/**
 * shouldFail(pathname) 回 true 的請求回 404 —— 給測試模擬「某一個檔在網路不穩的那幾秒拿不到」。
 * 沒傳就跟以前一模一樣。
 */
/** shouldHang(pathname) 回 true 的請求**永遠不回應** —— 沒有 404、沒有 error 事件，只有等。 */
export function createServer({ shouldFail = null, shouldHang = null } = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (shouldHang && shouldHang(url.pathname)) return;   // 連 header 都不送
    if (shouldFail && shouldFail(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('not found (injected)');
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(ROOT, '.' + rel);
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
}

export function listen(port = 0, opts = {}) {
  return new Promise((resolve) => {
    const srv = createServer(opts);
    srv.listen(port, () => resolve({ srv, port: srv.address().port }));
  });
}

if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const port = Number(process.argv[2] || 5180);
  listen(port).then(({ port: p }) => console.log(`http://localhost:${p}/`));
}
