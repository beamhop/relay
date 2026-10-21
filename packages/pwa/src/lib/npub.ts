// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tiny bech32 `npub` encoder (NIP-19) so name labels need no extra bundle weight.
 * Verified against nostr-tools `nip19.npubEncode` in test/names.unit.ts.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export const HEX64 = /^[0-9a-f]{64}$/i;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function toWords(bytes: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/** Hex public key → `npub1…`; undefined for anything that is not a 64-char hex key. */
export function npubEncode(hex: string): string | undefined {
  if (!HEX64.test(hex)) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  const hrp = 'npub';
  const data = toWords(bytes);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

/** "npub1abcd…wxyz" — a recognisable short form of a public key. */
export function npubShort(hexOrNpub: string): string {
  const npub = hexOrNpub.startsWith('npub1') ? hexOrNpub : npubEncode(hexOrNpub.toLowerCase());
  if (!npub) return hexOrNpub;
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}

/** "a3f9c1…7c21" for hashes and ids (not people). */
export function shortHex(id: string): string {
  return id.length > 13 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
