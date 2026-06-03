/**
 * Plugin contract. Each NIP is an independent plugin that can contribute
 * message-verb handlers, event validators, HTTP routes, NIP-11 metadata, and
 * lifecycle hooks. The Relay composes plugins in registration order.
 */
import type { Connection } from "./connection.ts";
import type { EventStore } from "./store/store.ts";
import type { ClientMessage, NostrEvent } from "./types.ts";

/** Outcome of an event-acceptance check. */
export interface AcceptResult {
  ok: boolean;
  /** Machine-prefixed reason for OK messages, e.g. "invalid: bad signature". */
  reason?: string;
}

/** Services available to plugins and handlers. */
export interface PluginContext {
  store: EventStore;
  /** Deliver an event to all matching open subscriptions. */
  broadcast(event: NostrEvent): void;
  /** Iterate all currently open connections. */
  connections(): Iterable<Connection>;
  config: RelayConfig;
}

/**
 * Handles one client-message verb. Returning `true` claims the message and
 * stops dispatch to later handlers.
 */
export type MessageHandler = (
  conn: Connection,
  msg: ClientMessage,
  ctx: PluginContext,
) => boolean | void | Promise<boolean | void>;

/** Validates/authorizes an event before it is stored and broadcast. */
export type EventValidator = (
  event: NostrEvent,
  ctx: PluginContext,
) => AcceptResult | Promise<AcceptResult>;

/** An HTTP route, tried before the WebSocket upgrade. */
export interface HttpRoute {
  /** Return a Response to claim the request, or undefined to pass it on. */
  handle(
    req: Request,
    ctx: PluginContext,
  ): Response | undefined | Promise<Response | undefined>;
}

export interface NostrPlugin {
  readonly name: string;
  /** NIP numbers surfaced in the NIP-11 `supported_nips` field. */
  readonly supportedNips?: number[];
  /** Verb -> handler map (e.g. EVENT, REQ, CLOSE). */
  readonly messageHandlers?: Partial<Record<string, MessageHandler>>;
  /** Event validators, run in registration order before acceptance. */
  readonly eventValidators?: EventValidator[];
  /** HTTP routes, tried in registration order before WebSocket upgrade. */
  readonly httpRoutes?: HttpRoute[];
  /** Fields merged into the NIP-11 relay information document. */
  relayInfo?(ctx: PluginContext): Record<string, unknown>;
  onInstall?(ctx: PluginContext): void | Promise<void>;
  onConnect?(conn: Connection, ctx: PluginContext): void;
  onDisconnect?(conn: Connection, ctx: PluginContext): void;
}

/** Relay configuration, surfaced (in part) via NIP-11. */
export interface RelayConfig {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  software?: string;
  version?: string;
  /** Replace the default in-memory store with a custom backend. */
  store?: EventStore;
  limitation?: {
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    max_message_length?: number;
  };
}
