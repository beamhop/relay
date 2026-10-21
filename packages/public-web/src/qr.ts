// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal QR code encoder (byte mode, error-correction level M, versions 1–40)
 * rendering to SVG on the server. No dependencies, Web-standard only.
 *
 * Algorithm follows ISO/IEC 18004 as laid out by Project Nayuki's reference
 * "QR Code generator library" (MIT); this is an independent compact rewrite.
 */

/** ECC codewords per block, level M, indexed by version. */
const ECC_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
/** Number of error-correction blocks, level M, indexed by version. */
const BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
/** Format-info bits for level M. */
const ECL_M_BITS = 0;

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** `modules[y][x]` true = dark. */
  modules: boolean[][];
}

function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - (ECC_M[ver] as number) * (BLOCKS_M[ver] as number);
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j] as number, root);
      if (j + 1 < r.length) r[j] = (r[j] as number) ^ (r[j + 1] as number);
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (r.shift() as number);
    r.push(0);
    divisor.forEach((coef, i) => {
      r[i] = (r[i] as number) ^ gfMul(coef, factor);
    });
  }
  return r;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Matrix {
  readonly m: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFn(x: number, y: number, dark: boolean): void {
    (this.m[y] as boolean[])[x] = dark;
    (this.fn[y] as boolean[])[x] = true;
  }
  get(x: number, y: number): boolean {
    return (this.m[y] as boolean[])[x] as boolean;
  }
  isFn(x: number, y: number): boolean {
    return (this.fn[y] as boolean[])[x] as boolean;
  }
}

function drawFormat(mx: Matrix, mask: number): void {
  const data = (ECL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const s = mx.size;
  for (let i = 0; i <= 5; i++) mx.setFn(8, i, bit(bits, i));
  mx.setFn(8, 7, bit(bits, 6));
  mx.setFn(8, 8, bit(bits, 7));
  mx.setFn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) mx.setFn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) mx.setFn(s - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) mx.setFn(8, s - 15 + i, bit(bits, i));
  mx.setFn(8, s - 8, true);
}

function drawFunctionPatterns(mx: Matrix, ver: number): void {
  const s = mx.size;
  for (let i = 0; i < s; i++) {
    mx.setFn(6, i, i % 2 === 0);
    mx.setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [s - 4, 3],
    [3, s - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < s && y >= 0 && y < s) mx.setFn(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver, s);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          mx.setFn(
            (pos[i] as number) + dx,
            (pos[j] as number) + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }
  drawFormat(mx, 0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = bit(bits, i);
      const a = s - 11 + (i % 3);
      const c = Math.floor(i / 3);
      mx.setFn(a, c, b);
      mx.setFn(c, a, b);
    }
  }
}

function addEcc(data: number[], ver: number): number[] {
  const numBlocks = BLOCKS_M[ver] as number;
  const eccLen = ECC_M[ver] as number;
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i] as number);
    });
  }
  return out;
}

function drawCodewords(mx: Matrix, data: number[]): void {
  const s = mx.size;
  let i = 0;
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < s; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? s - 1 - vert : vert;
        if (!mx.isFn(x, y) && i < data.length * 8) {
          (mx.m[y] as boolean[])[x] = bit(data[i >>> 3] as number, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(mx: Matrix, mask: number): void {
  for (let y = 0; y < mx.size; y++) {
    const row = mx.m[y] as boolean[];
    for (let x = 0; x < mx.size; x++) {
      if (!mx.isFn(x, y) && maskBit(mask, x, y)) row[x] = !row[x];
    }
  }
}

function penalty(mx: Matrix): number {
  const s = mx.size;
  let result = 0;
  const addHistory = (len: number, h: number[]) => {
    let l = len;
    if (h[0] === 0) l += s;
    h.pop();
    h.unshift(l);
  };
  const countPatterns = (h: number[]) => {
    const n = h[1] as number;
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (
      (core && (h[0] as number) >= n * 4 && (h[6] as number) >= n ? 1 : 0) +
      (core && (h[6] as number) >= n * 4 && (h[0] as number) >= n ? 1 : 0)
    );
  };
  const terminate = (color: boolean, len: number, h: number[]) => {
    let l = len;
    if (color) {
      addHistory(l, h);
      l = 0;
    }
    l += s;
    addHistory(l, h);
    return countPatterns(h);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < s; a++) {
      let color = false;
      let run = 0;
      const h = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < s; b++) {
        const v = pass === 0 ? mx.get(b, a) : mx.get(a, b);
        if (v === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, h);
          if (!color) result += countPatterns(h) * 40;
          color = v;
          run = 1;
        }
      }
      result += terminate(color, run, h) * 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const c = mx.get(x, y);
      if (c) dark++;
      if (
        x < s - 1 &&
        y < s - 1 &&
        c === mx.get(x + 1, y) &&
        c === mx.get(x, y + 1) &&
        c === mx.get(x + 1, y + 1)
      )
        result += 3;
    }
  }
  const total = s * s;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * 10;
}

/**
 * Encode text (UTF-8, byte mode, level M). `mask` forces a mask pattern
 * (0–7); by default the lowest-penalty mask is chosen.
 */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  for (; ver <= 40; ver++) {
    const countBits = ver < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > 40) throw new Error('QR: data too long');
  const countBits = ver < 10 ? 8 : 16;
  const capacity = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] as number);
    data.push(b);
  }

  const mx = new Matrix(ver * 4 + 17);
  drawFunctionPatterns(mx, ver);
  drawCodewords(mx, addEcc(data, ver));

  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 8; m++) {
      applyMask(mx, m);
      drawFormat(mx, m);
      const p = penalty(mx);
      if (p < best) {
        best = p;
        mask = m;
      }
      applyMask(mx, m);
    }
  }
  applyMask(mx, mask);
  drawFormat(mx, mask);
  return { version: ver, size: mx.size, mask, modules: mx.m };
}

/**
 * Render a QR code as a compact SVG (one path, horizontal runs, 4-module quiet
 * zone). Always dark-on-light so phone scanners read it in dark mode too.
 */
export function qrSvg(text: string, opts: { label?: string; px?: number } = {}): string {
  const qr = encodeQr(text);
  const q = 4;
  const dim = qr.size + q * 2;
  let d = '';
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && row[x]) x++;
      d += `M${start + q} ${y + q}h${x - start}v1h-${x - start}z`;
    }
  });
  const label = (opts.label ?? text).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const px = opts.px ?? 200;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}
