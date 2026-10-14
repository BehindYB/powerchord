/*
 * Renders the application icon (resources/icon.png, 512x512) without image dependencies:
 * shapes are rasterized with 4x4 supersampling and encoded as PNG with zlib.
 * Run with `node scripts/generate-icon.mjs` from apps/desktop.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const SAMPLES = 4;
const TOP = [0x8f, 0x75, 0xff];
const BOTTOM = [0x5b, 0x3b, 0xe0];
const FOREGROUND = [0xff, 0xff, 0xff];

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

// Three bars of different heights: the stacked notes of a chord.
const BARS = [
  { center: 0.33, height: 0.42 },
  { center: 0.5, height: 0.6 },
  { center: 0.67, height: 0.32 },
].map(({ center, height }) => {
  const width = 0.105 * SIZE;
  const middle = 0.5 * SIZE;
  return {
    left: center * SIZE - width / 2,
    right: center * SIZE + width / 2,
    top: middle - (height * SIZE) / 2,
    bottom: middle + (height * SIZE) / 2,
    radius: width / 2,
  };
});

function shade(x, y) {
  if (!insideRoundedRect(x, y, 0, 0, SIZE, SIZE, SIZE * 0.22)) return null;
  if (
    BARS.some((bar) =>
      insideRoundedRect(x, y, bar.left, bar.top, bar.right, bar.bottom, bar.radius),
    )
  ) {
    return FOREGROUND;
  }
  const t = y / SIZE;
  return TOP.map((value, index) => value + (BOTTOM[index] - value) * t);
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const color = shade(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
        if (!color) continue;
        sum[0] += color[0];
        sum[1] += color[1];
        sum[2] += color[2];
        sum[3] += 1;
      }
    }
    const offset = 1 + x * 4;
    if (sum[3] > 0) {
      row[offset] = Math.round(sum[0] / sum[3]);
      row[offset + 1] = Math.round(sum[1] / sum[3]);
      row[offset + 2] = Math.round(sum[2] / sum[3]);
      row[offset + 3] = Math.round((255 * sum[3]) / SAMPLES ** 2);
    }
  }
  rows.push(row);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../resources/icon.png', import.meta.url), png);
