import { Buffer } from "node:buffer";
import { schnorr } from "@noble/curves/secp256k1.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * BIP-340 check of `sig` by `pubkey` over the event hash `id` (all lowercase hex). The caller has already checked
 * that `id` is the hash of the event body. Shared by the main thread and the verification workers.
 */
export function schnorrOk(id: string, pubkey: string, sig: string): boolean {
  // Buffer.from(…, "hex") stops at the first non-hex character instead of failing
  if (!HEX64.test(id) || !HEX64.test(pubkey) || !HEX128.test(sig)) return false;
  try {
    return schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(id, "hex"), Buffer.from(pubkey, "hex"));
  } catch {
    return false;
  }
}
