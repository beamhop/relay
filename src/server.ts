import type { ServerWebSocket } from "bun";
import { createAdminState, handleAdminRequest } from "./admin";
import { isEventShape, makeChallenge, normalizeRelayUrl, verifyEvent } from "./crypto";
import { matchesAnyFilter, normalizeFilters, validateFilter } from "./filter";
import { isEphemeralKind } from "./kinds";
import { ManagementState } from "./management";
import { createNegentropyResponse, validateNegentropyMessage } from "./negentropy";
import { validateAuthEvent, validateHttpNostrAuthorization } from "./auth";
import { createRelayStats, incrementMessage, recordRelayActivity, type RelayStats } from "./relayStats";
import type { PluginManager } from "./plugins";
import type { EventStore } from "./storage";
import type { ClientMessage, ConnectionState, NostrEvent, NostrFilter, RelayConfig, RelayMessage, ValidationResult } from "./types";

type WsData = { connectionId: string };

export interface RelayRuntime {
  config: RelayConfig;
  store: EventStore;
  plugins: PluginManager;
  management: ManagementState;
}

export async function startRelay(runtime: RelayRuntime): Promise<ReturnType<typeof Bun.serve>> {
  await runtime.store.init();
  const connections = new Map<string, ConnectionState>();
  const relayUrls = relayUrlsFor(runtime.config);
  const stats = createRelayStats();
  const admin = createAdminState();
  recordRelayActivity(stats, "info", "relay started", { host: runtime.config.host, port: runtime.config.port });

  const server = Bun.serve<WsData>({
    hostname: runtime.config.host,
    port: runtime.config.port,
    async fetch(request, server) {
      if (request.method === "OPTIONS") return corsResponse(null, 204);

      const remoteAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      if (runtime.management.isIpBlocked(remoteAddress)) return new Response("blocked", { status: 403 });

      const adminResponse = await handleAdminRequest(request, admin, { runtime, stats, connections, relayUrls });
      if (adminResponse) return adminResponse;

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const connectionId = crypto.randomUUID();
        const state: ConnectionState = {
          id: connectionId,
          challenge: makeChallenge(),
          authenticatedPubkeys: new Set(),
          subscriptions: new Map(),
          negentropySubscriptions: new Map(),
        };
        if (remoteAddress) state.remoteAddress = remoteAddress;
        connections.set(connectionId, state);
        const upgraded = server.upgrade(request, { data: { connectionId } });
        if (!upgraded) {
          connections.delete(connectionId);
          return new Response("websocket upgrade failed", { status: 400 });
        }
        stats.connections.opened += 1;
        recordRelayActivity(stats, "info", "connection opened", { id: shortId(connectionId), remoteAddress: remoteAddress ?? "" });
        return undefined;
      }

      if (request.headers.get("accept")?.includes("application/nostr+json")) {
        return corsResponse(relayInformation(runtime, relayUrls));
      }

      if (request.headers.get("content-type")?.includes("application/nostr+json+rpc")) {
        if (!runtime.plugins.isEnabled("86")) return corsResponse({ result: null, error: "NIP-86 is disabled" }, 404);
        const bodyText = await request.text();
        const auth = await validateHttpNostrAuthorization(request, bodyText, runtime.config);
        if (!auth.ok) return corsResponse({ result: null, error: auth.message }, auth.status);
        let rpc: unknown;
        try {
          rpc = JSON.parse(bodyText) as unknown;
        } catch {
          return corsResponse({ result: null, error: "invalid JSON-RPC body" }, 400);
        }
        return runtime.management.handleRpc(rpc as { method?: string; params?: unknown[] }, runtime.config);
      }

      if (new URL(request.url).pathname === "/plugins") return corsResponse(runtime.plugins.pluginManifest());
      if (new URL(request.url).pathname === "/health") return corsResponse({ ok: true });
      return new Response("Nostr relay. Use WebSocket or Accept: application/nostr+json.", { status: 200 });
    },
    websocket: {
      open(ws) {
        const connection = connections.get(ws.data.connectionId);
        if (!connection) return;
        if (runtime.plugins.isEnabled("42")) send(ws, ["AUTH", connection.challenge]);
      },
      async message(ws, message) {
        const connection = connections.get(ws.data.connectionId);
        if (!connection) return;
        await handleMessage(ws, message, connection, runtime, relayUrls, connections, stats);
      },
      close(ws) {
        const connection = connections.get(ws.data.connectionId);
        connections.delete(ws.data.connectionId);
        activeSockets.delete(ws.data.connectionId);
        stats.connections.closed += 1;
        recordRelayActivity(stats, "info", "connection closed", {
          id: shortId(ws.data.connectionId),
          subscriptions: connection?.subscriptions.size ?? 0,
        });
      },
    },
  });

  return server;
}

async function handleMessage(
  ws: ServerWebSocket<WsData>,
  rawMessage: string | Buffer,
  connection: ConnectionState,
  runtime: RelayRuntime,
  relayUrls: string[],
  connections: Map<string, ConnectionState>,
  stats: RelayStats,
): Promise<void> {
  const raw = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
  if (new TextEncoder().encode(raw).byteLength > runtime.config.limits.maxMessageLength) {
    send(ws, ["NOTICE", "invalid: message exceeds max_message_length"]);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    send(ws, ["NOTICE", "invalid: message is not valid JSON"]);
    return;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
    send(ws, ["NOTICE", "invalid: message must be a JSON array"]);
    return;
  }
  incrementMessage(stats, parsed[0]);

  const message = parsed as ClientMessage;
  switch (message[0]) {
    case "EVENT":
      await handleEvent(ws, message[1], connection, runtime, relayUrls, connections, stats);
      return;
    case "REQ":
      await handleReq(ws, message[1], message.slice(2), connection, runtime, relayUrls, stats);
      return;
    case "CLOSE":
      if (typeof message[1] === "string") {
        connection.subscriptions.delete(message[1]);
        recordRelayActivity(stats, "info", "subscription closed", { id: message[1], connection: shortId(connection.id) });
      }
      return;
    case "COUNT":
      await handleCount(ws, message[1], message.slice(2), connection, runtime, relayUrls);
      return;
    case "AUTH":
      await handleAuth(ws, message[1], connection, runtime, relayUrls, stats);
      return;
    case "NEG-OPEN":
      await handleNegOpen(ws, message, connection, runtime);
      return;
    case "NEG-MSG":
      await handleNegMessage(ws, message, connection, runtime);
      return;
    case "NEG-CLOSE":
      if (typeof message[1] === "string") connection.negentropySubscriptions.delete(message[1]);
      return;
    default:
      send(ws, ["NOTICE", `unsupported: unsupported message type ${message[0]}`]);
      recordRelayActivity(stats, "warn", "unsupported message", { type: message[0] });
  }
}

async function handleEvent(
  ws: ServerWebSocket<WsData>,
  eventLike: unknown,
  connection: ConnectionState,
  runtime: RelayRuntime,
  relayUrls: string[],
  connections: Map<string, ConnectionState>,
  stats: RelayStats,
): Promise<void> {
  if (!isEventShape(eventLike)) {
    send(ws, ["NOTICE", "invalid: EVENT payload is not a Nostr event"]);
    recordRelayActivity(stats, "warn", "invalid EVENT payload");
    return;
  }
  const event = eventLike;
  stats.events.received += 1;
  if (runtime.config.requireAuthForWrite && connection.authenticatedPubkeys.size === 0) {
    maybeSendAuth(ws, connection, runtime);
    send(ws, ["OK", event.id, false, "auth-required: authentication is required to write"]);
    recordEventRejected(stats, event, "auth-required: authentication is required to write");
    return;
  }

  const basic = validateEventForRelay(event, runtime.config);
  if (!basic.ok) {
    send(ws, ["OK", event.id, false, formatResult(basic)]);
    recordEventRejected(stats, event, formatResult(basic));
    return;
  }

  const verified = verifyEvent(event);
  if (!verified.ok) {
    send(ws, ["OK", event.id, false, formatResult(verified)]);
    recordEventRejected(stats, event, formatResult(verified));
    return;
  }

  const moderation = runtime.management.validateEvent(event);
  if (!moderation.ok) {
    send(ws, ["OK", event.id, false, formatResult(moderation)]);
    recordEventRejected(stats, event, formatResult(moderation));
    return;
  }

  const pluginValidation = await runtime.plugins.validateEvent(event, { config: runtime.config, store: runtime.store, relayUrls, connection });
  if (!pluginValidation.ok) {
    if (pluginValidation.prefix === "auth-required") maybeSendAuth(ws, connection, runtime);
    send(ws, ["OK", event.id, false, formatResult(pluginValidation)]);
    recordEventRejected(stats, event, formatResult(pluginValidation));
    return;
  }

  const saveResult = await runtime.store.save(event);
  if (!saveResult.stored && !saveResult.duplicate && saveResult.message) {
    send(ws, ["OK", event.id, false, saveResult.message]);
    recordEventRejected(stats, event, saveResult.message);
    return;
  }

  await runtime.plugins.afterEventAccepted(event, { config: runtime.config, store: runtime.store, relayUrls, connection });

  stats.events.accepted += 1;
  if (saveResult.stored) stats.events.stored += 1;
  else if (saveResult.duplicate) stats.events.duplicate += 1;
  else stats.events.ephemeral += 1;
  recordRelayActivity(stats, "ok", "event accepted", {
    id: shortId(event.id),
    kind: event.kind,
    stored: saveResult.stored,
    duplicate: saveResult.duplicate,
  });

  send(ws, ["OK", event.id, true, saveResult.message]);
  const shouldBroadcast =
    event.kind !== 22242 &&
    !saveResult.duplicate &&
    (saveResult.stored || isEphemeralKind(event.kind)) &&
    ((await runtime.store.has(event.id)) || isEphemeralKind(event.kind));
  if (shouldBroadcast) await broadcastEvent(event, runtime, relayUrls, connections, stats);
}

async function handleReq(
  ws: ServerWebSocket<WsData>,
  subscriptionId: unknown,
  rawFilters: unknown[],
  connection: ConnectionState,
  runtime: RelayRuntime,
  relayUrls: string[],
  stats: RelayStats,
): Promise<void> {
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0 || subscriptionId.length > runtime.config.limits.maxSubIdLength) {
    send(ws, ["NOTICE", "invalid: subscription id must be non-empty and within max_subid_length"]);
    return;
  }
  if (connection.subscriptions.size >= runtime.config.limits.maxSubscriptions && !connection.subscriptions.has(subscriptionId)) {
    send(ws, ["CLOSED", subscriptionId, "rate-limited: max subscriptions reached"]);
    return;
  }

  const filters = normalizeFilters(rawFilters, runtime.config.limits.maxLimit, runtime.config.limits.defaultLimit);
  const filterError = validateFiltersForRelay(filters, runtime);
  if (filterError) {
    send(ws, ["CLOSED", subscriptionId, `invalid: ${filterError}`]);
    return;
  }
  if (runtime.config.requireAuthForRead && connection.authenticatedPubkeys.size === 0) {
    maybeSendAuth(ws, connection, runtime);
    send(ws, ["CLOSED", subscriptionId, "auth-required: authentication is required to read"]);
    return;
  }

  const authorized = await runtime.plugins.authorizeFilters(filters, { config: runtime.config, store: runtime.store, relayUrls, connection });
  if (!authorized.ok) {
    if (authorized.prefix === "auth-required") maybeSendAuth(ws, connection, runtime);
    send(ws, ["CLOSED", subscriptionId, formatResult(authorized)]);
    return;
  }

  connection.subscriptions.set(subscriptionId, { id: subscriptionId, filters });
  recordRelayActivity(stats, "info", "subscription opened", { id: subscriptionId, connection: shortId(connection.id), filters: filters.length });
  const result = await runtime.store.query(filters);
  const outgoing = await runtime.plugins.filterOutgoingEvents(result.events, { config: runtime.config, store: runtime.store, relayUrls, connection });
  for (const event of outgoing) send(ws, ["EVENT", subscriptionId, event]);
  if (runtime.plugins.isEnabled("67")) send(ws, ["EOSE", subscriptionId, [result.complete && outgoing.length === result.events.length ? "finish" : "more"]]);
  else send(ws, ["EOSE", subscriptionId]);
}

async function handleCount(
  ws: ServerWebSocket<WsData>,
  queryId: unknown,
  rawFilters: unknown[],
  connection: ConnectionState,
  runtime: RelayRuntime,
  relayUrls: string[],
): Promise<void> {
  if (typeof queryId !== "string" || queryId.length === 0 || queryId.length > runtime.config.limits.maxSubIdLength) {
    send(ws, ["NOTICE", "invalid: COUNT id must be non-empty and within max_subid_length"]);
    return;
  }
  if (!runtime.plugins.isEnabled("45")) {
    send(ws, ["CLOSED", queryId, "unsupported: NIP-45 COUNT is disabled"]);
    return;
  }
  const filters = normalizeFilters(rawFilters, runtime.config.limits.maxLimit, runtime.config.limits.defaultLimit);
  const filterError = validateFiltersForRelay(filters, runtime);
  if (filterError) {
    send(ws, ["CLOSED", queryId, `invalid: ${filterError}`]);
    return;
  }
  const authorized = await runtime.plugins.authorizeFilters(filters, { config: runtime.config, store: runtime.store, relayUrls, connection });
  if (!authorized.ok) {
    if (authorized.prefix === "auth-required") maybeSendAuth(ws, connection, runtime);
    send(ws, ["CLOSED", queryId, formatResult(authorized)]);
    return;
  }
  send(ws, ["COUNT", queryId, await runtime.store.count(filters)]);
}

async function handleAuth(
  ws: ServerWebSocket<WsData>,
  eventLike: unknown,
  connection: ConnectionState,
  runtime: RelayRuntime,
  relayUrls: string[],
  stats: RelayStats,
): Promise<void> {
  if (!runtime.plugins.isEnabled("42")) {
    send(ws, ["NOTICE", "unsupported: NIP-42 AUTH is disabled"]);
    return;
  }
  if (!isEventShape(eventLike)) {
    send(ws, ["NOTICE", "invalid: AUTH payload is not a Nostr event"]);
    return;
  }
  const result = validateAuthEvent(eventLike, connection, relayUrls, runtime.config);
  if (!result.ok) {
    send(ws, ["OK", eventLike.id, false, formatResult(result)]);
    return;
  }
  connection.authenticatedPubkeys.add(eventLike.pubkey);
  recordRelayActivity(stats, "ok", "connection authenticated", { connection: shortId(connection.id), pubkey: shortId(eventLike.pubkey) });
  send(ws, ["OK", eventLike.id, true, ""]);
}

async function handleNegOpen(
  ws: ServerWebSocket<WsData>,
  message: ClientMessage,
  connection: ConnectionState,
  runtime: RelayRuntime,
): Promise<void> {
  const subscriptionId = message[1];
  if (typeof subscriptionId !== "string") return;
  if (!runtime.plugins.isEnabled("77")) {
    send(ws, ["NEG-ERR", subscriptionId, "unsupported: NIP-77 is disabled"]);
    return;
  }
  const filter = message[2];
  const initialMessage = message[3];
  if (!filter || typeof filter !== "object" || Array.isArray(filter) || typeof initialMessage !== "string") {
    send(ws, ["NEG-ERR", subscriptionId, "invalid: NEG-OPEN requires subscription id, filter and hex message"]);
    return;
  }
  const messageError = validateNegentropyMessage(initialMessage);
  if (messageError) {
    send(ws, ["NEG-ERR", subscriptionId, messageError]);
    return;
  }
  connection.negentropySubscriptions.set(subscriptionId, filter as NostrFilter);
  const response = await createNegentropyResponse(runtime.store, filter as NostrFilter, runtime.config.limits.maxMessageLength);
  if (!response.ok) {
    send(ws, response.maxRecords === undefined ? ["NEG-ERR", subscriptionId, response.reason] : ["NEG-ERR", subscriptionId, response.reason, response.maxRecords]);
    connection.negentropySubscriptions.delete(subscriptionId);
    return;
  }
  send(ws, ["NEG-MSG", subscriptionId, response.message]);
}

async function handleNegMessage(ws: ServerWebSocket<WsData>, message: ClientMessage, connection: ConnectionState, runtime: RelayRuntime): Promise<void> {
  const subscriptionId = message[1];
  if (typeof subscriptionId !== "string") return;
  if (!runtime.plugins.isEnabled("77")) {
    send(ws, ["NEG-ERR", subscriptionId, "unsupported: NIP-77 is disabled"]);
    return;
  }
  const filter = connection.negentropySubscriptions.get(subscriptionId);
  if (!filter) {
    send(ws, ["NEG-ERR", subscriptionId, "closed: negentropy subscription is not open"]);
    return;
  }
  const frame = message[2];
  if (typeof frame !== "string") {
    send(ws, ["NEG-ERR", subscriptionId, "invalid: NEG-MSG requires hex message"]);
    return;
  }
  const messageError = validateNegentropyMessage(frame);
  if (messageError) {
    send(ws, ["NEG-ERR", subscriptionId, messageError]);
    return;
  }
  const response = await createNegentropyResponse(runtime.store, filter, runtime.config.limits.maxMessageLength);
  if (!response.ok) {
    send(ws, response.maxRecords === undefined ? ["NEG-ERR", subscriptionId, response.reason] : ["NEG-ERR", subscriptionId, response.reason, response.maxRecords]);
    connection.negentropySubscriptions.delete(subscriptionId);
    return;
  }
  send(ws, ["NEG-MSG", subscriptionId, response.message]);
}

async function broadcastEvent(
  event: NostrEvent,
  runtime: RelayRuntime,
  relayUrls: string[],
  connections: Map<string, ConnectionState>,
  stats: RelayStats,
): Promise<void> {
  let delivered = 0;
  for (const connection of connections.values()) {
    for (const subscription of connection.subscriptions.values()) {
      if (!matchesAnyFilter(event, subscription.filters)) continue;
      const outgoing = await runtime.plugins.filterOutgoingEvents([event], { config: runtime.config, store: runtime.store, relayUrls, connection });
      if (outgoing.length > 0) {
        publishToConnection(connection.id, ["EVENT", subscription.id, event]);
        delivered += 1;
      }
    }
  }
  if (delivered > 0) {
    stats.events.broadcast += 1;
    stats.events.delivered += delivered;
    recordRelayActivity(stats, "info", "event broadcast", { id: shortId(event.id), recipients: delivered });
  }
}

const activeSockets = new Map<string, ServerWebSocket<WsData>>();

function publishToConnection(connectionId: string, message: RelayMessage): void {
  const ws = activeSockets.get(connectionId);
  if (ws) send(ws, message);
}

function send(ws: ServerWebSocket<WsData>, message: RelayMessage): void {
  activeSockets.set(ws.data.connectionId, ws);
  ws.send(JSON.stringify(message));
}

function maybeSendAuth(ws: ServerWebSocket<WsData>, connection: ConnectionState, runtime: RelayRuntime): void {
  if (runtime.plugins.isEnabled("42")) send(ws, ["AUTH", connection.challenge]);
}

function validateEventForRelay(event: NostrEvent, config: RelayConfig): ValidationResult {
  if (event.tags.length > config.limits.maxEventTags) return { ok: false, prefix: "invalid", message: "event exceeds max_event_tags" };
  if ([...event.content].length > config.limits.maxContentLength) return { ok: false, prefix: "invalid", message: "event exceeds max_content_length" };
  if (config.limits.createdAtLowerLimit !== undefined && event.created_at < config.limits.createdAtLowerLimit) {
    return { ok: false, prefix: "invalid", message: "created_at is below relay lower limit" };
  }
  if (config.limits.createdAtUpperLimit !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (event.created_at > now + config.limits.createdAtUpperLimit) {
      return { ok: false, prefix: "invalid", message: "created_at is above relay upper limit" };
    }
  }
  return { ok: true };
}

function validateFiltersForRelay(filters: NostrFilter[], runtime: RelayRuntime): string | undefined {
  for (const filter of filters) {
    const error = validateFilter(filter);
    if (error) return error;
    if (filter.search && !runtime.plugins.isEnabled("50")) return "search filter requires enabled NIP-50";
  }
  return undefined;
}

function formatResult(result: Exclude<ValidationResult, { ok: true }>): string {
  return `${result.prefix}: ${result.message}`;
}

function recordEventRejected(stats: RelayStats, event: NostrEvent, reason: string): void {
  stats.events.rejected += 1;
  recordRelayActivity(stats, "warn", "event rejected", { id: shortId(event.id), kind: event.kind, reason });
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function relayInformation(runtime: RelayRuntime, relayUrls: string[]) {
  const limitation = {
    max_message_length: runtime.config.limits.maxMessageLength,
    max_subscriptions: runtime.config.limits.maxSubscriptions,
    max_limit: runtime.config.limits.maxLimit,
    max_subid_length: runtime.config.limits.maxSubIdLength,
    max_event_tags: runtime.config.limits.maxEventTags,
    max_content_length: runtime.config.limits.maxContentLength,
    auth_required: runtime.config.requireAuthForRead || runtime.config.requireAuthForWrite,
    restricted_writes: runtime.config.requireAuthForWrite,
    default_limit: runtime.config.limits.defaultLimit,
  };
  return {
    ...runtime.config.relay,
    supported_nips: runtime.plugins.supportedNips(),
    limitation,
    relay_urls: relayUrls,
  };
}

function relayUrlsFor(config: RelayConfig): string[] {
  const urls = new Set<string>();
  if (config.relayUrl) urls.add(normalizeRelayUrl(config.relayUrl));
  urls.add(normalizeRelayUrl(`ws://localhost:${config.port}/`));
  urls.add(normalizeRelayUrl(`ws://127.0.0.1:${config.port}/`));
  return [...urls];
}

function corsResponse(value: unknown, status = 200): Response {
  if (value === null) {
    return new Response(null, {
      status,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type,accept",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      },
    });
  }
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type,accept",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}
