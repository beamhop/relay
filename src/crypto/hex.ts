/**
 * Hex and UTF-8 byte helpers. All hex output is lowercase.
 */

const HEX_CHARS = "0123456789abcdef";

/** Encode bytes as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return out;
}

/** Decode a hex string to bytes. Throws on odd length or invalid characters. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexNibble(hex.charCodeAt(i * 2));
    const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(code: number): number {
  // 0-9
  if (code >= 48 && code <= 57) return code - 48;
  // a-f
  if (code >= 97 && code <= 102) return code - 87;
  // A-F
  if (code >= 65 && code <= 70) return code - 55;
  throw new Error(`invalid hex character code: ${code}`);
}

const encoder = new TextEncoder();

/** Encode a string to UTF-8 bytes. */
export function utf8ToBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Convert bytes to a BigInt (big-endian). */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt("0x" + bytesToHex(bytes));
}

/** Convert a BigInt to a fixed-length big-endian byte array. */
export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const hex = value.toString(16).padStart(length * 2, "0");
  if (hex.length > length * 2) {
    throw new Error(`value does not fit in ${length} bytes`);
  }
  return hexToBytes(hex);
}
