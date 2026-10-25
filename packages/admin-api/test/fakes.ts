import type { PushSender } from "../src/services/push";
import type { ScryptParams } from "../src/util/password";
import { Hono } from "hono";
import { matchFilter } from "nostr-tools/filter";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  ConfigSchema,
  EventBus,
  HookRegistry,
  RuntimeSettingsSchema,
  isAddressable,
  isReplaceable,
  getDTag,
  type AdminApiDeps,
  type AuditEntry,
  type AuditLog,
  type BlobRecord,
  type BlobStatus,
  type BlossomService,
  type ConnectionSummary,
  type Db,
  type DeepPartial,
  type EventStore,
  type Filter,
  type GroupSummary,
  type Invite,
  type InviteStore,
  type IpRule,
  type IpRuleStore,
  type KvStore,
  type LiveSnapshot,
  type Logger,
  type MetricsService,
  type NostrEvent,
  type PluginInfo,
  type PluginManager,
  type RelayEngine,
  type RuntimeSettings,
  type SettingsService,
  type Stores,
  type UserQuery,
  type UserRecord,
  type UserStore,
} from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { createAdminApi, type AdminApiOptions } from "../src/index";
import { sha256Hex } from "../src/util/nip98";

// ------------------------------------------------------------------ stores

export class FakeEventStore implements EventStore {
  events = new Map<string, NostrEvent>();
  async init() {}
  async save(ev: NostrEvent) {
    if (this.events.has(ev.id)) return { status: "duplicate" as const, message: "duplicate: already have this event" };
    if (isReplaceable(ev.kind) || isAddressable(ev.kind)) {
      for (const old of this.events.values()) {
        if (old.pubkey === ev.pubkey && old.kind === ev.kind && (!isAddressable(ev.kind) || getDTag(old) === getDTag(ev))) {
          if (old.created_at >= ev.created_at) return { status: "stale" as const };
          this.events.delete(old.id);
        }
      }
    }
    this.events.set(ev.id, ev);
    return { status: "saved" as const };
  }
  private sorted() {
    return [...this.events.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  }
  async query(filters: Filter[], opts?: { maxLimit?: number }) {
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      const { limit, ...rest } = f;
      let n = 0;
      const cap = Math.min(limit ?? 500, opts?.maxLimit ?? 500);
      for (const ev of this.sorted()) {
        if (n >= cap) break;
        if (matchFilter(rest as never, ev) && (!f.search || ev.content.toLowerCase().includes(f.search.toLowerCase()))) {
          out.set(ev.id, ev);
          n++;
        }
      }
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  }
  async count(filters: Filter[]) {
    return (await this.query(filters.map((f) => ({ ...f, limit: 1e9 })), { maxLimit: 1e9 })).length;
  }
  async getById(id: string) {
    return this.events.get(id);
  }
  async queryIdsForSync() {
    return [];
  }
  async applyDeletion() {
    return 0;
  }
  async deleteByIds(ids: string[]) {
    let n = 0;
    for (const id of ids) if (this.events.delete(id)) n++;
    return n;
  }
  async deleteByFilter(filters: Filter[]) {
    // like the real store: each filter's `limit` caps its deletion (newest first)
    const evs = await this.query(filters.map((f) => ({ ...f, limit: f.limit ?? 1e9 })), { maxLimit: 1e9 });
    return this.deleteByIds(evs.map((e) => e.id));
  }
  async trimPubkey() {
    return { deleted: 0, remaining: 0 };
  }
  async deleteByPubkey(pubkey: string) {
    return this.deleteByFilter([{ authors: [pubkey] }]);
  }
  async purgeExpired() {
    return 0;
  }
  async stats() {
    return { total: this.events.size, byKind: [], sizeBytes: 0 };
  }
}

export class FakeUserStore implements UserStore {
  users = new Map<string, UserRecord>();
  async get(pk: string) {
    return this.users.get(pk);
  }
  async upsert(pubkey: string, patch: Partial<Omit<UserRecord, "pubkey">>) {
    const cur: UserRecord = this.users.get(pubkey) ?? {
      pubkey, status: "active", allowed: false, denied: false, role: null, notes: "", tags: [], rateLimit: null,
      blossomQuota: null, nip05Name: null, invitedBy: null, banReason: null, firstSeenAt: 0, lastSeenAt: 0, eventCount: 0,
    };
    const next = { ...cur, ...patch, pubkey };
    this.users.set(pubkey, next);
    return next;
  }
  async list(q: UserQuery) {
    let items = [...this.users.values()];
    if (q.status) items = items.filter((u) => u.status === q.status);
    if (q.role) items = items.filter((u) => u.role === q.role || q.rolePubkeys?.includes(u.pubkey));
    if (q.allowed !== undefined) items = items.filter((u) => u.allowed === q.allowed);
    if (q.tag) items = items.filter((u) => u.tags.includes(q.tag!));
    if (q.search) items = items.filter((u) => u.pubkey.startsWith(q.search!) || u.notes.includes(q.search!) || q.searchPubkeys?.includes(u.pubkey));
    const off = q.offset ?? 0;
    return { items: items.slice(off, off + (q.limit ?? 50)), total: items.length };
  }
  async touch() {}
  async getByNip05(name: string) {
    return [...this.users.values()].find((u) => u.nip05Name === name);
  }
  async delete(pk: string) {
    this.users.delete(pk);
  }
}

class FakeInviteStore implements InviteStore {
  invites: Invite[] = [];
  async create(i: { createdBy: string; maxUses?: number; expiresAt?: number | null; note?: string }) {
    const inv: Invite = { code: Math.random().toString(36).slice(2, 10), createdBy: i.createdBy, createdAt: 1, maxUses: i.maxUses ?? 1, uses: 0, expiresAt: i.expiresAt ?? null, note: i.note ?? "" };
    this.invites.push(inv);
    return inv;
  }
  async list() {
    return [...this.invites];
  }
  async redeem() {
    return false;
  }
  async revoke(code: string) {
    this.invites = this.invites.filter((i) => i.code !== code);
  }
}

class FakeIpRuleStore implements IpRuleStore {
  rules: IpRule[] = [];
  async list() {
    return [...this.rules];
  }
  async add(r: Omit<IpRule, "createdAt">) {
    this.rules = this.rules.filter((x) => x.cidr !== r.cidr);
    this.rules.push({ ...r, createdAt: 1 });
  }
  async remove(cidr: string) {
    this.rules = this.rules.filter((x) => x.cidr !== cidr);
  }
}

class FakeKv implements KvStore {
  m = new Map<string, unknown>();
  async get<T>(ns: string, k: string) {
    return this.m.get(`${ns}/${k}`) as T | undefined;
  }
  async set(ns: string, k: string, v: unknown) {
    this.m.set(`${ns}/${k}`, v);
  }
  async delete(ns: string, k: string) {
    this.m.delete(`${ns}/${k}`);
  }
  async list<T>(ns: string) {
    const out: Record<string, T> = {};
    for (const [k, v] of this.m) if (k.startsWith(`${ns}/`)) out[k.slice(ns.length + 1)] = v as T;
    return out;
  }
}

export class FakeAudit implements AuditLog {
  entries: AuditEntry[] = [];
  async record(e: Omit<AuditEntry, "id" | "at"> & { at?: number }) {
    this.entries.push({ ...e, id: this.entries.length + 1, at: e.at ?? 0 });
  }
  async list(q: { actor?: string; action?: string; limit?: number }) {
    return this.entries
      .filter((e) => (!q.actor || e.actor === q.actor) && (!q.action || e.action === q.action))
      .reverse()
      .slice(0, q.limit ?? 100);
  }
}

// ------------------------------------------------------------------ services

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k] as Record<string, unknown>, v) : v;
  return out;
}

export function fakeSettings(bus: EventBus): SettingsService {
  let s: RuntimeSettings = RuntimeSettingsSchema.parse({});
  const fns = new Set<(s: RuntimeSettings) => void>();
  return {
    get: () => s,
    async update(patch: DeepPartial<RuntimeSettings>, actor: string) {
      s = RuntimeSettingsSchema.parse(merge(s as unknown as Record<string, unknown>, patch as Record<string, unknown>));
      for (const f of fns) f(s);
      bus.emit("settings.changed", { settings: s, actor });
      return s;
    },
    onChange(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

export function fakeRelay(stores: Stores, bus: EventBus) {
  const disconnects: { id?: string; pubkey?: string; ip?: string }[] = [];
  const groups: GroupSummary[] = [{ id: "g1", name: "Group", about: "", picture: "", private: false, closed: false, members: 2, admins: [], createdAt: 1 }];
  const conns: ConnectionSummary[] = [{ id: "c1", ip: "1.2.3.4", authedPubkeys: [], subscriptions: 1, connectedAt: 1, messagesIn: 0, messagesOut: 0 }];
  const relay: RelayEngine & { disconnects: typeof disconnects } = {
    pubkey: "f".repeat(64),
    disconnects,
    handleConnection: () => ({ id: "x", onMessage() {}, onClose() {} }),
    http: new Hono(),
    async publish(ev, source) {
      if (!verifyEvent({ ...ev })) return { ok: false, message: "invalid: bad signature" };
      const author = await stores.users.get(ev.pubkey);
      if (author?.status === "banned") return { ok: false, message: "blocked: banned" };
      const r = await stores.events.save(ev);
      if (r.status === "duplicate") return { ok: true, message: "duplicate: already have this event" };
      bus.emit("event.accepted", { event: ev, status: "saved", source });
      if (ev.kind === 1984) bus.emit("report.created", { event: ev });
      return { ok: true, message: "" };
    },
    sign: () => {
      throw new Error("n/a");
    },
    connections: () => conns,
    disconnect(t) {
      disconnects.push(t);
      return t.id ? (conns.some((c) => c.id === t.id) ? 1 : 0) : 1;
    },
    nip11: () => ({ supported_nips: [1, 11, 86] }),
    groups: {
      list: async () => groups,
      get: async (id) => {
        const g = groups.find((x) => x.id === id);
        return g ? { ...g, memberList: [] } : undefined;
      },
      delete: async (id) => {
        const i = groups.findIndex((g) => g.id === id);
        if (i >= 0) groups.splice(i, 1);
      },
    },
    start: async () => {},
    stop: async () => {},
  };
  return relay;
}

/** `blocked`: hash → who blocked it (`blockedBy`) */
type FakeBlossom = BlossomService & { blobs: Map<string, BlobRecord>; blocked: Map<string, string | null> };

export function fakeBlossom(): FakeBlossom {
  const blobs = new Map<string, BlobRecord>();
  const blocked = new Map<string, string | null>();
  return {
    blobs,
    blocked,
    app: new Hono(),
    async list(q) {
      let items = [...blobs.values()];
      if (q.status) items = items.filter((b) => b.status === q.status);
      if (q.pubkey) items = items.filter((b) => b.owners.includes(q.pubkey!));
      const off = q.offset ?? 0;
      return { items: items.slice(off, off + (q.limit ?? 50)), total: items.length };
    },
    async get(s) {
      return blobs.get(s);
    },
    async read(s) {
      const b = blobs.get(s);
      if (!b) return undefined;
      const data = new TextEncoder().encode("blob:" + s);
      return { body: new Blob([data]).stream(), size: data.length, type: b.type };
    },
    async setStatus(s, status: BlobStatus, actor) {
      const b = blobs.get(s);
      if (!b) throw new Error("not found");
      b.status = status;
      b.moderatedBy = actor;
    },
    async delete(s, actor, opts) {
      blobs.delete(s);
      if (opts?.block) blocked.set(s, actor);
    },
    async deleteByPubkey(pk) {
      let n = 0;
      for (const [k, b] of blobs) if (b.owners.includes(pk)) (blobs.delete(k), n++);
      return n;
    },
    async usage(pk) {
      const own = [...blobs.values()].filter((b) => b.owners.includes(pk));
      return { count: own.length, bytes: own.reduce((a, b) => a + b.size, 0) };
    },
    async stats() {
      const all = [...blobs.values()];
      return { count: all.length, bytes: all.reduce((a, b) => a + b.size, 0), byType: [] };
    },
    async blocklist() {
      return [...blocked].map(([sha256, blockedBy]) => ({ sha256, reason: "deleted by admin", createdAt: 1, blockedBy }));
    },
    async unblock(s) {
      return blocked.delete(s);
    },
  };
}

export const SNAPSHOT: LiveSnapshot = {
  at: 1, uptimeSec: 10, connections: 3, authedConnections: 1, subscriptions: 5, eventsInPerSec: 1, eventsOutPerSec: 2, reqPerSec: 1,
  rejectedPerSec: 0, totalEvents: 100, dbBytes: 1, mediaBytes: 1, mediaCount: 1, cpuPercent: 1, memoryRss: 1, heapUsed: 1, loopLagMs: 1,
  reqLatencyP50: 1, reqLatencyP95: 1, reqLatencyP99: 1,
};

export function fakeMetrics(): MetricsService & { emit(s: LiveSnapshot): void; listenerCount(): number } {
  const fns = new Set<(s: LiveSnapshot) => void>();
  return {
    listenerCount: () => fns.size,
    start: async () => {},
    stop: async () => {},
    snapshot: () => SNAPSHOT,
    onSnapshot(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    emit(s) {
      for (const f of fns) f(s);
    },
    series: async (_n, r) => [{ t: r.from, v: r.stepSec ?? 0 }],
    kinds: async () => [{ kind: 1, count: 5 }],
    topPubkeys: async () => [],
    rejections: async () => [],
    geo: async () => [],
    lookupIp: (ip) => (ip === "1.2.3.4" ? { country: "DE", lat: 0, lon: 0 } : undefined),
    counter: () => ({ add() {} }),
    gauge: () => ({ set() {} }),
  };
}

export function fakePlugins(): PluginManager {
  const infos: PluginInfo[] = [{ name: "demo", version: "1.0.0", description: "", source: "local", enabled: true, status: "running" }];
  let values: Record<string, unknown> = { a: 1 };
  const adminRoutes = new Hono();
  adminRoutes.get("/demo/hello", (c) => c.json({ hello: c.req.header("x-beamhop-admin-pubkey") }));
  return {
    list: () => infos,
    enable: async (n) => void (infos.find((i) => i.name === n)!.enabled = true),
    disable: async (n) => void (infos.find((i) => i.name === n)!.enabled = false),
    getSettings: async () => values,
    updateSettings: async (_n, v) => (values = { ...values, ...v }),
    adminRoutes,
  };
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

// ------------------------------------------------------------------ harness

export const PUBLIC_URL = "https://relay.test";

export interface Key {
  sk: Uint8Array;
  pk: string;
}
export const newKey = (): Key => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};

export function signEvent(k: Key, kind: number, tags: string[][] = [], content = "", created_at = Math.floor(Date.now() / 1000)): NostrEvent {
  return finalizeEvent({ kind, tags, content, created_at }, k.sk) as NostrEvent;
}

export function nip98Header(k: Key, url: string, method: string, body?: string, extraTags: string[][] = [], created_at?: number): string {
  // nonce keeps otherwise identical same-second requests distinct (the API rejects replayed auth events)
  const tags = [["u", url], ["method", method], ["nonce", Math.random().toString(36).slice(2)], ...extraTags];
  if (body !== undefined) tags.push(["payload", sha256Hex(body)]);
  const ev = signEvent(k, 27235, tags, "", created_at);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

/** cheap scrypt parameters for tests (the defaults take ~128 MiB and ~150 ms per hash) */
export const TEST_SCRYPT: ScryptParams = { N: 1024, r: 8, p: 1 };

export async function createHarness(
  opts: {
    blossom?: boolean;
    pushSender?: PushSender;
    trustProxy?: boolean;
    scryptParams?: ScryptParams;
    db?: Db;
    owner?: Key;
    reportPushIntervalMs?: number;
    importMaxBytes?: number;
    bannedEventsTtlMs?: number;
    /** any other AdminApiOptions (budgets, intervals) */
    apiOptions?: AdminApiOptions;
    storedOwner?: boolean;
  } = {},
) {
  const owner = opts.owner ?? newKey();
  const bus = new EventBus();
  const db = opts.db ?? (await createMemoryDb());
  const stores: Stores = {
    db,
    events: new FakeEventStore(),
    users: new FakeUserStore(),
    invites: new FakeInviteStore(),
    ipRules: new FakeIpRuleStore(),
    kv: new FakeKv(),
    audit: new FakeAudit(),
  };
  const config = ConfigSchema.parse({
    server: { publicUrl: PUBLIC_URL, trustProxy: opts.trustProxy ?? false },
    admin: { owners: opts.storedOwner ? [] : [owner.pk] },
  });
  // `storedOwner`: the owner holds the role through its users row instead of the config (so it can be demoted)
  if (opts.storedOwner) await stores.users.upsert(owner.pk, { role: "owner" });
  const settings = fakeSettings(bus);
  const relay = fakeRelay(stores, bus);
  const metrics = fakeMetrics();
  const blossom = opts.blossom === false ? undefined : fakeBlossom();
  const clock = { now: Date.now() };
  const deps: AdminApiDeps = {
    config,
    stores,
    settings,
    hooks: new HookRegistry(),
    bus,
    logger: silent,
    relay,
    blossom,
    metrics,
    plugins: fakePlugins(),
    version: "0.1.0-test",
  };
  const api = await createAdminApi(deps, {
    now: () => clock.now,
    snapshotIntervalMs: 50,
    heartbeatMs: 1000,
    pushSender: opts.pushSender,
    scryptParams: opts.scryptParams ?? TEST_SCRYPT,
    reportPushIntervalMs: opts.reportPushIntervalMs,
    importMaxBytes: opts.importMaxBytes,
    bannedEventsTtlMs: opts.bannedEventsTtlMs,
    ...opts.apiOptions,
  });

  /** absolute public URL of an admin path (what NIP-98 `u` tags must contain) */
  const url = (path: string) => `${PUBLIC_URL}/admin/api${path}`;
  /**
   * The app is mounted at /admin/api by the server; tests call it directly with relative paths. Like the server adapter,
   * this binds the client IP as `env.ip` (from the rightmost X-Forwarded-For hop when `trustProxy` is set), and like the
   * admin UI's fetch wrapper it sends `X-Requested-With: beamhop` on mutating requests — unless the test sends a session
   * cookie, an Origin, that header or NIP-98 auth itself (CSRF tests do).
   */
  const req = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();
    const own = ["origin", "x-requested-with", "authorization"].some((h) => headers.has(h)) || /\bbh_session=/.test(headers.get("cookie") ?? "");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !own) {
      headers.set("x-requested-with", "beamhop");
    }
    const xff = opts.trustProxy ? headers.get("x-forwarded-for") : null;
    return api.app.request(path, { ...init, headers }, xff ? { ip: xff.split(",").at(-1)!.trim() } : undefined);
  };

  /** Request authenticated with a per-request NIP-98 header. */
  const asKey = (k: Key, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    return req(path, {
      method,
      body,
      headers: {
        authorization: nip98Header(k, url(path), method, body, [], Math.floor(clock.now / 1000)),
        "content-type": "application/json",
        ...init.headers,
      },
    });
  };

  /** Logs in via challenge + NIP-98 and returns the session cookie. */
  const login = async (k: Key): Promise<string> => {
    const { challenge } = (await (await req("/auth/challenge")).json()) as { challenge: string };
    const event = signEvent(k, 27235, [["u", url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]], "", Math.floor(clock.now / 1000));
    const res = await req("/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: { "content-type": "application/json" } });
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${await res.text()}`);
    return cookieFrom(res)!;
  };

  /** Cookie-authenticated request (sends the CSRF header). */
  const withCookie = (cookie: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    req(path, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      headers: { cookie, "x-requested-with": "beamhop", "content-type": "application/json", ...init.headers },
    });

  const addAdmin = async (role: "owner" | "admin" | "moderator" | "viewer") => {
    const k = newKey();
    await stores.users.upsert(k.pk, { role });
    return k;
  };

  return { api, deps, stores, bus, owner, relay, metrics, blossom, settings, clock, url, req, asKey, login, withCookie, addAdmin, audit: stores.audit as FakeAudit, events: stores.events as FakeEventStore };
}

/** What the admin UI sends with every API call (CSRF proof + JSON body), for tests that call the app directly. */
export const PANEL_HEADERS = { "x-requested-with": "beamhop", "content-type": "application/json" } as const;

export function cookieFrom(res: Response): string | undefined {
  const sc = res.headers.get("set-cookie");
  const m = sc && /bh_session=([^;]*)/.exec(sc);
  return m && m[1] ? `bh_session=${m[1]}` : undefined;
}
