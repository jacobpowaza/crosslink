#!/usr/bin/env node
/**
 * Generates the PWA icons (icon-180/192/512.png) — dark rounded square with
 * two interlocking rings (the "crosslink" glyph). Pure Node, no deps.
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const BG = [15, 23, 42]; // #0f172a
const FG = [56, 189, 248]; // #38bdf8

/* ------------------------------ PNG encode ----------------------------- */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ------------------------------- drawing ------------------------------- */

function makeIcon(size) {
  const radius = size * 0.22; // corner radius
  const ringR = size * 0.16; // ring radius
  const thick = size * 0.055; // ring stroke
  const gap = size * 0.13; // ring center offset from middle
  const cy = size / 2;
  const c1x = size / 2 - gap;
  const c2x = size / 2 + gap;

  const inRoundedRect = (x, y) => {
    const qx = Math.min(x, size - 1 - x);
    const qy = Math.min(y, size - 1 - y);
    if (qx >= radius || qy >= radius) return true;
    const dx = radius - qx;
    const dy = radius - qy;
    return dx * dx + dy * dy <= radius * radius;
  };
  const onRing = (x, y, cx) => {
    const d = Math.hypot(x - cx, y - cy);
    return Math.abs(d - ringR) <= thick / 2;
  };

  return encodePng(size, (x, y) => {
    if (!inRoundedRect(x, y)) return [0, 0, 0, 0];
    if (onRing(x, y, c1x) || onRing(x, y, c2x)) return [...FG, 255];
    return [...BG, 255];
  });
}

for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, makeIcon(size));
  console.log(`wrote ${file}`);
}
