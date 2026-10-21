// SPDX-License-Identifier: AGPL-3.0-or-later
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** A signed Nostr event (NIP-01). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, 'id' | 'sig'>;

export type KindClass = 'regular' | 'replaceable' | 'ephemeral' | 'addressable';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function kindClass(kind: number): KindClass {
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return 'replaceable';
  if (kind >= 20000 && kind < 30000) return 'ephemeral';
  if (kind >= 30000 && kind < 40000) return 'addressable';
  return 'regular';
}

/** First value of the first tag with the given name. */
export function tagValue(event: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  for (const t of event.tags) if (t[0] === name) return t[1];
  return undefined;
}

export function tagValues(event: Pick<NostrEvent, 'tags'>, name: string): string[] {
  const out: string[] = [];
  for (const t of event.tags) if (t[0] === name && t[1] !== undefined) out.push(t[1]);
  return out;
}

/** NIP-40 expiration timestamp, if present and valid. */
export function expirationOf(event: Pick<NostrEvent, 'tags'>): number | undefined {
  const v = tagValue(event, 'expiration');
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Address coordinate `kind:pubkey:d` for replaceable/addressable events. */
export function addressOf(event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>): string | undefined {
  const cls = kindClass(event.kind);
  if (cls === 'replaceable') return `${event.kind}:${event.pubkey}:`;
  if (cls === 'addressable') return `${event.kind}:${event.pubkey}:${tagValue(event, 'd') ?? ''}`;
  return undefined;
}

export function serializeForId(e: UnsignedEvent): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

export function computeEventId(e: UnsignedEvent): string {
  return bytesToHex(sha256(new TextEncoder().encode(serializeForId(e))));
}

export type ShapeError = { ok: false; reason: string };
export type ShapeResult = { ok: true; event: NostrEvent } | ShapeError;

/** Structural validation only (no id/sig check). Safe on untrusted input. */
export function validateEventShape(input: unknown): ShapeResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'invalid: event must be an object' };
  }
  const e = input as Record<string, unknown>;
  if (typeof e.id !== 'string' || !HEX64.test(e.id))
    return { ok: false, reason: 'invalid: bad id' };
  if (typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey))
    return { ok: false, reason: 'invalid: bad pubkey' };
  if (typeof e.sig !== 'string' || !HEX128.test(e.sig))
    return { ok: false, reason: 'invalid: bad sig' };
  if (typeof e.created_at !== 'number' || !Number.isInteger(e.created_at) || e.created_at < 0)
    return { ok: false, reason: 'invalid: bad created_at' };
  if (typeof e.kind !== 'number' || !Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65535)
    return { ok: false, reason: 'invalid: bad kind' };
  if (typeof e.content !== 'string') return { ok: false, reason: 'invalid: bad content' };
  if (!Array.isArray(e.tags)) return { ok: false, reason: 'invalid: bad tags' };
  for (const t of e.tags) {
    if (!Array.isArray(t) || t.length === 0) return { ok: false, reason: 'invalid: bad tag' };
    for (const v of t)
      if (typeof v !== 'string') return { ok: false, reason: 'invalid: bad tag value' };
  }
  return {
    ok: true,
    event: {
      id: e.id,
      pubkey: e.pubkey,
      created_at: e.created_at,
      kind: e.kind,
      tags: e.tags as string[][],
      content: e.content,
      sig: e.sig,
    },
  };
}

export function verifyEventId(e: NostrEvent): boolean {
  return computeEventId(e) === e.id;
}

export function verifyEventSig(e: NostrEvent): boolean {
  try {
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

/** Full verification: id matches content and signature is valid. */
export function verifyEvent(e: NostrEvent): boolean {
  return verifyEventId(e) && verifyEventSig(e);
}

export function getPublicKey(secretKeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex)));
}

export function generateSecretKey(): string {
  return bytesToHex(schnorr.utils.randomPrivateKey());
}

export function finalizeEvent(
  template: Omit<UnsignedEvent, 'pubkey'> & { pubkey?: string },
  secretKeyHex: string,
): NostrEvent {
  const pubkey = getPublicKey(secretKeyHex);
  const unsigned: UnsignedEvent = { ...template, pubkey };
  const id = computeEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretKeyHex)));
  return { ...unsigned, id, sig };
}

/** NIP-01 ordering for replaceable resolution: newer wins, tie → lowest id. */
export function isNewer(a: NostrEvent, b: NostrEvent): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id < b.id;
}
