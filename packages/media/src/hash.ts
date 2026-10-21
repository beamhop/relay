// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Perceptual hashes and BlurHash computed from raw pixels (no extra library).
 * Runtime-agnostic: callers decode/resize images (sharp, Cloudflare Images, …)
 * and pass the raw buffers here.
 *
 * - pHash: 32×32 grayscale → 2-D DCT-II → top-left 8×8 low frequencies →
 *   bit = coefficient > median (DC excluded from the median). 64 bits, 16 hex chars.
 * - dHash: 9×8 grayscale → bit = pixel brighter than its right neighbour. 64 bits.
 * Similar images have a small Hamming distance between their hashes.
 */

export const PHASH_SIZE = 32;
export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;

const HEX = '0123456789abcdef';

function bitsToHex(bits: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bits.length; i += 4) {
    const n =
      ((bits[i] ?? 0) << 3) |
      ((bits[i + 1] ?? 0) << 2) |
      ((bits[i + 2] ?? 0) << 1) |
      (bits[i + 3] ?? 0);
    out += HEX[n];
  }
  return out;
}

/** cos((2x+1)uπ / 2N) for x < N, u < 8. */
const DCT_TABLE: Float64Array = (() => {
  const t = new Float64Array(PHASH_SIZE * 8);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < PHASH_SIZE; x++) {
      t[u * PHASH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE));
    }
  }
  return t;
})();

/** pHash of a 32×32 single-channel (grayscale) image given row-major. */
export function phashFromGray(gray: ArrayLike<number>): string {
  const N = PHASH_SIZE;
  if (gray.length < N * N) throw new Error(`pHash needs ${N}×${N} grayscale pixels`);
  // Separable DCT: rows first (only the 8 lowest frequencies are needed), then columns.
  const rows = new Float64Array(N * 8);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += (gray[y * N + x] ?? 0) * (DCT_TABLE[u * N + x] ?? 0);
      rows[y * 8 + u] = s;
    }
  }
  const coeffs = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += (rows[y * 8 + u] ?? 0) * (DCT_TABLE[v * N + y] ?? 0);
      coeffs[v * 8 + u] = s;
    }
  }
  const ac = Array.from(coeffs.subarray(1)).sort((a, b) => a - b);
  const median = ((ac[31] ?? 0) + (ac[32] ?? 0)) / 2;
  const bits = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bits[i] = (coeffs[i] ?? 0) > median ? 1 : 0;
  return bitsToHex(bits);
}

/** dHash of a 9×8 single-channel image given row-major. */
export function dhashFromGray(gray: ArrayLike<number>): string {
  const W = DHASH_WIDTH;
  const H = DHASH_HEIGHT;
  if (gray.length < W * H) throw new Error(`dHash needs ${W}×${H} grayscale pixels`);
  const bits = new Uint8Array(64);
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits[i++] = (gray[y * W + x] ?? 0) > (gray[y * W + x + 1] ?? 0) ? 1 : 0;
    }
  }
  return bitsToHex(bits);
}

const POP4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Hamming distance between two equal-length hex strings (Infinity when incomparable). */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number.parseInt(a[i] as string, 16) ^ Number.parseInt(b[i] as string, 16);
    if (Number.isNaN(x)) return Number.POSITIVE_INFINITY;
    d += POP4[x] ?? 0;
  }
  return d;
}

/** 32-bit popcount. */
export function popcount32(n: number): number {
  let v = n >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Split a 16-hex-char (64-bit) hash into two uint32 halves for fast comparisons. */
export function hashWords(hex: string): [number, number] | null {
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  return [Number.parseInt(hex.slice(0, 8), 16) >>> 0, Number.parseInt(hex.slice(8), 16) >>> 0];
}

// ───────────────────────────── BlurHash ─────────────────────────────

const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encode83(n: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(n / 83 ** (length - i)) % 83;
    out += B83[digit];
  }
  return out;
}

function srgbToLinear(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const x = Math.max(0, Math.min(1, v));
  return x <= 0.0031308
    ? Math.trunc(x * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * x ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

const signPow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

/**
 * BlurHash encoder (https://blurha.sh, algorithm by Wolt, MIT).
 * `pixels` are row-major with `channels` (3 = RGB, 4 = RGBA) bytes per pixel.
 * Feed a small image (e.g. 32×32) — cost is O(w·h·cx·cy).
 */
export function blurhashEncode(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels = 4,
  componentsX = 4,
  componentsY = 3,
): string {
  if (componentsX < 1 || componentsX > 9 || componentsY < 1 || componentsY > 9) {
    throw new Error('BlurHash components must be 1..9');
  }
  if (pixels.length < width * height * channels) throw new Error('BlurHash: not enough pixels');
  const factors: Array<[number, number, number]> = [];
  for (let j = 0; j < componentsY; j++) {
    for (let i = 0; i < componentsX; i++) {
      const norm = i === 0 && j === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < height; y++) {
        const cy = Math.cos((Math.PI * j * y) / height);
        for (let x = 0; x < width; x++) {
          const basis = Math.cos((Math.PI * i * x) / width) * cy;
          const p = (y * width + x) * channels;
          r += basis * srgbToLinear(pixels[p] ?? 0);
          g += basis * srgbToLinear(pixels[p + 1] ?? 0);
          b += basis * srgbToLinear(pixels[p + 2] ?? 0);
        }
      }
      const scale = norm / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }
  const [dc, ...ac] = factors as [[number, number, number], ...Array<[number, number, number]>];
  let hash = encode83(componentsX - 1 + (componentsY - 1) * 9, 1);
  let maxValue = 1;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.flatMap((f) => f.map(Math.abs)));
    const quantMax = Math.floor(Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5))));
    maxValue = (quantMax + 1) / 166;
    hash += encode83(quantMax, 1);
  } else {
    hash += encode83(0, 1);
  }
  hash += encode83(
    (linearToSrgb(dc[0]) << 16) + (linearToSrgb(dc[1]) << 8) + linearToSrgb(dc[2]),
    4,
  );
  for (const f of ac) {
    const q = (v: number) =>
      Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(v / maxValue, 0.5) * 9 + 9.5))));
    hash += encode83(q(f[0]) * 19 * 19 + q(f[1]) * 19 + q(f[2]), 2);
  }
  return hash;
}
