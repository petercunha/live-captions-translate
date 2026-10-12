#!/usr/bin/env node
// Draws the toolbar icon (a caption box with two text lines) as PNGs, so the
// repo needs no image tooling. Run once; the output is checked in.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

// Signed distance to a rounded rectangle centred at (cx, cy).
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function pixel(u, v) {
  // u, v in [0, 1]. Background tile, then two caption bars on top.
  if (roundedRect(u, v, 0.5, 0.5, 0.47, 0.47, 0.2) > 0) return null;
  const t = v; // vertical gradient indigo -> blue
  const bg = [Math.round(79 - 42 * t), Math.round(70 + 29 * t), Math.round(229 + 6 * t)];
  if (roundedRect(u, v, 0.5, 0.42, 0.3, 0.075, 0.075) <= 0) return [255, 255, 255];
  if (roundedRect(u, v, 0.41, 0.64, 0.21, 0.075, 0.075) <= 0) return [255, 255, 255];
  return bg;
}

function render(size) {
  const ss = 4; // supersampling for anti-aliased edges
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = 1 + x * 4;
      if (a) { row[o] = r / a; row[o + 1] = g / a; row[o + 2] = b / a; }
      row[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(join(OUT, `${size}.png`), render(size));
console.log('icons written to extension/icons/');
