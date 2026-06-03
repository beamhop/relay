/**
 * SHA-256 over Bun's native node:crypto (zero npm dependencies).
 */
import { createHash } from "node:crypto";
import { bytesToHex } from "./hex.ts";

/** SHA-256 digest of `data` as a 32-byte array. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** SHA-256 digest of `data` as a lowercase 64-char hex string. */
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}
