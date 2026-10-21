// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  blurhashEncode,
  dhashFromGray,
  hammingHex,
  hashWords,
  phashFromGray,
  popcount32,
} from '../src/hash.ts';
import { loadSharp, sharpProcessor, syntheticImage } from './helpers.ts';

const gray = (w: number, h: number, f: (x: number, y: number) => number) => {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = f(x, y);
  return a;
};

describe('pure hashes', () => {
  test('pHash is 16 hex chars, stable, and tolerant to small noise', () => {
    const img = gray(
      32,
      32,
      (x, y) => 120 + 50 * Math.sin(x / 4) * Math.cos(y / 6) + 30 * Math.sin((x + 2 * y) / 7) + x,
    );
    const h1 = phashFromGray(img);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(phashFromGray(img)).toBe(h1);
    const noisy = img.map((v, i) => Math.min(255, v + ((i * 7919) % 5)));
    expect(hammingHex(h1, phashFromGray(noisy))).toBeLessThanOrEqual(8);
    const other = gray(32, 32, (x, y) => 100 + 60 * Math.cos(y / 4) + 40 * Math.sin(x / 9) - y);
    expect(hammingHex(h1, phashFromGray(other))).toBeGreaterThan(16);
  });

  test('dHash encodes horizontal gradients', () => {
    expect(dhashFromGray(gray(9, 8, (x) => 255 - x * 20))).toBe('ffffffffffffffff');
    expect(dhashFromGray(gray(9, 8, (x) => x * 20))).toBe('0000000000000000');
  });

  test('hamming / popcount / words', () => {
    expect(hammingHex('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingHex('0f', '0e')).toBe(1);
    expect(hammingHex('00', '000')).toBe(Number.POSITIVE_INFINITY);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0b1011)).toBe(3);
    expect(hashWords('00000001ffffffff')).toEqual([1, 0xffffffff]);
    expect(hashWords('xyz')).toBeNull();
  });

  test('BlurHash has the expected shape and encodes a flat colour', () => {
    const px = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < px.length; i += 4) px.set([255, 0, 0, 255], i);
    const h = blurhashEncode(px, 8, 8, 4, 4, 3);
    expect(h).toHaveLength(4 + 2 * 11 + 2);
    // size flag for 4×3 components is 3 + 2·9 = 21 → 'L'
    expect(h[0]).toBe('L');
    // flat image → all AC components neutral
    expect(blurhashEncode(px, 8, 8, 4, 1, 1)).toHaveLength(6);
    expect(() => blurhashEncode(px, 8, 8, 4, 10, 1)).toThrow();
  });
});

describe('sharp-backed hashes', async () => {
  const sharp = await loadSharp();
  const proc = await sharpProcessor();
  const hashOf = async (b: Uint8Array, type = 'image/png') => {
    const [p, d] = await proc!.process(b, type, [
      { op: 'perceptual-hash' },
      { op: 'perceptual-hash', format: 'dhash' },
    ]);
    return { p: p!.hash!, d: d!.hash!, w: p!.width, bh: p!.blurhash };
  };

  test.skipIf(!sharp)('stable across runs and encodings', async () => {
    const a = await hashOf(await syntheticImage(sharp!, 1));
    const b = await hashOf(await syntheticImage(sharp!, 1));
    expect(a).toEqual(b);
    expect(a.w).toBe(256);
    expect(a.bh).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{28}$/);
  });

  test.skipIf(!sharp)('near-duplicates are close, different images are far', async () => {
    const orig = await hashOf(await syntheticImage(sharp!, 1));
    const near = await hashOf(
      await syntheticImage(sharp!, 1, { width: 180, height: 180, format: 'jpeg', quality: 50 }),
      'image/jpeg',
    );
    expect(hammingHex(orig.p, near.p)).toBeLessThanOrEqual(8);
    expect(hammingHex(orig.d, near.d)).toBeLessThanOrEqual(8);
    for (const seed of [2, 3, 4, 5]) {
      const other = await hashOf(await syntheticImage(sharp!, seed));
      expect(hammingHex(orig.p, other.p)).toBeGreaterThan(12);
    }
  });

  test.skipIf(!sharp)('fixture list hashes still match the synthetic images', async () => {
    const s1 = await hashOf(await syntheticImage(sharp!, 1));
    const s4 = await hashOf(await syntheticImage(sharp!, 4));
    expect(hammingHex(s1.p, '9be4e19e67998621')).toBeLessThanOrEqual(4);
    expect(hammingHex(s4.d, '24240c0c0c242424')).toBeLessThanOrEqual(4);
  });
});
