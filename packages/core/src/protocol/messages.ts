import type { Filter, NostrEvent } from "@beamhop/sdk";
import { isHex128, isHex64 } from "../util/hex";

/** Strictly validated client → relay messages. */
export type ClientMessage =
  | { type: "EVENT"; event: NostrEvent }
  | { type: "REQ"; subId: string; filters: Filter[] }
  | { type: "COUNT"; subId: string; filters: Filter[] }
  | { type: "CLOSE"; subId: string }
  | { type: "AUTH"; event: NostrEvent }
  | { type: "NEG-OPEN"; subId: string; filter: Filter; message: string }
  | { type: "NEG-MSG"; subId: string; message: string }
  | { type: "NEG-CLOSE"; subId: string };

export type ParseResult =
  | { ok: true; msg: ClientMessage }
  /** `subId` is set when the error can be reported with CLOSED / OK instead of NOTICE */
  | { ok: false; type?: string; subId?: string; eventId?: string; reason: string };

export const MAX_SUB_ID_LENGTH = 64;
const TAG_KEY = /^#[a-zA-Z]$/;
const HEX_EVEN = /^([0-9a-f]{2})*$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export function validateSubId(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length === 0) return "invalid: subscription id must be a non-empty string";
  if (s.length > MAX_SUB_ID_LENGTH) return `invalid: subscription id longer than ${MAX_SUB_ID_LENGTH} chars`;
  return undefined;
}

/** Validates the event shape and returns a clean copy (extra keys are dropped). */
export function validateEventShape(e: unknown): { event: NostrEvent } | { reason: string; id?: string } {
  if (!e || typeof e !== "object" || Array.isArray(e)) return { reason: "invalid: event must be an object" };
  const o = e as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : undefined;
  if (!isHex64(o.id)) return { reason: "invalid: bad event id", id };
  if (!isHex64(o.pubkey)) return { reason: "invalid: bad pubkey", id };
  if (!isHex128(o.sig)) return { reason: "invalid: bad signature format", id };
  if (!isInt(o.created_at) || o.created_at < 0) return { reason: "invalid: bad created_at", id };
  if (!isInt(o.kind) || o.kind < 0 || o.kind > 65535) return { reason: "invalid: bad kind", id };
  if (typeof o.content !== "string") return { reason: "invalid: content must be a string", id };
  if (!Array.isArray(o.tags)) return { reason: "invalid: tags must be an array", id };
  for (const t of o.tags) {
    if (!Array.isArray(t) || t.length === 0) return { reason: "invalid: each tag must be a non-empty array", id };
    for (const v of t) if (typeof v !== "string") return { reason: "invalid: tag values must be strings", id };
  }
  return {
    event: {
      id: o.id as string,
      pubkey: o.pubkey as string,
      created_at: o.created_at,
      kind: o.kind,
      tags: o.tags as string[][],
      content: o.content,
      sig: o.sig as string,
    },
  };
}

/** Validates a NIP-01 filter. Unknown keys are rejected. */
export function validateFilter(f: unknown): { filter: Filter } | { reason: string } {
  if (!f || typeof f !== "object" || Array.isArray(f)) return { reason: "invalid: filter must be an object" };
  const out: Filter = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    switch (k) {
      case "ids":
      case "authors":
        if (!Array.isArray(v) || !v.every(isHex64)) return { reason: `invalid: "${k}" must be an array of 64-char lowercase hex strings` };
        out[k] = [...new Set(v as string[])];
        break;
      case "kinds":
        if (!Array.isArray(v) || !v.every((n) => isInt(n) && n >= 0 && n <= 65535)) return { reason: 'invalid: "kinds" must be an array of integers' };
        out.kinds = [...new Set(v as number[])];
        break;
      case "since":
      case "until":
      case "limit":
        if (!isInt(v) || v < 0) return { reason: `invalid: "${k}" must be a non-negative integer` };
        out[k] = v;
        break;
      case "search":
        if (typeof v !== "string") return { reason: 'invalid: "search" must be a string' };
        if (v.length > 256) return { reason: "invalid: search query too long" };
        out.search = v;
        break;
      default:
        if (!TAG_KEY.test(k)) return { reason: `invalid: unsupported filter key "${k}"` };
        if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) return { reason: `invalid: "${k}" must be an array of strings` };
        out[k as `#${string}`] = [...new Set(v as string[])];
    }
  }
  return { filter: out };
}

function parseFilters(arr: unknown[], subId: string, type: string, maxFilters: number): ParseResult {
  if (arr.length === 0) return { ok: false, type, subId, reason: "invalid: at least one filter is required" };
  if (arr.length > maxFilters) return { ok: false, type, subId, reason: `invalid: too many filters (max ${maxFilters})` };
  const filters: Filter[] = [];
  for (const f of arr) {
    const r = validateFilter(f);
    if ("reason" in r) return { ok: false, type, subId, reason: r.reason };
    filters.push(r.filter);
  }
  return { ok: true, msg: { type: type as "REQ", subId, filters } };
}

export function parseClientMessage(data: string, opts: { maxFilters: number }): ParseResult {
  let arr: unknown;
  try {
    arr = JSON.parse(data);
  } catch {
    return { ok: false, reason: "invalid: malformed JSON" };
  }
  if (!Array.isArray(arr) || typeof arr[0] !== "string") return { ok: false, reason: "invalid: message must be a JSON array starting with a string" };
  const type = arr[0];
  switch (type) {
    case "EVENT":
    case "AUTH": {
      if (arr.length !== 2) return { ok: false, type, reason: `invalid: ${type} message must have exactly one event` };
      const r = validateEventShape(arr[1]);
      if ("reason" in r) return { ok: false, type, eventId: r.id, reason: r.reason };
      return { ok: true, msg: { type, event: r.event } };
    }
    case "REQ":
    case "COUNT": {
      const subErr = validateSubId(arr[1]);
      if (subErr) return { ok: false, type, reason: subErr };
      return parseFilters(arr.slice(2), arr[1] as string, type, opts.maxFilters);
    }
    case "CLOSE":
    case "NEG-CLOSE": {
      const subErr = validateSubId(arr[1]);
      if (subErr || arr.length !== 2) return { ok: false, type, reason: subErr ?? `invalid: malformed ${type}` };
      return { ok: true, msg: { type, subId: arr[1] as string } };
    }
    case "NEG-OPEN": {
      const subErr = validateSubId(arr[1]);
      if (subErr) return { ok: false, type, reason: subErr };
      const subId = arr[1] as string;
      // NIP-77: ["NEG-OPEN", subId, filter, initialMessage]
      if (arr.length !== 4) return { ok: false, type, subId, reason: "invalid: malformed NEG-OPEN" };
      const fr = validateFilter(arr[2]);
      if ("reason" in fr) return { ok: false, type, subId, reason: fr.reason };
      const m = arr[3];
      if (typeof m !== "string" || !HEX_EVEN.test(m)) return { ok: false, type, subId, reason: "invalid: negentropy message must be hex" };
      return { ok: true, msg: { type, subId, filter: fr.filter, message: m } };
    }
    case "NEG-MSG": {
      const subErr = validateSubId(arr[1]);
      if (subErr) return { ok: false, type, reason: subErr };
      const subId = arr[1] as string;
      const m = arr[2];
      if (arr.length !== 3 || typeof m !== "string" || !HEX_EVEN.test(m)) return { ok: false, type, subId, reason: "invalid: malformed NEG-MSG" };
      return { ok: true, msg: { type, subId, message: m } };
    }
    default:
      return { ok: false, type, reason: `invalid: unknown message type "${type.slice(0, 32)}"` };
  }
}
