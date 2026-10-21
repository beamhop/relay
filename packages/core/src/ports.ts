// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ports: every I/O boundary of Beamhop. Domain packages depend only on these
 * interfaces; runtimes (Bun, Cloudflare) wire concrete adapters.
 *
 * Rules:
 * - Everything is tenant-scoped by `relayId` (virtual relays) unless noted.
 * - No runtime-specific types (no Bun.*, no CF bindings) may appear here.
 * - Use Web-standard types only (Uint8Array, ReadableStream, Request, Response).
 * - Every adapter must pass the contract suite in `@beamhop/testkit`.
 */
import type { NostrEvent } from './event.ts';
import type { Filter } from './filter.ts';

export type RelayId = string;

// ───────────────────────────── Events ─────────────────────────────

export type SaveStatus =
  /** Stored as new. */
  | 'saved'
  /** Same id already stored. */
  | 'duplicate'
  /** Replaceable/addressable older than the current version; not stored. */
  | 'superseded'
  /** Previously deleted via NIP-09 / NIP-62; not stored. */
  | 'deleted';

export interface SaveResult {
  status: SaveStatus;
  /** Ids of events removed because this event replaced them. */
  replaced?: string[];
}

export interface QueryOptions {
  /** Hard cap applied on top of each filter's `limit`. */
  maxLimit?: number;
  /** Abort long scans (Cloudflare CPU limits, client CLOSE). */
  signal?: AbortSignal;
}

export interface StoreStats {
  events: number;
  bytes: number;
  oldest?: number;
  newest?: number;
}

export interface EventStoreCapabilities {
  /** NIP-50 `search` supported. */
  search: boolean;
  /** NIP-45 counts are exact (false → approximate). */
  exactCount: boolean;
}

export interface EventStore {
  readonly capabilities: EventStoreCapabilities;
  init(): Promise<void>;
  /**
   * Atomically store an event, applying NIP-01 replaceable/addressable
   * semantics and refusing events tombstoned by deletion requests.
   * Ephemeral events must never be passed here.
   */
  save(relayId: RelayId, event: NostrEvent): Promise<SaveResult>;
  /**
   * Results across all filters, deduplicated, ordered `created_at` desc then id asc.
   * Each filter's `limit` applies to that filter.
   */
  query(relayId: RelayId, filters: Filter[], opts?: QueryOptions): Promise<NostrEvent[]>;
  count(relayId: RelayId, filters: Filter[]): Promise<number>;
  getById(relayId: RelayId, id: string): Promise<NostrEvent | null>;
  /**
   * NIP-09: delete referenced events (`e` ids and `a` coordinates) authored by
   * `deletion.pubkey`, and tombstone them so re-publishing is refused.
   * Returns ids actually deleted.
   */
  applyDeletion(relayId: RelayId, deletion: NostrEvent): Promise<string[]>;
  /** NIP-62 right to vanish: delete everything by `pubkey` up to `until`, tombstone the author up to `until`. */
  vanish(relayId: RelayId, pubkey: string, until: number): Promise<number>;
  /** Admin/moderation hard delete (no tombstone unless `tombstone`). */
  deleteByIds(relayId: RelayId, ids: string[], opts?: { tombstone?: boolean }): Promise<number>;
  /** Retention: delete events matching filter (e.g. kind + until). */
  deleteMatching(relayId: RelayId, filter: Filter): Promise<number>;
  /** NIP-40: delete events whose expiration <= now (all relays). */
  deleteExpired(now: number): Promise<number>;
  stats(relayId?: RelayId): Promise<StoreStats>;
  close(): Promise<void>;
}

// ───────────────────────────── Blobs ─────────────────────────────

export interface BlobMeta {
  sha256: string;
  size: number;
  type: string;
}

export interface BlobBody extends BlobMeta {
  body: ReadableStream<Uint8Array>;
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/** Content-addressed byte storage. Shared across relays on a node (dedupe). */
export interface BlobStore {
  readonly kind: string;
  init(): Promise<void>;
  /** Caller guarantees sha256 matches data. Idempotent. */
  put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  get(sha256: string, range?: ByteRange): Promise<BlobBody | null>;
  head(sha256: string): Promise<BlobMeta | null>;
  delete(sha256: string): Promise<boolean>;
  list(opts?: { cursor?: string; limit?: number }): Promise<{ items: BlobMeta[]; cursor?: string }>;
}

export interface BlobOwnership {
  relayId: RelayId;
  sha256: string;
  pubkey: string;
  size: number;
  type: string;
  uploadedAt: number;
  /** Optional expiry for retention/TTL. */
  expiresAt?: number;
}

/** Per-relay ownership/index of blobs (lives in the DB, not the blob store). */
export interface BlobIndex {
  init(): Promise<void>;
  addOwner(o: BlobOwnership): Promise<void>;
  removeOwner(relayId: RelayId, sha256: string, pubkey: string): Promise<boolean>;
  owners(relayId: RelayId, sha256: string): Promise<BlobOwnership[]>;
  listByOwner(
    relayId: RelayId,
    pubkey: string,
    opts?: { since?: number; until?: number; limit?: number },
  ): Promise<BlobOwnership[]>;
  list(
    relayId: RelayId,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{
    items: BlobOwnership[];
    cursor?: string;
  }>;
  /** Total bytes owned by pubkey in relay. */
  usage(relayId: RelayId, pubkey: string): Promise<number>;
  /** Number of owners across ALL relays (0 → orphan, eligible for GC). */
  refCount(sha256: string): Promise<number>;
  expired(now: number, limit: number): Promise<BlobOwnership[]>;
}

// ───────────────────────────── Documents / KV ─────────────────────────────

/**
 * Generic JSON document store used by modules for their own state
 * (config revisions, users, tiers, audit, alerts, plugins…).
 * Collections are namespaced by module, e.g. `admin.users`, `enterprise.bindings`.
 */
export interface DocStore {
  init(): Promise<void>;
  get<T = unknown>(collection: string, key: string): Promise<T | null>;
  put<T = unknown>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<boolean>;
  /** Lexicographic key order. `prefix` filters keys. */
  list<T = unknown>(
    collection: string,
    opts?: { prefix?: string; cursor?: string; limit?: number; reverse?: boolean },
  ): Promise<{ items: Array<{ key: string; value: T }>; cursor?: string }>;
  /** Compare-and-set for concurrency control. `expected === null` means "must not exist". */
  cas<T = unknown>(collection: string, key: string, expected: T | null, next: T): Promise<boolean>;
}

/** Append-only metric points with downsampling handled by the adapter or the insights module. */
export interface TimeSeriesStore {
  init(): Promise<void>;
  record(points: MetricPoint[]): Promise<void>;
  range(q: {
    metric: string;
    labels?: Record<string, string>;
    from: number;
    to: number;
    stepSeconds: number;
    agg: 'sum' | 'avg' | 'max' | 'min' | 'last';
  }): Promise<Array<{ t: number; v: number }>>;
  prune(before: number): Promise<number>;
}

export interface MetricPoint {
  metric: string;
  labels: Record<string, string>;
  /** Unix seconds. */
  t: number;
  v: number;
}

// ───────────────────────────── Runtime services ─────────────────────────────

export interface PubSub {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): () => void;
}

export interface Scheduler {
  /** Run `fn` every `intervalSeconds`. Names are unique; re-registering replaces. */
  every(name: string, intervalSeconds: number, fn: () => Promise<void>): void;
  cancel(name: string): void;
}

export interface Clock {
  /** Unix seconds. */
  now(): number;
  nowMs(): number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface Crypto {
  sha256Hex(data: Uint8Array): Promise<string>;
  randomHex(bytes: number): string;
  /** Salted, rotating hash for privacy-first IP logging. */
  hashIp(ip: string): string;
}

// ───────────────────────────── Optional capabilities ─────────────────────────────

export interface MediaOp {
  op: 'strip-metadata' | 'resize' | 'thumbnail' | 'transcode' | 'perceptual-hash';
  width?: number;
  height?: number;
  format?: string;
  quality?: number;
}

export interface MediaResult {
  op: MediaOp['op'];
  data?: Uint8Array;
  type?: string;
  /** For perceptual-hash. */
  hash?: string;
  /** Pixel size of `data` (or of the input, for perceptual-hash), when known. */
  width?: number;
  height?: number;
  /** BlurHash placeholder of the image, when the processor computes one. */
  blurhash?: string;
}

export interface MediaProcessor {
  readonly supports: ReadonlyArray<MediaOp['op']>;
  process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema. */
  parameters: Record<string, unknown>;
}

/** OpenAI-compatible chat (Ollama, any compatible endpoint). */
export interface LLM {
  chat(
    messages: ChatMessage[],
    opts?: { tools?: ToolSpec[]; signal?: AbortSignal },
  ): Promise<ChatMessage>;
}

export interface Notification {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  url?: string;
  relayId?: RelayId;
  /**
   * `ops`: operational (may be mirrored to public status pages).
   * `safety`: abuse/moderation matters — admins only, never published.
   * Absent is treated as `safety` by consumers that publish (fail closed).
   */
  category?: 'ops' | 'safety';
}

export interface Notifier {
  readonly channel: string;
  send(n: Notification, recipient: string): Promise<void>;
}

/** Key wrapping (envelope encryption) — local master key, KMS, Vault. */
export interface KeyWrapper {
  readonly provider: string;
  wrap(plaintext: Uint8Array): Promise<Uint8Array>;
  unwrap(ciphertext: Uint8Array): Promise<Uint8Array>;
}

/**
 * Offloaded Schnorr signature checks (e.g. a worker pool on Bun). Optional: when
 * absent, callers check signatures inline with `verifyEventSig`.
 */
export interface SignatureVerifier {
  /**
   * Check each event's BIP-340 signature over its `id` (the caller has already
   * checked that `id` matches the content). Resolves to one boolean per event, in
   * order. Rejects only when the signatures could not be checked at all (e.g. a
   * worker crashed); callers must then treat the events as not verified.
   */
  verify(events: readonly Pick<NostrEvent, 'id' | 'pubkey' | 'sig'>[]): Promise<boolean[]>;
}

/** The full set of ports handed to modules. Optional ports may be absent on some runtimes. */
export interface Ports {
  events: EventStore;
  blobs: BlobStore;
  blobIndex: BlobIndex;
  docs: DocStore;
  metrics: TimeSeriesStore;
  pubsub: PubSub;
  scheduler: Scheduler;
  clock: Clock;
  logger: Logger;
  crypto: Crypto;
  media?: MediaProcessor;
  llm?: LLM;
  keyWrapper?: KeyWrapper;
  /** Off-thread signature checks; absent → inline. */
  verifier?: SignatureVerifier;
}

export type RuntimeName = 'bun' | 'cloudflare' | 'test';
