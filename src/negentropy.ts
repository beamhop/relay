import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { matchesFilter, sortEventsForRelay } from "./filter";
import type { EventStore } from "./storage";
import type { NostrFilter } from "./types";

const PROTOCOL_VERSION = 0x61;

export async function createNegentropyResponse(store: EventStore, filter: NostrFilter, maxFrameBytes: number): Promise<{ ok: true; message: string } | { ok: false; reason: string; maxRecords?: number }> {
  const events = sortEventsForRelay((await store.allEvents()).filter((event) => matchesFilter(event, filter))).reverse();
  const estimatedSize = 1 + 1 + 1 + 1 + encodeVarint(events.length).length + events.length * 32;
  if (estimatedSize > maxFrameBytes) {
    const maxRecords = Math.max(0, Math.floor((maxFrameBytes - 8) / 32));
    return { ok: false, reason: "blocked: negentropy response would exceed max frame size", maxRecords };
  }

  const chunks: Uint8Array[] = [
    Uint8Array.from([PROTOCOL_VERSION]),
    encodeVarint(0),
    encodeVarint(0),
    encodeVarint(2),
    encodeVarint(events.length),
  ];
  for (const event of events) chunks.push(hexToBytes(event.id));
  return { ok: true, message: bytesToHex(concatBytes(chunks)) };
}

export function validateNegentropyMessage(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return "invalid: negentropy message must be hex";
  const bytes = hexToBytes(hex);
  if (bytes.length === 0) return "invalid: negentropy message is empty";
  if (bytes[0] !== PROTOCOL_VERSION) return "unsupported: unsupported negentropy protocol version";
  return undefined;
}

export function encodeVarint(input: number | bigint): Uint8Array {
  let value = typeof input === "bigint" ? input : BigInt(input);
  if (value < 0n) throw new Error("varint cannot encode negative values");
  if (value === 0n) return Uint8Array.from([0]);
  const digits: number[] = [];
  while (value > 0n) {
    digits.unshift(Number(value & 0x7fn));
    value >>= 7n;
  }
  for (let i = 0; i < digits.length - 1; i += 1) digits[i] = (digits[i] ?? 0) | 0x80;
  return Uint8Array.from(digits);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
