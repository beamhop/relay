/**
 * Minimal pure-BigInt secp256k1 implementation, just enough for BIP-340
 * Schnorr signature verification. No external dependencies.
 *
 * Scalar multiplication uses Jacobian coordinates so each step costs only
 * field multiplications (one modular inverse at the very end) instead of a
 * modular inverse per point addition.
 */

/** Field prime: 2^256 - 2^32 - 977. */
export const p =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

/** Group order. */
export const n =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Base point coordinates. */
export const Gx =
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
export const Gy =
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

/** Reduce `a` into the range [0, m), always non-negative. */
export function mod(a: bigint, m: bigint = p): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

/** Modular exponentiation: base^exp mod m. */
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m === 1n) return 0n;
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, m);
    base = mod(base * base, m);
    exp >>= 1n;
  }
  return result;
}

/** Modular inverse via Fermat's little theorem (m must be prime). */
export function modInverse(a: bigint, m: bigint = p): bigint {
  return modPow(mod(a, m), m - 2n, m);
}

/** Affine point. `null` represents the point at infinity. */
export interface Point {
  x: bigint;
  y: bigint;
}

export const G: Point = { x: Gx, y: Gy };

/** Whether an affine point lies on the curve y^2 = x^3 + 7. */
export function isOnCurve(point: Point | null): boolean {
  if (point === null) return true;
  return mod(point.y * point.y - (point.x * point.x * point.x + 7n)) === 0n;
}

// --- Jacobian coordinates: (X, Y, Z) with x = X/Z^2, y = Y/Z^3 ---

interface Jacobian {
  x: bigint;
  y: bigint;
  z: bigint;
}

const JACOBIAN_INFINITY: Jacobian = { x: 0n, y: 1n, z: 0n };

function toJacobian(point: Point | null): Jacobian {
  if (point === null) return JACOBIAN_INFINITY;
  return { x: point.x, y: point.y, z: 1n };
}

function jacobianDouble(P: Jacobian): Jacobian {
  if (P.z === 0n || P.y === 0n) return JACOBIAN_INFINITY;
  // a = 0 for secp256k1
  const ysq = mod(P.y * P.y);
  const s = mod(4n * P.x * ysq);
  const m = mod(3n * P.x * P.x);
  const nx = mod(m * m - 2n * s);
  const ny = mod(m * (s - nx) - 8n * ysq * ysq);
  const nz = mod(2n * P.y * P.z);
  return { x: nx, y: ny, z: nz };
}

function jacobianAdd(P: Jacobian, Q: Jacobian): Jacobian {
  if (P.z === 0n) return Q;
  if (Q.z === 0n) return P;
  const z1z1 = mod(P.z * P.z);
  const z2z2 = mod(Q.z * Q.z);
  const u1 = mod(P.x * z2z2);
  const u2 = mod(Q.x * z1z1);
  const s1 = mod(P.y * Q.z * z2z2);
  const s2 = mod(Q.y * P.z * z1z1);
  if (u1 === u2) {
    if (s1 !== s2) return JACOBIAN_INFINITY; // P = -Q
    return jacobianDouble(P); // P = Q
  }
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const v = mod(u1 * hh);
  const nx = mod(r * r - hhh - 2n * v);
  const ny = mod(r * (v - nx) - s1 * hhh);
  const nz = mod(P.z * Q.z * h);
  return { x: nx, y: ny, z: nz };
}

function jacobianToAffine(P: Jacobian): Point | null {
  if (P.z === 0n) return null;
  const zinv = modInverse(P.z, p);
  const zinv2 = mod(zinv * zinv);
  const zinv3 = mod(zinv2 * zinv);
  return { x: mod(P.x * zinv2), y: mod(P.y * zinv3) };
}

/** Point addition in affine coordinates. */
export function pointAdd(a: Point | null, b: Point | null): Point | null {
  return jacobianToAffine(jacobianAdd(toJacobian(a), toJacobian(b)));
}

/** Point doubling in affine coordinates. */
export function pointDouble(a: Point | null): Point | null {
  return jacobianToAffine(jacobianDouble(toJacobian(a)));
}

/** k*P as a Jacobian point via double-and-add (no final affine conversion). */
function jacobianMul(k: bigint, point: Point | null): Jacobian {
  const scalar = mod(k, n);
  if (scalar === 0n || point === null) return JACOBIAN_INFINITY;
  let result = JACOBIAN_INFINITY;
  let addend = toJacobian(point);
  let s = scalar;
  while (s > 0n) {
    if (s & 1n) result = jacobianAdd(result, addend);
    addend = jacobianDouble(addend);
    s >>= 1n;
  }
  return result;
}

/** Scalar multiplication k*P via double-and-add in Jacobian coordinates. */
export function pointMul(k: bigint, point: Point | null): Point | null {
  return jacobianToAffine(jacobianMul(k, point));
}

// --- Fixed-base acceleration for k*G ---
//
// G is constant, so we precompute, once at module load, the windowed multiples
// (i << (WINDOW*w)) * G for every window w and digit i. A scalar mult against G
// then costs additions per window instead of ~256 doublings — the dominant cost
// of the s*G half of every Schnorr verification.

const WINDOW = 4; // bits per window
const WINDOW_SIZE = 1 << WINDOW; // 16 digits per window
const WINDOW_COUNT = Math.ceil(256 / WINDOW); // windows to cover a 256-bit scalar

/** baseTable[w][i] = (i << (WINDOW*w)) * G, in Jacobian coordinates. */
const baseTable: Jacobian[][] = (() => {
  const table: Jacobian[][] = [];
  // base = G doubled WINDOW times between windows; built by repeated addition.
  let windowBase = toJacobian(G);
  for (let w = 0; w < WINDOW_COUNT; w++) {
    const row: Jacobian[] = [JACOBIAN_INFINITY]; // i = 0
    let acc = JACOBIAN_INFINITY;
    for (let i = 1; i < WINDOW_SIZE; i++) {
      acc = jacobianAdd(acc, windowBase); // acc = i * windowBase
      row.push(acc);
    }
    table.push(row);
    // Advance windowBase by WINDOW doublings: windowBase *= 2^WINDOW.
    for (let d = 0; d < WINDOW; d++) windowBase = jacobianDouble(windowBase);
  }
  return table;
})();

/** Fixed-base scalar multiplication k*G using the precomputed window table. */
export function pointMulBase(k: bigint): Point | null {
  const scalar = mod(k, n);
  if (scalar === 0n) return null;
  let result = JACOBIAN_INFINITY;
  let s = scalar;
  for (let w = 0; w < WINDOW_COUNT && s > 0n; w++) {
    const digit = Number(s & BigInt(WINDOW_SIZE - 1));
    if (digit !== 0) result = jacobianAdd(result, baseTable[w]![digit]!);
    s >>= BigInt(WINDOW);
  }
  return jacobianToAffine(result);
}

/**
 * BIP-340 lift_x: given an x-coordinate, return the curve point with even y,
 * or null if x is out of range or not on the curve.
 */
export function liftX(x: bigint): Point | null {
  if (x <= 0n || x >= p) return null;
  const c = mod(x * x * x + 7n);
  // p % 4 == 3, so the square root is c^((p+1)/4) mod p.
  const y = modPow(c, (p + 1n) / 4n, p);
  if (mod(y * y) !== c) return null;
  return { x, y: (y & 1n) === 0n ? y : p - y };
}
