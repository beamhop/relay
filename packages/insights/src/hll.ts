// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * HyperLogLog distinct counter (Flajolet et al. 2007) for privacy-preserving
 * active-user counts: only register maxima are kept, never the pubkeys.
 * Standard error ≈ 1.04/√m (m = 2^precision; p=12 → ±1.6%).
 */

/** 32-bit FNV-1a followed by the murmur3 finalizer (good avalanche on short strings). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function sigma(x0: number): number {
  if (x0 === 1) return Number.POSITIVE_INFINITY;
  let x = x0;
  let y = 1;
  let z = x;
  let prev: number;
  do {
    x *= x;
    prev = z;
    z += x * y;
    y += y;
  } while (z !== prev);
  return z;
}

function tau(x0: number): number {
  if (x0 === 0 || x0 === 1) return 0;
  let x = x0;
  let y = 1;
  let z = 1 - x;
  let prev: number;
  do {
    x = Math.sqrt(x);
    prev = z;
    y *= 0.5;
    z -= (1 - x) ** 2 * y;
  } while (z !== prev);
  return z / 3;
}

export class HyperLogLog {
  readonly m: number;
  readonly registers: Uint8Array;

  constructor(
    readonly precision = 12,
    registers?: Uint8Array,
  ) {
    if (precision < 4 || precision > 16) throw new Error('precision must be 4..16');
    this.m = 1 << precision;
    this.registers = registers ?? new Uint8Array(this.m);
    if (this.registers.length !== this.m) throw new Error('register size mismatch');
  }

  add(value: string): void {
    this.addHash(hash32(value));
  }

  addHash(h: number): void {
    const p = this.precision;
    const idx = h >>> (32 - p);
    const w = (h << p) >>> 0;
    // rank = position of first 1-bit in the remaining (32-p) bits, 1-based.
    const rank = w === 0 ? 32 - p + 1 : Math.clz32(w) + 1;
    if (rank > (this.registers[idx] ?? 0)) this.registers[idx] = rank;
  }

  /**
   * Cardinality estimate using Ertl's improved raw estimator ("New
   * cardinality estimation algorithms for HyperLogLog sketches", 2017):
   * unbiased across the whole range without empirical bias tables or
   * linear-counting thresholds.
   */
  count(): number {
    const m = this.m;
    const q = 32 - this.precision;
    const hist = new Array<number>(q + 2).fill(0);
    for (let i = 0; i < m; i++) {
      const r = Math.min(this.registers[i] ?? 0, q + 1);
      hist[r] = (hist[r] ?? 0) + 1;
    }
    if ((hist[0] ?? 0) === m) return 0;
    let z = m * tau(1 - (hist[q + 1] ?? 0) / m);
    for (let k = q; k >= 1; k--) z = 0.5 * (z + (hist[k] ?? 0));
    z += m * sigma((hist[0] ?? 0) / m);
    const alphaInf = 1 / (2 * Math.LN2);
    return Math.round((alphaInf * m * m) / z);
  }

  merge(other: HyperLogLog): void {
    if (other.precision !== this.precision) throw new Error('precision mismatch');
    for (let i = 0; i < this.m; i++) {
      const o = other.registers[i] ?? 0;
      if (o > (this.registers[i] ?? 0)) this.registers[i] = o;
    }
  }

  isEmpty(): boolean {
    return this.registers.every((r) => r === 0);
  }

  toBase64(): string {
    let s = '';
    for (const b of this.registers) s += String.fromCharCode(b);
    return btoa(s);
  }

  static fromBase64(data: string, precision = 12): HyperLogLog {
    const bin = atob(data);
    const regs = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) regs[i] = bin.charCodeAt(i);
    return new HyperLogLog(precision, regs);
  }

  static union(sketches: HyperLogLog[], precision = 12): HyperLogLog {
    const out = new HyperLogLog(precision);
    for (const s of sketches) out.merge(s);
    return out;
  }
}
