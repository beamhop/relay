// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import qrcode from 'qrcode-generator';
import { encodeQr, qrSvg } from '../src/qr.ts';

/** Read the mask pattern from a matrix's first format-info copy. */
function maskOf(isDark: (x: number, y: number) => boolean): number {
  const at: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) at.push([8, i]);
  at.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) at.push([14 - i, 8]);
  let bits = 0;
  at.forEach(([x, y], i) => {
    if (isDark(x, y)) bits |= 1 << i;
  });
  return ((bits ^ 0x5412) >>> 10) & 7;
}

const samples = [
  'wss://relay.example.com',
  'https://media.example.org/',
  'wss://a.very.long.hostname.for.a.community.relay.example.com/team/engineering',
  'x'.repeat(150),
  'ü – unicode ✓',
];

describe('qr encoder', () => {
  for (const text of samples) {
    test(`matches reference encoder: ${text.slice(0, 30)}`, () => {
      const ref = qrcode(0, 'M');
      ref.addData(String.fromCharCode(...new TextEncoder().encode(text)), 'Byte');
      ref.make();
      const n = ref.getModuleCount();
      const refMask = maskOf((x, y) => ref.isDark(y, x));
      const mine = encodeQr(text, { mask: refMask });
      expect(mine.size).toBe(n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (mine.modules[y]?.[x] !== ref.isDark(y, x)) {
            throw new Error(`module mismatch at ${x},${y} (v${mine.version}, mask ${refMask})`);
          }
        }
      }
    });
  }

  test('auto mask selection and svg output', () => {
    const qr = encodeQr('wss://relay.example.com');
    expect(qr.mask).toBeGreaterThanOrEqual(0);
    expect(qr.mask).toBeLessThan(8);
    const svg = qrSvg('wss://relay.example.com');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('aria-label="wss://relay.example.com"');
    expect(svg.length).toBeLessThan(8000);
  });
});
