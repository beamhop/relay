import type { NostrEvent } from "./types";

export type KindClass = "regular" | "replaceable" | "ephemeral" | "addressable";

export function classifyKind(kind: number): KindClass {
  if (kind >= 30000 && kind < 40000) return "addressable";
  if (kind >= 20000 && kind < 30000) return "ephemeral";
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return "replaceable";
  return "regular";
}

export function isEphemeralKind(kind: number): boolean {
  return classifyKind(kind) === "ephemeral";
}

export function isReplaceableKind(kind: number): boolean {
  const type = classifyKind(kind);
  return type === "replaceable" || type === "addressable";
}

export function firstTagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

export function hasMarkerTag(event: NostrEvent, name: string): boolean {
  return event.tags.some((tag) => tag.length === 1 && tag[0] === name);
}

export function addressForEvent(event: NostrEvent): string | undefined {
  const kindClass = classifyKind(event.kind);
  if (kindClass === "replaceable") return `${event.kind}:${event.pubkey}:`;
  if (kindClass !== "addressable") return undefined;
  const d = firstTagValue(event, "d") ?? "";
  return `${event.kind}:${event.pubkey}:${d}`;
}

export function replaceableKeyForEvent(event: NostrEvent): string | undefined {
  return addressForEvent(event);
}

export function shouldReplace(existing: NostrEvent, incoming: NostrEvent): boolean {
  if (incoming.created_at > existing.created_at) return true;
  if (incoming.created_at < existing.created_at) return false;
  return incoming.id < existing.id;
}

export function expirationTimestamp(event: NostrEvent): number | undefined {
  const value = firstTagValue(event, "expiration");
  if (!value) return undefined;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return undefined;
  return timestamp;
}

export function isExpired(event: NostrEvent, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const timestamp = expirationTimestamp(event);
  return timestamp !== undefined && timestamp <= nowSeconds;
}
