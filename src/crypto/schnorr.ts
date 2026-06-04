/**
 * BIP-340 Schnorr signature verification over secp256k1.
 * Only verification is implemented (relays never sign).
 */
import { createHash } from "node:crypto";
import { bytesToBigInt } from "./hex.ts";
import { liftX, mod, n, p, pointAdd, pointMul, pointMulBase } from "./secp256k1.ts";

/** Tagged hash: SHA256(SHA256(tag) || SHA256(tag) || ...msgs). */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagHash = createHash("sha256").update(tag).digest();
  const h = createHash("sha256");
  h.update(tagHash);
  h.update(tagHash);
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
}

/**
 * Verify a BIP-340 Schnorr signature.
 * @param sig    64-byte signature (r || s)
 * @param msg    message bytes (the event id for NOSTR)
 * @param pubkey 32-byte x-only public key
 */
export function verify(
  sig: Uint8Array,
  msg: Uint8Array,
  pubkey: Uint8Array,
): boolean {
  if (sig.length !== 64 || pubkey.length !== 32) return false;

  const px = bytesToBigInt(pubkey);
  const P = liftX(px);
  if (P === null) return false;

  const r = bytesToBigInt(sig.subarray(0, 32));
  const s = bytesToBigInt(sig.subarray(32, 64));
  if (r >= p || s >= n) return false;

  const e = mod(
    bytesToBigInt(taggedHash("BIP0340/challenge", sig.subarray(0, 32), pubkey, msg)),
    n,
  );

  // R = s*G - e*P. s*G uses the precomputed fixed-base table (G is constant);
  // e*P is a general scalar mult since P varies per signature.
  const R = pointAdd(pointMulBase(s), pointMul(mod(n - e, n), P));
  if (R === null) return false;
  if ((R.y & 1n) === 1n) return false; // R.y must be even
  return R.x === r;
}
