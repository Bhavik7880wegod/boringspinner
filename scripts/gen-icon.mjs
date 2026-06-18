// scripts/gen-icon.mjs — generates media/icon.png.
// Phase 1: writes a minimal valid 128x128 solid PNG so the manifest's `icon`
// field resolves and vsce packages cleanly. TODO(Phase 6): real brand icon.
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, '..', 'media', 'icon.png');

const W = 128;
const H = 128;
// BoringSpinner brand-ish dark slate with a teal cast.
const [R, G, B, A] = [14, 24, 32, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// Raw image: each scanline prefixed with filter byte 0.
const rowLen = 1 + W * 4;
const raw = Buffer.alloc(rowLen * H);
for (let y = 0; y < H; y++) {
  const off = y * rowLen;
  raw[off] = 0;
  for (let x = 0; x < W; x++) {
    const p = off + 1 + x * 4;
    raw[p] = R;
    raw[p + 1] = G;
    raw[p + 2] = B;
    raw[p + 3] = A;
  }
}
const idat = zlib.deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`[coads] wrote ${out} (${png.length} bytes)`);
