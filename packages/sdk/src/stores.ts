import type { Filter, NostrEvent } from "./nostr";
import type { Db } from "./db";

export type SaveStatus = "saved" | "duplicate" | "replaced" | "stale" | "deleted" | "blocked";
export interface SaveResult {
  status: SaveStatus;
  /** human readable, used for OK message when not saved */
  message?: string;
}

export interface QueryOptions {
  /** hard cap regardless of filter.limit */
  maxLimit?: number;
  signal?: AbortSignal;
}

export interface EventStoreStats {
  total: number;
  byKind: { kind: number; count: number }[];
  sizeBytes: number;
}

export interface EventStore {
  init(): Promise<void>;
  /** Handles replaceable/addressable semantics, duplicate detection, and NIP-09 tombstones. */
  save(event: NostrEvent): Promise<SaveResult>;
  /** Results ordered created_at DESC, id ASC; each filter's limit applied independently; deduped. */
  query(filters: Filter[], opts?: QueryOptions): Promise<NostrEvent[]>;
  count(filters: Filter[]): Promise<number>;
  getById(id: string): Promise<NostrEvent | undefined>;
  /** For NIP-77: returns (created_at,id) pairs ordered asc. */
  queryIdsForSync(filter: Filter): Promise<{ id: string; created_at: number }[]>;
  /** Applies a NIP-09 deletion request (kind 5) — only deletes events of the same pubkey; records tombstones. */
  applyDeletion(deletion: NostrEvent): Promise<number>;
  /** Admin deletion, no ownership check. */
  deleteByIds(ids: string[]): Promise<number>;
  deleteByFilter(filters: Filter[]): Promise<number>;
  /** NIP-62 / admin purge of everything by pubkey. */
  deleteByPubkey(pubkey: string): Promise<number>;
  /** NIP-40: delete events whose expiration tag < now. */
  purgeExpired(now: number): Promise<number>;
  stats(): Promise<EventStoreStats>;
}

export type UserStatus = "active" | "banned" | "muted";

export interface RateLimitOverride {
  eventsPerMinute?: number;
  reqPerMinute?: number;
}

export interface UserRecord {
  pubkey: string;
  status: UserStatus;
  /** explicitly allow-listed (used by whitelist access mode) */
  allowed: boolean;
  /** explicitly deny-listed */
  denied: boolean;
  /** admin role if any; null for normal users */
  role: AdminRole | null;
  notes: string;
  tags: string[];
  rateLimit: RateLimitOverride | null;
  /** bytes; null = default from settings */
  blossomQuota: number | null;
  /** NIP-05 local name (name@relay-domain) */
  nip05Name: string | null;
  invitedBy: string | null;
  banReason: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
}

export interface UserQuery {
  search?: string; // pubkey prefix, nip05 name, tag, notes
  /** extra pubkeys that also match `search` (e.g. resolved from npub or profile names) */
  searchPubkeys?: string[];
  /** extra pubkeys that also match `role` (e.g. config owners not stored in the DB) */
  rolePubkeys?: string[];
  status?: UserStatus;
  role?: AdminRole;
  allowed?: boolean;
  tag?: string;
  sort?: "lastSeen" | "firstSeen" | "eventCount";
  limit?: number;
  offset?: number;
}

export interface UserStore {
  get(pubkey: string): Promise<UserRecord | undefined>;
  /** Creates with defaults if missing; merges patch. */
  upsert(pubkey: string, patch: Partial<Omit<UserRecord, "pubkey">>): Promise<UserRecord>;
  list(q: UserQuery): Promise<{ items: UserRecord[]; total: number }>;
  /** Called on every accepted event (should be cheap / batched). */
  touch(pubkey: string, at: number): Promise<void>;
  getByNip05(name: string): Promise<UserRecord | undefined>;
  delete(pubkey: string): Promise<void>;
}

export interface Invite {
  code: string;
  createdBy: string;
  createdAt: number;
  maxUses: number;
  uses: number;
  expiresAt: number | null;
  note: string;
}

export interface InviteStore {
  create(input: { createdBy: string; maxUses?: number; expiresAt?: number | null; note?: string }): Promise<Invite>;
  list(): Promise<Invite[]>;
  /** Atomically consumes one use, returns false if invalid/expired/exhausted. Marks pubkey allowed + invitedBy. */
  redeem(code: string, pubkey: string): Promise<boolean>;
  revoke(code: string): Promise<void>;
}

export interface IpRule {
  cidr: string; // single IP or CIDR
  action: "block" | "allow";
  reason: string;
  createdAt: number;
}

export interface IpRuleStore {
  list(): Promise<IpRule[]>;
  add(rule: Omit<IpRule, "createdAt">): Promise<void>;
  remove(cidr: string): Promise<void>;
}

/** Namespaced JSON key-value store (runtime settings, plugin settings, misc state). */
export interface KvStore {
  get<T = unknown>(namespace: string, key: string): Promise<T | undefined>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list<T = unknown>(namespace: string): Promise<Record<string, T>>;
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: string; // admin pubkey or "system" or "plugin:<name>"
  action: string; // e.g. "user.ban", "event.delete", "settings.update"
  target: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "id" | "at"> & { at?: number }): Promise<void>;
  list(q: { actor?: string; action?: string; target?: string; before?: number; limit?: number }): Promise<AuditEntry[]>;
}

export type AdminRole = "owner" | "admin" | "moderator" | "viewer";

/** Everything the storage package provides. */
export interface Stores {
  db: Db;
  events: EventStore;
  users: UserStore;
  invites: InviteStore;
  ipRules: IpRuleStore;
  kv: KvStore;
  audit: AuditLog;
}
