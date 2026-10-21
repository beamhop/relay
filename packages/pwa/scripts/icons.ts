// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generates the PWA icons (static/icon-192.png, static/icon-512.png) without
 * image tooling: a dark square with an indigo "beam" ring and dot.
 * Run: bun scripts/icons.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / size;
      // Background #09090b, ring and dot in indigo #818cf8 with soft edges.
      const ring = 1 - Math.min(1, Math.abs(d - 0.28) / 0.035);
      const dot = 1 - Math.min(1, Math.max(0, d - 0.1) / 0.02);
      const a = Math.max(0, Math.min(1, Math.max(ring, dot)));
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = Math.round(9 + (129 - 9) * a);
      raw[i + 1] = Math.round(9 + (140 - 9) * a);
      raw[i + 2] = Math.round(11 + (248 - 11) * a);
      raw[i + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const dir = join(import.meta.dir, '../static');
for (const s of [192, 512]) writeFileSync(join(dir, `icon-${s}.png`), png(s));
console.log('icons written');
