import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NostrEvent, ValidationResult } from "./types";

const textEncoder = new TextEncoder();

export const HEX_32_RE = /^[0-9a-f]{64}$/;
export const HEX_64_RE = /^[0-9a-f]{128}$/;

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  return bytesToHex(sha256(bytes));
}

export function serializeEvent(event: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function getEventHash(event: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return sha256Hex(serializeEvent(event));
}

export function isEventShape(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}

export function validateEventShape(event: NostrEvent): ValidationResult {
  if (!HEX_32_RE.test(event.id)) return { ok: false, prefix: "invalid", message: "event id must be lowercase 32-byte hex" };
  if (!HEX_32_RE.test(event.pubkey)) return { ok: false, prefix: "invalid", message: "pubkey must be lowercase 32-byte hex" };
  if (!HEX_64_RE.test(event.sig)) return { ok: false, prefix: "invalid", message: "signature must be lowercase 64-byte hex" };
  if (!Number.isSafeInteger(event.created_at)) return { ok: false, prefix: "invalid", message: "created_at must be an integer" };
  if (!Number.isSafeInteger(event.kind) || event.kind < 0 || event.kind > 65535) {
    return { ok: false, prefix: "invalid", message: "kind must be an integer between 0 and 65535" };
  }
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length === 0) return { ok: false, prefix: "invalid", message: "tags must be non-empty arrays" };
    if (!tag.every((item) => typeof item === "string")) {
      return { ok: false, prefix: "invalid", message: "tag entries must be strings" };
    }
  }
  return { ok: true };
}

export function verifyEvent(event: NostrEvent): ValidationResult {
  const shape = validateEventShape(event);
  if (!shape.ok) return shape;

  const computedId = getEventHash(event);
  if (computedId !== event.id) return { ok: false, prefix: "invalid", message: "event id does not match serialized event hash" };

  try {
    const verified = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
    if (!verified) return { ok: false, prefix: "invalid", message: "event signature is invalid" };
  } catch {
    return { ok: false, prefix: "invalid", message: "event signature is invalid" };
  }

  return { ok: true };
}

export function makeChallenge(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function normalizeRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
