// 產生 App 圖示（純 Node，無相依）。
// 設計：深藍底圓角方塊 ＋ 三根遞增的柱子（持股）＋ 右上一枚金色圓點（股利）。
// 不用箭頭、不用紅綠 —— 圖示不該暗示漲跌。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// ---------- PNG 編碼 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形狀（有號距離場，邊緣做抗鋸齒）----------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// d < 0 在形狀內；aa 是邊緣寬度（像素）
const cover = (d, aa) => clamp01(0.5 - d / aa);

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function draw(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = size / 220;
  // maskable 版本要留安全邊界（外圈 10% 會被系統裁掉），所以內容縮小
  const inset = maskable ? size * 0.18 : size * 0.09;
  const bgR = maskable ? size * 0.5 : size * 0.22;   // maskable 直接畫滿（圓形裁切）
  const content = size - inset * 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let r = 0; let g = 0; let b = 0; let a = 0;

      // 背景：深藍 → 靛藍的對角漸層
      const t = clamp01((px + py) / (size * 2));
      const bg = [
        Math.round(16 + (36 - 16) * t),
        Math.round(22 + (54 - 22) * t),
        Math.round(31 + (86 - 31) * t),
      ];
      const bgA = maskable
        ? 1
        : cover(sdRoundRect(px, py, size / 2, size / 2, size / 2 - size * 0.02, size / 2 - size * 0.02, bgR), aa);
      [r, g, b] = bg;
      a = bgA;

      const put = (col, cov) => {
        if (cov <= 0) return;
        const k = cov;
        r = Math.round(r * (1 - k) + col[0] * k);
        g = Math.round(g * (1 - k) + col[1] * k);
        b = Math.round(b * (1 - k) + col[2] * k);
        a = Math.max(a, Math.round(255 * k) / 255 * bgA + a * (1 - k));
      };

      // 三根遞增的柱子
      const barW = content * 0.16;
      const gap = content * 0.09;
      const baseY = inset + content * 0.80;
      const heights = [content * 0.26, content * 0.42, content * 0.58];
      const totalW = barW * 3 + gap * 2;
      const startX = inset + (content - totalW) / 2;
      const barColors = [[126, 169, 214], [156, 199, 237], [198, 226, 255]];
      for (let i = 0; i < 3; i += 1) {
        const cx = startX + i * (barW + gap) + barW / 2;
        const hh = heights[i] / 2;
        const cy = baseY - hh;
        put(barColors[i], cover(sdRoundRect(px, py, cx, cy, barW / 2, hh, barW * 0.28), aa));
      }

      // 右上一枚金色圓點：股利
      const coinR = content * 0.115;
      const coinX = inset + content * 0.80;
      const coinY = inset + content * 0.20;
      put([246, 197, 96], cover(sdCircle(px, py, coinX, coinY, coinR), aa));
      // 圓點中間挖一條深色橫槓，讓它在小尺寸下也看得出是硬幣不是光點
      put(bg, cover(sdRoundRect(px, py, coinX, coinY, coinR * 0.52, coinR * 0.16, coinR * 0.16), aa));

      const o = (y * size + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
      buf[o + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return png(size, size, buf);
}

const files = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of files) {
  const buf = draw(size, opts);
  writeFileSync(path.join(OUT, name), buf);
  console.log(`${name}  ${size}×${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
