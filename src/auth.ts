import { isEventShape, normalizeRelayUrl, sha256Hex, verifyEvent } from "./crypto";
import { tagValues } from "./kinds";
import type { ConnectionState, NostrEvent, RelayConfig, ValidationResult } from "./types";

export function validateAuthEvent(event: NostrEvent, connection: ConnectionState, relayUrls: string[], config: RelayConfig): ValidationResult {
  const verified = verifyEvent(event);
  if (!verified.ok) return verified;
  if (event.kind !== 22242) return { ok: false, prefix: "invalid", message: "AUTH event must be kind 22242" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > config.limits.authEventMaxAgeSeconds) {
    return { ok: false, prefix: "invalid", message: "AUTH event timestamp is too far from now" };
  }
  if (!tagValues(event, "challenge").includes(connection.challenge)) {
    return { ok: false, prefix: "invalid", message: "AUTH challenge does not match" };
  }
  const authRelayUrls = tagValues(event, "relay").map(normalizeRelayUrl);
  const normalizedRelayUrls = relayUrls.map(normalizeRelayUrl);
  if (!authRelayUrls.some((url) => normalizedRelayUrls.includes(url))) {
    return { ok: false, prefix: "invalid", message: "AUTH relay tag does not match this relay" };
  }
  return { ok: true };
}

export async function validateHttpNostrAuthorization(
  request: Request,
  bodyText: string,
  config: RelayConfig,
): Promise<{ ok: true; pubkey: string } | { ok: false; status: number; message: string }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Nostr\s+(.+)$/i.exec(header);
  if (!match?.[1]) return { ok: false, status: 401, message: "missing Nostr authorization" };

  let event: NostrEvent;
  try {
    const json = Buffer.from(match[1], "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!isEventShape(parsed)) return { ok: false, status: 401, message: "authorization is not a Nostr event" };
    event = parsed;
  } catch {
    return { ok: false, status: 401, message: "authorization is not valid base64 JSON" };
  }

  const verified = verifyEvent(event);
  if (!verified.ok) return { ok: false, status: 401, message: verified.message };
  if (event.kind !== 27235) return { ok: false, status: 401, message: "authorization event must be kind 27235" };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 60) return { ok: false, status: 401, message: "authorization event timestamp is too far from now" };

  const requestUrl = normalizeRelayUrl(request.url);
  if (!tagValues(event, "u").includes(requestUrl)) return { ok: false, status: 401, message: "authorization URL does not match request" };
  if (!tagValues(event, "method").some((method) => method.toUpperCase() === request.method.toUpperCase())) {
    return { ok: false, status: 401, message: "authorization method does not match request" };
  }
  const payload = tagValues(event, "payload")[0];
  if (!payload) return { ok: false, status: 401, message: "authorization payload tag is required" };
  if (payload !== sha256Hex(bodyText)) return { ok: false, status: 401, message: "authorization payload does not match request body" };
  if (config.managementAdminPubkeys.size > 0 && !config.managementAdminPubkeys.has(event.pubkey)) {
    return { ok: false, status: 403, message: "pubkey is not a relay management admin" };
  }
  if (config.managementAdminPubkeys.size === 0) {
    return { ok: false, status: 403, message: "relay management requires configured managementAdminPubkeys" };
  }
  return { ok: true, pubkey: event.pubkey };
}
