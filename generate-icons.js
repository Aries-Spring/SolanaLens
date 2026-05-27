#!/usr/bin/env node
// Run once: node generate-icons.js
// Generates icons/icon16.png, icons/icon48.png, icons/icon128.png
// No npm dependencies required.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 48, 128];

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function makePng(size) {
  // Purple (#9945FF) to green (#14F195) horizontal gradient, circular mask
  const px = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = x / Math.max(size - 1, 1);
      const r = Math.round(0x99 + (0x14 - 0x99) * t);
      const g = Math.round(0x45 + (0xf1 - 0x45) * t);
      const b = Math.round(0xff + (0x95 - 0xff) * t);

      const cx = (size - 1) / 2;
      const cy = (size - 1) / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const edge = size / 2 - 0.5;
      // Anti-alias the circle edge
      const alpha = dist <= edge - 1
        ? 255
        : dist <= edge
          ? Math.round((edge - dist) * 255)
          : 0;

      const i = (y * size + x) * 4;
      px[i]     = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = alpha;
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filter
  ihdr[12] = 0; // no interlace

  // Build raw image data: prepend filter byte 0 to each scanline
  const scanlines = [];
  for (let y = 0; y < size; y++) {
    scanlines.push(Buffer.from([0]));
    scanlines.push(Buffer.from(px.slice(y * size * 4, (y + 1) * size * 4)));
  }
  const idat = zlib.deflateSync(Buffer.concat(scanlines), { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of SIZES) {
  const png = makePng(size);
  const out = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✓ icons/icon${size}.png  (${png.length} bytes)`);
}
