// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { HyperLogLog, QuantileSketch, hash32 } from '../src/index.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exactQuantile(sorted: number[], q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))] as number;
}

describe('QuantileSketch', () => {
  test('quantiles within 1% relative error on a heavy-tailed distribution', () => {
    const r = rng(42);
    const sk = new QuantileSketch(0.01);
    const values: number[] = [];
    for (let i = 0; i < 50_000; i++) {
      // log-normal latency-like values (ms)
      const u1 = r() || 1e-9;
      const u2 = r();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const v = Math.exp(3 + 1.2 * z);
      values.push(v);
      sk.add(v);
    }
    values.sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.95, 0.99]) {
      const exact = exactQuantile(values, q);
      const est = sk.quantile(q);
      expect(Math.abs(est - exact) / exact).toBeLessThan(0.0201);
    }
    expect(sk.count).toBe(50_000);
  });

  test('merge equals one sketch over the union', () => {
    const a = new QuantileSketch();
    const b = new QuantileSketch();
    const all = new QuantileSketch();
    for (let i = 1; i <= 1000; i++) {
      (i % 2 ? a : b).add(i);
      all.add(i);
    }
    a.merge(b);
    expect(a.quantile(0.5)).toBe(all.quantile(0.5));
    expect(a.quantile(0.95)).toBe(all.quantile(0.95));
    expect(a.count).toBe(1000);
  });

  test('empty sketch and zero values', () => {
    const s = new QuantileSketch();
    expect(s.quantile(0.5)).toBe(0);
    s.add(0);
    s.add(0);
    s.add(10);
    expect(s.quantile(0.5)).toBe(0);
    expect(s.quantile(1)).toBe(10);
  });
});

describe('HyperLogLog', () => {
  test('error within 3σ (σ = 1.04/√m) across cardinalities', () => {
    const sigma = 1.04 / Math.sqrt(4096);
    for (const n of [10, 100, 1_000, 10_000, 100_000]) {
      const h = new HyperLogLog(12);
      for (let i = 0; i < n; i++) h.add(`pubkey-${n}-${i}`);
      // duplicates must not change the estimate
      for (let i = 0; i < n; i += 3) h.add(`pubkey-${n}-${i}`);
      const err = Math.abs(h.count() - n) / n;
      expect(err).toBeLessThan(3 * sigma);
    }
  });

  test('union of sketches approximates union cardinality; round-trips base64', () => {
    const a = new HyperLogLog();
    const b = new HyperLogLog();
    for (let i = 0; i < 5000; i++) a.add(`k${i}`);
    for (let i = 2500; i < 7500; i++) b.add(`k${i}`);
    const u = HyperLogLog.union([a, b]);
    expect(Math.abs(u.count() - 7500) / 7500).toBeLessThan(0.05);
    const copy = HyperLogLog.fromBase64(u.toBase64());
    expect(copy.count()).toBe(u.count());
  });

  test('hash32 spreads hex pubkeys', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(hash32(i.toString(16).padStart(64, '0')) >>> 22);
    expect(seen.size).toBeGreaterThan(550);
  });
});
