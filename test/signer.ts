/**
 * Test-only BIP-340 Schnorr signer and NOSTR event builder.
 *
 * The relay itself never signs (it only verifies), so signing lives here in the
 * test tree. Built on the project's own secp256k1 module so signed events
 * verify against the same code path the relay uses. Nonce generation follows
 * BIP-340 with a fixed all-zero aux_rand (deterministic, fine for tests).
 */
import { bytesToBigInt, bytesToHex, hexToBytes, utf8ToBytes } from "../src/crypto/hex.ts";
import { taggedHash } from "../src/crypto/schnorr.ts";
import { G, type Point, mod, n, p, pointMul } from "../src/crypto/secp256k1.ts";
import { getEventHash } from "../src/event.ts";
import type { NostrEvent, UnsignedEvent } from "../src/types.ts";

function bigIntTo32(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

function xOnly(point: Point): bigint {
  return point.x;
}

/** Derive the 32-byte x-only public key (hex) for a private key (hex). */
export function getPublicKey(privHex: string): string {
  let d = mod(bytesToBigInt(hexToBytes(privHex)), n);
  if (d === 0n) throw new Error("invalid private key");
  const P = pointMul(d, G);
  if (P === null) throw new Error("point at infinity");
  return bytesToHex(bigIntTo32(xOnly(P)));
}

/** Sign a 32-byte message (hex) with a private key (hex); returns 64-byte sig hex. */
export function schnorrSign(msgHex: string, privHex: string): string {
  const msg = hexToBytes(msgHex);
  let d = mod(bytesToBigInt(hexToBytes(privHex)), n);
  if (d === 0n) throw new Error("invalid private key");

  const P = pointMul(d, G);
  if (P === null) throw new Error("point at infinity");
  // BIP-340: if P.y is odd, negate d.
  if ((P.y & 1n) === 1n) d = n - d;

  const dBytes = bigIntTo32(d);
  const auxRand = new Uint8Array(32); // deterministic test nonce
  const t = new Uint8Array(32);
  const auxHash = taggedHash("BIP0340/aux", auxRand);
  for (let i = 0; i < 32; i++) t[i] = dBytes[i]! ^ auxHash[i]!;

  const pxBytes = bigIntTo32(xOnly(P));
  let k = mod(bytesToBigInt(taggedHash("BIP0340/nonce", t, pxBytes, msg)), n);
  if (k === 0n) throw new Error("nonce is zero");

  const R = pointMul(k, G);
  if (R === null) throw new Error("R at infinity");
  if ((R.y & 1n) === 1n) k = n - k;

  const rxBytes = bigIntTo32(R.x);
  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", rxBytes, pxBytes, msg)), n);
  const s = mod(k + e * d, n);

  return bytesToHex(rxBytes) + bytesToHex(bigIntTo32(s));
}

/** Build a fully-signed NOSTR event from its unsigned fields and a private key. */
export function signEvent(
  fields: { kind: number; created_at: number; tags?: string[][]; content?: string },
  privHex: string,
): NostrEvent {
  const unsigned: UnsignedEvent = {
    pubkey: getPublicKey(privHex),
    created_at: fields.created_at,
    kind: fields.kind,
    tags: fields.tags ?? [],
    content: fields.content ?? "",
  };
  const id = getEventHash(unsigned);
  const sig = schnorrSign(id, privHex);
  return { ...unsigned, id, sig };
}

/** A second test private key (key = 5) distinct from the fixtures' key (3). */
export const PRIV_B = "0000000000000000000000000000000000000000000000000000000000000005";
