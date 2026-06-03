/**
 * Event serialization, id computation, structural validation, and signature
 * verification per NIP-01.
 */
import { hexToBytes, utf8ToBytes } from "./crypto/hex.ts";
import { sha256Hex } from "./crypto/sha256.ts";
import { verify } from "./crypto/schnorr.ts";
import type { NostrEvent, UnsignedEvent } from "./types.ts";

/**
 * Canonical serialization for id computation:
 *   [0, pubkey, created_at, kind, tags, content]
 *
 * NIP-01 requires no extra whitespace and only the standard JSON escapes
 * (\n \r \t \b \f \" \\ and \u00xx control chars). JSON.stringify in
 * JavaScriptCore/V8 already produces exactly this form: it leaves other
 * UTF-8 characters literal and does not escape "/".
 */
export function serializeEvent(event: UnsignedEvent | NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** Compute the lowercase-hex event id (sha256 of the serialization). */
export function getEventHash(event: UnsignedEvent | NostrEvent): string {
  return sha256Hex(utf8ToBytes(serializeEvent(event)));
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** Structural validation: shape, types, and lowercase-hex field lengths. */
export function validateStructure(event: unknown): event is NostrEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;

  if (typeof e.id !== "string" || !HEX64.test(e.id)) return false;
  if (typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return false;
  if (typeof e.sig !== "string" || !HEX128.test(e.sig)) return false;
  if (typeof e.content !== "string") return false;
  if (
    typeof e.created_at !== "number" ||
    !Number.isInteger(e.created_at) ||
    e.created_at < 0
  ) {
    return false;
  }
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind)) return false;
  if (!Array.isArray(e.tags)) return false;
  for (const tag of e.tags) {
    if (!Array.isArray(tag)) return false;
    for (const item of tag) {
      if (typeof item !== "string") return false;
    }
  }
  return true;
}

/**
 * Verify an event: structure, id matches the serialization, and the signature
 * is a valid BIP-340 Schnorr signature over the id.
 */
export function verifyEvent(event: NostrEvent): boolean {
  if (!validateStructure(event)) return false;
  if (getEventHash(event) !== event.id) return false;
  return verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
}
