import type { Hono } from "hono";
import type { NostrEvent, UnsignedEvent } from "./nostr";
import type { BeamhopConfig, SettingsService } from "./config";
import type { Stores } from "./stores";
import type { EventBus, EventSource } from "./bus";
import type { HookRegistry } from "./hooks";
import type { Logger } from "./logger";
import type { StopContext, TaskTracker } from "./lifecycle";
import type { DatabaseSwitcher } from "./db-switch";

/** Shared dependencies passed to every service factory. */
export interface CoreDeps {
  config: BeamhopConfig;
  stores: Stores;
  settings: SettingsService;
  hooks: HookRegistry;
  bus: EventBus;
  logger: Logger;
  /**
   * Background work started off request paths (report filing, pushes, prunes): shutdown awaits it, bounded, before
   * the database closes. The server passes one shared tracker; without it a service keeps its own.
   */
  tasks?: TaskTracker;
}

// ---------------------------------------------------------------- relay (packages/core)

/** Runtime-agnostic socket; server adapts Bun.serve websockets and `ws` (Node) to this. */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** bytes queued, for backpressure (optional) */
  bufferedAmount?(): number;
}
export interface ConnectionMeta {
  ip: string;
  userAgent?: string;
  origin?: string;
}
export interface ConnectionHandle {
  id: string;
  onMessage(data: string): void;
  onClose(): void;
}
export interface ConnectionSummary {
  id: string;
  ip: string;
  userAgent?: string;
  authedPubkeys: string[];
  subscriptions: number;
  /** epoch milliseconds */
  connectedAt: number;
  messagesIn: number;
  messagesOut: number;
}

export interface GroupSummary {
  id: string;
  name: string;
  about: string;
  picture: string;
  private: boolean;
  closed: boolean;
  members: number;
  admins: string[];
  createdAt: number;
}

export interface RelayEngine {
  /** hex pubkey of the relay key (NIP-11 `self`, NIP-29 signer) */
  readonly pubkey: string;
  /** Call on each WS upgrade. Rejects (closes) if IP blocked / too many connections. */
  handleConnection(socket: RelaySocket, meta: ConnectionMeta): ConnectionHandle;
  /** The IP rules' verdict for a client address (the server refuses HTTP from blocked ones too). Optional for test doubles. */
  checkIp?(ip: string): { blocked: boolean; reason?: string };
  /**
   * Relay HTTP routes, mounted at "/" by the server BEFORE the admin UI/blossom catch-alls:
   * - GET / with Accept: application/nostr+json → NIP-11
   * - GET /.well-known/nostr.json → NIP-05
   */
  http: Hono;
  /** Ingest an event through the full pipeline (admin import, plugins). */
  publish(event: NostrEvent, source: EventSource): Promise<{ ok: boolean; message: string }>;
  /** Sign a template with the relay key. */
  sign(template: UnsignedEvent): NostrEvent;
  connections(): ConnectionSummary[];
  /** Disconnect by connection id, pubkey or ip. Returns number closed. */
  disconnect(target: { id?: string; pubkey?: string; ip?: string }): number;
  nip11(): Record<string, unknown>;
  groups: {
    list(): Promise<GroupSummary[]>;
    get(id: string): Promise<(GroupSummary & { memberList: { pubkey: string; roles: string[] }[] }) | undefined>;
    delete(id: string, actor: string): Promise<void>;
  };
  /** starts background jobs (expiration purge, retention, etc.) */
  start(): Promise<void>;
  /**
   * Shutdown, first phase: refuse new connections and messages, answer the EVENTs already queued, let running jobs
   * finish (they are asked to stop at their next safe point). Returns by `ctx.deadline`. Optional for test doubles.
   */
  drain?(ctx: StopContext): Promise<void>;
  /** Closes every connection (1001): EVENTs still unanswered get OK false first. */
  stop(ctx?: StopContext): Promise<void>;
}
export type CreateRelay = (deps: CoreDeps) => Promise<RelayEngine>;

// ---------------------------------------------------------------- blossom (packages/blossom)

export type BlobStatus = "approved" | "pending" | "blocked";
export interface BlobRecord {
  sha256: string;
  size: number;
  type: string;
  /** pubkeys that own (uploaded/mirrored) this blob */
  owners: string[];
  createdAt: number;
  status: BlobStatus;
  /** pubkey of the admin who set the current pending/blocked status; null when approved or held back automatically */
  moderatedBy?: string | null;
  hasThumbnail: boolean;
  /** public URL `${publicUrl}/${sha256}.${ext}` */
  url: string;
  thumbnailUrl?: string;
}
export interface BlossomService {
  /** Mounted at "/" by the server. Routes: GET|HEAD /:sha256(.ext), PUT /upload, HEAD /upload, GET /list/:pubkey, DELETE /:sha256, PUT /mirror */
  app: Hono;
  list(q: { pubkey?: string; status?: BlobStatus; type?: string; limit?: number; offset?: number }): Promise<{ items: BlobRecord[]; total: number }>;
  get(sha256: string): Promise<BlobRecord | undefined>;
  /** `ip`: the requester's address, recorded in the audit entry (and the bus "admin.action" event). */
  setStatus(sha256: string, status: BlobStatus, actor: string, opts?: { ip?: string | null }): Promise<void>;
  /** Removes blob data + record; when `block` true adds hash to blocklist so it can't be re-uploaded. `ip` as for setStatus. */
  delete(sha256: string, actor: string, opts?: { block?: boolean; ip?: string | null }): Promise<void>;
  deleteByPubkey(pubkey: string, actor: string): Promise<number>;
  usage(pubkey: string): Promise<{ count: number; bytes: number }>;
  /** Raw blob (or its thumbnail) regardless of moderation status — for authenticated admin previews. */
  read(sha256: string, opts?: { thumbnail?: boolean }): Promise<{ body: ReadableStream<Uint8Array>; size: number; type: string } | undefined>;
  stats(): Promise<{ count: number; bytes: number; byType: { type: string; count: number; bytes: number }[] }>;
  /** Adds a hash to the blocklist (purging any stored copy). Optional so test doubles can omit it. */
  block?(sha256: string, reason: string, actor: string): Promise<void>;
  /** Removes a hash from the blocklist; false when it wasn't blocked. */
  unblock?(sha256: string, actor: string): Promise<boolean>;
  /** Blocked hashes, newest first. `blockedBy`: pubkey of the admin who blocked it (null when unknown). */
  blocklist?(): Promise<{ sha256: string; reason: string; createdAt: number; blockedBy?: string | null }[]>;
  /** Shutdown: refuse new uploads/mirrors (503), stop background upkeep, await it until `ctx.deadline`. */
  drain?(ctx: StopContext): Promise<void>;
  stop?(ctx: StopContext): Promise<void>;
}
export type CreateBlossom = (deps: CoreDeps) => Promise<BlossomService>;

// ---------------------------------------------------------------- metrics (packages/metrics)

export interface LiveSnapshot {
  at: number;
  uptimeSec: number;
  connections: number;
  authedConnections: number;
  subscriptions: number;
  eventsInPerSec: number;
  eventsOutPerSec: number;
  reqPerSec: number;
  rejectedPerSec: number;
  totalEvents: number;
  dbBytes: number;
  mediaBytes: number;
  mediaCount: number;
  cpuPercent: number;
  memoryRss: number;
  heapUsed: number;
  /** event loop lag ms */
  loopLagMs: number;
  /** REQ latency percentiles ms (last minute) */
  reqLatencyP50: number;
  reqLatencyP95: number;
  reqLatencyP99: number;
}
export type MetricName =
  | "connections" | "events_in" | "events_out" | "req" | "rejected" | "cpu" | "memory" | "loop_lag" | "req_latency_p95"
  | "blobs_uploaded" | "blob_bytes_served" | (string & {});
export interface TimeRange { from: number; to: number; stepSec?: number }
export interface GeoPoint { country: string; countryName: string; city?: string; lat: number; lon: number; connections: number; events: number }

export interface MetricsService {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): LiveSnapshot;
  onSnapshot(fn: (s: LiveSnapshot) => void): () => void;
  series(name: MetricName, range: TimeRange): Promise<{ t: number; v: number }[]>;
  kinds(range: TimeRange): Promise<{ kind: number; count: number }[]>;
  topPubkeys(range: TimeRange, limit?: number): Promise<{ pubkey: string; events: number; rejected: number }[]>;
  rejections(range: TimeRange): Promise<{ code: string; reason: string; count: number }[]>;
  geo(range: TimeRange): Promise<GeoPoint[]>;
  /** IP → geo lookup (undefined if no geoip db) */
  lookupIp(ip: string): { country: string; city?: string; lat: number; lon: number } | undefined;
  /** custom metrics for plugins */
  counter(name: string, help?: string): { add(v?: number, attrs?: Record<string, string>): void };
  gauge(name: string, help?: string): { set(v: number, attrs?: Record<string, string>): void };
}
export type CreateMetrics = (deps: CoreDeps & { relay: RelayEngine; blossom?: BlossomService }) => Promise<MetricsService>;

// ---------------------------------------------------------------- plugins (packages/server implements)

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  source: "npm" | "local";
  enabled: boolean;
  status: "running" | "disabled" | "error";
  error?: string;
  /** JSON Schema of settings (from zod) for auto-rendered forms */
  settingsSchema?: Record<string, unknown>;
  /** URL of the admin-ui ESM bundle if the plugin has UI */
  uiUrl?: string;
}
/** Enable/disable/settings changes are not audited here: the caller (admin API) records them once, with the request's IP. */
export interface PluginManager {
  list(): PluginInfo[];
  enable(name: string, actor: string): Promise<void>;
  disable(name: string, actor: string): Promise<void>;
  getSettings(name: string): Promise<Record<string, unknown>>;
  /** Merges `values` into the stored settings (top-level fields left out keep their values), validates, saves; returns the result. */
  updateSettings(name: string, values: Record<string, unknown>, actor: string): Promise<Record<string, unknown>>;
  /** Hono app with each plugin's admin routes under /:pluginName/*, mounted at /admin/api/plugins/x by admin-api (auth applied). */
  adminRoutes: Hono;
}

// ---------------------------------------------------------------- admin api (packages/admin-api)

export interface AdminApiDeps extends CoreDeps {
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  plugins: PluginManager;
  version: string;
  /** runtime database switching (absent when unavailable, e.g. tests) */
  databaseSwitcher?: DatabaseSwitcher;
}
export interface AdminApi {
  /** mounted at /admin/api */
  app: Hono;
  /** NIP-86 handler: server routes POST / with Content-Type application/nostr+json+rpc here (`env.ip`: client IP, for audit) */
  nip86(req: Request, env?: { ip?: string }): Promise<Response>;
  /** Shutdown: end the live (SSE) streams, drop pending push digests, await pushes being sent until `ctx.deadline`. */
  drain?(ctx: StopContext): Promise<void>;
  stop?(ctx: StopContext): Promise<void>;
}
export type CreateAdminApi = (deps: AdminApiDeps) => Promise<AdminApi>;
