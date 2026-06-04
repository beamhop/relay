/**
 * The Relay: plugin registry, message dispatch, event validation pipeline,
 * subscription broadcast, and Bun.serve wiring (HTTP + WebSocket).
 */
import { Connection } from "./connection.ts";
import { matchFilters } from "./filter.ts";
import type {
  AcceptResult,
  EventValidator,
  HttpRoute,
  MessageHandler,
  NostrPlugin,
  PluginContext,
  RelayConfig,
  VisibilityFilter,
} from "./plugin.ts";
import { MemoryEventStore } from "./store/memory-store.ts";
import type { EventStore } from "./store/store.ts";
import type { ClientMessage, NostrEvent } from "./types.ts";

/** Data stashed on each upgraded WebSocket. */
interface SocketData {
  conn: Connection;
}

/** The concrete server type returned by Bun.serve. */
export type RelayServer = ReturnType<typeof Bun.serve>;

/** Options for {@link Relay.listen}. */
export interface ListenOptions {
  /** Bind address. Defaults to 0.0.0.0 (all interfaces). */
  hostname?: string;
  /** TLS config for native wss://. Pass cert/key to terminate TLS in-process. */
  tls?: Bun.TLSOptions;
}

export class Relay {
  readonly config: RelayConfig;
  readonly store: EventStore;
  private plugins: NostrPlugin[] = [];
  private connectionsSet = new Set<Connection>();
  private installed = false;

  private handlerMap = new Map<string, MessageHandler[]>();
  private validators: EventValidator[] = [];
  private visibility: VisibilityFilter[] = [];
  private routes: HttpRoute[] = [];

  /** Cached plugin context. Immutable after construction; built lazily. */
  private cachedCtx?: PluginContext;

  constructor(config: RelayConfig = {}) {
    this.config = config;
    this.store = config.store ?? new MemoryEventStore();
  }

  /** Register a plugin. Plugins are composed in registration order. */
  use(plugin: NostrPlugin): this {
    if (this.installed) {
      throw new Error("cannot add plugins after the relay has been installed");
    }
    this.plugins.push(plugin);
    return this;
  }

  private ctx(): PluginContext {
    // The context is immutable for the relay's lifetime (store, config, and the
    // bound methods never change), so build it once and reuse it. This avoids
    // allocating a fresh object plus four closures on every message, validation,
    // and per-connection visibility check (the broadcast hot path).
    return (this.cachedCtx ??= {
      store: this.store,
      broadcast: (event) => this.broadcast(event),
      connections: () => this.connectionsSet.values(),
      isVisible: (event, conn) => this.isVisible(event, conn),
      config: this.config,
    });
  }

  /**
   * Whether `event` passes every plugin visibility filter for `conn` (NIP-40
   * expiration, NIP-17 gift-wrap gating, etc.). When `conn` is omitted,
   * connection-dependent filters see `undefined` and decide accordingly.
   */
  isVisible(event: NostrEvent, conn?: Connection): boolean {
    const ctx = this.ctx();
    for (const filter of this.visibility) {
      if (!filter(event, ctx, conn)) return false;
    }
    return true;
  }

  /** Build dispatch tables and run plugin onInstall hooks (idempotent). */
  install(): this {
    if (this.installed) return this;
    const ctx = this.ctx();
    for (const plugin of this.plugins) {
      if (plugin.messageHandlers) {
        for (const verb in plugin.messageHandlers) {
          const handler = plugin.messageHandlers[verb];
          if (!handler) continue;
          const list = this.handlerMap.get(verb) ?? [];
          list.push(handler);
          this.handlerMap.set(verb, list);
        }
      }
      if (plugin.eventValidators) this.validators.push(...plugin.eventValidators);
      if (plugin.visibilityFilters) this.visibility.push(...plugin.visibilityFilters);
      if (plugin.httpRoutes) this.routes.push(...plugin.httpRoutes);
      plugin.onInstall?.(ctx);
    }
    this.installed = true;
    return this;
  }

  /** Run all event validators; the first failure short-circuits. */
  async validateEvent(event: NostrEvent): Promise<AcceptResult> {
    const ctx = this.ctx();
    for (const validator of this.validators) {
      const result = await validator(event, ctx);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  /** Merged NIP-11 relay information document. */
  get info(): Record<string, unknown> {
    const ctx = this.ctx();
    const supported = new Set<number>();
    let merged: Record<string, unknown> = {};
    for (const plugin of this.plugins) {
      for (const nip of plugin.supportedNips ?? []) supported.add(nip);
      if (plugin.relayInfo) merged = { ...merged, ...plugin.relayInfo(ctx) };
    }
    const info: Record<string, unknown> = {
      name: this.config.name,
      description: this.config.description,
      pubkey: this.config.pubkey,
      contact: this.config.contact,
      software: this.config.software,
      version: this.config.version,
      supported_nips: [...supported].sort((a, b) => a - b),
      ...merged,
    };
    if (this.config.limitation) info.limitation = this.config.limitation;
    return info;
  }

  /**
   * Deliver an event to every matching open subscription. Visibility is checked
   * per connection (a NIP-17 gift wrap is delivered only to the AUTH'd
   * recipient, even if other connections subscribe to the same filter).
   */
  broadcast(event: NostrEvent): void {
    for (const conn of this.connectionsSet) {
      // Most connections won't subscribe to this event. Collect matching
      // subscriptions first (cheap), and only run the visibility filters (more
      // expensive, and per-connection) once we know there's something to send —
      // visibility is computed at most once per connection rather than eagerly.
      let visible: boolean | undefined;
      for (const [subId, filters] of conn.subscriptions) {
        if (!matchFilters(event, filters)) continue;
        if (visible === undefined) visible = this.isVisible(event, conn);
        if (!visible) break;
        conn.send(["EVENT", subId, event]);
      }
    }
  }

  /** Dispatch a raw inbound text frame from a connection. */
  async handleMessage(conn: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      conn.send(["NOTICE", "invalid: malformed JSON"]);
      return;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      conn.send(["NOTICE", "invalid: message must be a JSON array with a verb"]);
      return;
    }
    const verb = parsed[0];
    const handlers = this.handlerMap.get(verb);
    if (!handlers) {
      conn.send(["NOTICE", `unsupported: unknown message type "${verb}"`]);
      return;
    }
    const ctx = this.ctx();
    for (const handler of handlers) {
      const claimed = await handler(conn, parsed as ClientMessage, ctx);
      if (claimed === true) return;
    }
  }

  /** Register a connection (called on WebSocket open). */
  addConnection(conn: Connection): void {
    this.connectionsSet.add(conn);
    const ctx = this.ctx();
    for (const plugin of this.plugins) plugin.onConnect?.(conn, ctx);
  }

  /** Deregister a connection (called on WebSocket close). */
  removeConnection(conn: Connection): void {
    this.connectionsSet.delete(conn);
    conn.subscriptions.clear();
    const ctx = this.ctx();
    for (const plugin of this.plugins) plugin.onDisconnect?.(conn, ctx);
  }

  connections(): Iterable<Connection> {
    return this.connectionsSet.values();
  }

  /**
   * HTTP handler. Tries plugin routes (e.g. NIP-11); if none claims the
   * request, upgrades to WebSocket; otherwise returns 426.
   */
  async fetch(req: Request, server: RelayServer): Promise<Response | undefined> {
    const ctx = this.ctx();
    for (const route of this.routes) {
      const res = await route.handle(req, ctx);
      if (res) return res;
    }
    if (server.upgrade(req, { data: { conn: undefined as never } })) {
      return undefined;
    }
    return new Response("nostr relay: WebSocket upgrade required", {
      status: 426,
    });
  }

  /** Bun WebSocket handler. */
  get websocket(): Bun.WebSocketHandler<SocketData> {
    return {
      open: (ws) => {
        const conn = new Connection(ws);
        ws.data = { conn };
        this.addConnection(conn);
      },
      message: (ws, message) => {
        const raw = typeof message === "string" ? message : message.toString();
        void this.handleMessage(ws.data.conn, raw);
      },
      close: (ws) => {
        this.removeConnection(ws.data.conn);
      },
    };
  }

  /**
   * Start a Bun.serve listener.
   *
   * Pass `tls` to terminate TLS natively and serve `wss://` directly (no
   * reverse proxy needed). `hostname` defaults to 0.0.0.0 so the relay is
   * reachable from outside the host, not just localhost.
   */
  listen(port: number, opts: ListenOptions = {}): RelayServer {
    this.install();
    return Bun.serve({
      port,
      hostname: opts.hostname ?? "0.0.0.0",
      tls: opts.tls,
      fetch: (req, server) => this.fetch(req, server),
      websocket: this.websocket,
    });
  }
}
