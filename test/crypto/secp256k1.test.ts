import { describe, expect, test } from "bun:test";
import {
  G,
  Gx,
  Gy,
  isOnCurve,
  liftX,
  mod,
  modInverse,
  modPow,
  n,
  p,
  pointAdd,
  pointDouble,
  pointMul,
  pointMulBase,
} from "../../src/crypto/secp256k1.ts";

describe("mod", () => {
  test("reduces positive values", () => {
    expect(mod(10n, 7n)).toBe(3n);
  });
  test("normalizes negatives to non-negative", () => {
    expect(mod(-1n, 7n)).toBe(6n);
  });
  test("defaults to the field prime", () => {
    expect(mod(p + 5n)).toBe(5n);
  });
});

describe("modPow", () => {
  test("computes powers", () => {
    expect(modPow(2n, 10n, 1000n)).toBe(24n); // 1024 % 1000
  });
  test("returns 0 for modulus 1", () => {
    expect(modPow(5n, 3n, 1n)).toBe(0n);
  });
});

describe("modInverse", () => {
  test("a * inv(a) == 1 (mod p)", () => {
    const a = 123456789n;
    expect(mod(a * modInverse(a, p), p)).toBe(1n);
  });
});

describe("curve points", () => {
  test("G is on the curve", () => {
    expect(isOnCurve(G)).toBe(true);
  });
  test("infinity is considered on the curve", () => {
    expect(isOnCurve(null)).toBe(true);
  });
  test("a bogus point is not on the curve", () => {
    expect(isOnCurve({ x: 1n, y: 1n })).toBe(false);
  });
  test("pointMul by n yields infinity", () => {
    expect(pointMul(n, G)).toBeNull();
  });
  test("pointMul by 0 yields infinity", () => {
    expect(pointMul(0n, G)).toBeNull();
  });
  test("pointMul of infinity is infinity", () => {
    expect(pointMul(5n, null)).toBeNull();
  });
  test("pointDouble(G) equals 2*G via pointMul", () => {
    expect(pointDouble(G)).toEqual(pointMul(2n, G));
  });
  test("pointDouble of infinity is infinity", () => {
    expect(pointDouble(null)).toBeNull();
  });
  test("pointAdd identity: P + infinity = P", () => {
    expect(pointAdd(G, null)).toEqual(G);
    expect(pointAdd(null, G)).toEqual(G);
  });
  test("pointAdd of P and -P is infinity", () => {
    const negG = { x: Gx, y: mod(-Gy) };
    expect(pointAdd(G, negG)).toBeNull();
  });
  test("pointAdd(G, G) equals pointDouble(G)", () => {
    expect(pointAdd(G, G)).toEqual(pointDouble(G));
  });
  test("3*G is on the curve and matches add(2G, G)", () => {
    const threeG = pointMul(3n, G);
    expect(isOnCurve(threeG)).toBe(true);
    expect(pointAdd(pointDouble(G), G)).toEqual(threeG);
  });
});

describe("pointMulBase", () => {
  test("equals pointMul(k, G) across a range of scalars", () => {
    for (const k of [1n, 2n, 3n, 7n, 16n, 17n, 255n, 256n, 65535n, 123456789n]) {
      expect(pointMulBase(k)).toEqual(pointMul(k, G));
    }
  });
  test("equals pointMul(k, G) for large/edge scalars", () => {
    for (const k of [n - 1n, n - 2n, (n >> 1n), 0xdeadbeefn ** 3n]) {
      expect(pointMulBase(k)).toEqual(pointMul(k, G));
    }
  });
  test("k=0 and k=n yield infinity", () => {
    expect(pointMulBase(0n)).toBeNull();
    expect(pointMulBase(n)).toBeNull();
  });
});

describe("liftX", () => {
  test("lifts Gx to a point with even y", () => {
    const point = liftX(Gx);
    expect(point).not.toBeNull();
    expect(point!.x).toBe(Gx);
    expect(point!.y & 1n).toBe(0n);
    expect(isOnCurve(point)).toBe(true);
  });
  test("returns null for x = 0", () => {
    expect(liftX(0n)).toBeNull();
  });
  test("returns null for x >= p", () => {
    expect(liftX(p)).toBeNull();
  });
  test("returns null for an x that is not on the curve", () => {
    // x = 5 gives c = 132, which is not a quadratic residue mod p.
    expect(liftX(5n)).toBeNull();
  });
});
