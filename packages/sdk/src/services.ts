import type { Hono } from "hono";
import type { NostrEvent, UnsignedEvent } from "./nostr";
import type { BeamhopConfig, SettingsService } from "./config";
import type { Stores } from "./stores";
import type { EventBus, EventSource } from "./bus";
import type { HookRegistry } from "./hooks";
import type { Logger } from "./logger";

/** Shared dependencies passed to every service factory. */
export interface CoreDeps {
  config: BeamhopConfig;
  stores: Stores;
  settings: SettingsService;
  hooks: HookRegistry;
  bus: EventBus;
  logger: Logger;
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
  stop(): Promise<void>;
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
  setStatus(sha256: string, status: BlobStatus, actor: string): Promise<void>;
  /** Removes blob data + record; when `block` true adds hash to blocklist so it can't be re-uploaded. */
  delete(sha256: string, actor: string, opts?: { block?: boolean }): Promise<void>;
  deleteByPubkey(pubkey: string, actor: string): Promise<number>;
  usage(pubkey: string): Promise<{ count: number; bytes: number }>;
  /** Raw blob (or its thumbnail) regardless of moderation status — for authenticated admin previews. */
  read(sha256: string, opts?: { thumbnail?: boolean }): Promise<{ body: ReadableStream<Uint8Array>; size: number; type: string } | undefined>;
  stats(): Promise<{ count: number; bytes: number; byType: { type: string; count: number; bytes: number }[] }>;
  /** Adds a hash to the blocklist (purging any stored copy). Optional so test doubles can omit it. */
  block?(sha256: string, reason: string, actor: string): Promise<void>;
  /** Removes a hash from the blocklist; false when it wasn't blocked. */
  unblock?(sha256: string, actor: string): Promise<boolean>;
  /** Blocked hashes, newest first. */
  blocklist?(): Promise<{ sha256: string; reason: string; createdAt: number }[]>;
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
export interface PluginManager {
  list(): PluginInfo[];
  enable(name: string, actor: string): Promise<void>;
  disable(name: string, actor: string): Promise<void>;
  getSettings(name: string): Promise<Record<string, unknown>>;
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
}
export interface AdminApi {
  /** mounted at /admin/api */
  app: Hono;
  /** NIP-86 handler: server routes POST / with Content-Type application/nostr+json+rpc here */
  nip86(req: Request): Promise<Response>;
}
export type CreateAdminApi = (deps: AdminApiDeps) => Promise<AdminApi>;
