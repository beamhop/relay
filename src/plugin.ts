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
  /**
   * Whether a stored event is currently visible to `conn` (passes all
   * visibility filters). Omit `conn` for a connection-independent check.
   */
  isVisible(event: NostrEvent, conn?: Connection): boolean;
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

/**
 * Decides whether a stored event is visible to a given client *right now*, used
 * to gate both REQ replies and live broadcast. Returning false hides the event
 * without deleting it. Runs after a query/match has already selected the event,
 * so it should be cheap.
 *
 * `conn` is the connection the event would be served to, when known (REQ,
 * COUNT, broadcast). It is undefined for connection-independent checks. Filters
 * that don't care about identity (e.g. NIP-40 expiration) ignore it; filters
 * that gate per-recipient (e.g. NIP-17 gift wraps) use it.
 */
export type VisibilityFilter = (
  event: NostrEvent,
  ctx: PluginContext,
  conn?: Connection,
) => boolean;

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
  /**
   * Visibility filters gating which stored events are served (REQ) and
   * broadcast. An event is hidden if *any* filter returns false.
   */
  readonly visibilityFilters?: VisibilityFilter[];
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
  /**
   * This relay's public WebSocket URL (e.g. wss://relay.example.com). Used to
   * decide whether a NIP-62 request-to-vanish (which scopes itself via `relay`
   * tags) applies here.
   */
  url?: string;
  /**
   * Current time source in Unix *seconds*, used by time-sensitive NIPs
   * (NIP-40 expiration, NIP-22 created_at limits). Defaults to the wall clock.
   * Injectable so tests are deterministic.
   */
  now?: () => number;
  /** Replace the default in-memory store with a custom backend. */
  store?: EventStore;
  limitation?: {
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    max_message_length?: number;
    /** Minimum PoW difficulty the relay requires (NIP-11/NIP-13). */
    min_pow_difficulty?: number;
    /** Max seconds an event's created_at may lag the relay clock (NIP-22). */
    created_at_lower_limit?: number;
    /** Max seconds an event's created_at may lead the relay clock (NIP-22). */
    created_at_upper_limit?: number;
  };
}
