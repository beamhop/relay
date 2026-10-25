import { Hono } from "hono";
import {
  ConfigSchema,
  RuntimeSettingsSchema,
  type AdminApi,
  type AuditEntry,
  type BeamhopConfig,
  type BlossomService,
  type ConnectionHandle,
  type Db,
  type DeepPartial,
  type EventBus,
  type KvStore,
  type LiveSnapshot,
  type MetricsService,
  type Migration,
  type RelayEngine,
  type RelaySocket,
  type RuntimeSettings,
  type SettingsService,
  type Stores,
  type UserRecord,
} from "@beamhop/sdk";
import type { BeamhopFactories } from "../src/app";

export function testConfig(patch: Record<string, unknown> = {}): BeamhopConfig {
  return ConfigSchema.parse({ database: { sqlitePath: ":memory:" }, plugins: { dir: "/nonexistent-beamhop-plugins" }, logLevel: "error", ...patch });
}

export function stubDb(): Db & { migrations: Record<string, string[]>; closed: boolean } {
  const db = {
    dialect: "sqlite" as const,
    migrations: {} as Record<string, string[]>,
    closed: false,
    async all() { return []; },
    async get() { return undefined; },
    async run() { return { changes: 0 }; },
    async exec() {},
    async tx<T>(fn: (d: Db) => Promise<T>): Promise<T> { return fn(db as Db); },
    async migrate(ns: string, m: Migration[]) {
      const done = (db.migrations[ns] ??= []);
      for (const x of m) if (!done.includes(x.id)) done.push(x.id);
    },
    async close() { db.closed = true; },
  };
  return db;
}

export function stubStores(): Stores & { db: ReturnType<typeof stubDb>; auditEntries: AuditEntry[]; kvData: Map<string, unknown> } {
  const kvData = new Map<string, unknown>();
  const kv: KvStore = {
    async get<T>(ns: string, k: string) { return kvData.get(`${ns}/${k}`) as T | undefined; },
    async set(ns, k, v) { kvData.set(`${ns}/${k}`, structuredClone(v)); },
    async setIfAbsent(ns, k, v) {
      if (kvData.has(`${ns}/${k}`)) return false;
      kvData.set(`${ns}/${k}`, structuredClone(v));
      return true;
    },
    async delete(ns, k) { kvData.delete(`${ns}/${k}`); },
    async list<T>(ns: string) {
      const out: Record<string, T> = {};
      for (const [key, v] of kvData) if (key.startsWith(ns + "/")) out[key.slice(ns.length + 1)] = v as T;
      return out;
    },
  };
  const auditEntries: AuditEntry[] = [];
  const users = new Map<string, UserRecord>();
  const blankUser = (pubkey: string): UserRecord => ({
    pubkey, status: "active", allowed: false, denied: false, role: null, notes: "", tags: [], rateLimit: null, blossomQuota: null,
    nip05Name: null, invitedBy: null, banReason: null, firstSeenAt: 0, lastSeenAt: 0, eventCount: 0,
  });
  return {
    db: stubDb(),
    kv,
    kvData,
    auditEntries,
    audit: {
      async record(e) { auditEntries.push({ id: auditEntries.length + 1, at: e.at ?? 0, ...e }); },
      async list() { return auditEntries; },
      async prune() { return 0; },
    },
    users: {
      async get(pk) { return users.get(pk); },
      async upsert(pk, patch) { const u = { ...(users.get(pk) ?? blankUser(pk)), ...patch }; users.set(pk, u); return u; },
      async list() { return { items: [...users.values()], total: users.size }; },
      async touch() {},
      async getByNip05() { return undefined; },
      async delete(pk) { users.delete(pk); },
    },
    events: {
      async init() {}, async save() { return { status: "saved" }; }, async query() { return []; }, async count() { return 0; },
      async getById() { return undefined; }, async queryIdsForSync() { return []; }, async applyDeletion() { return 0; },
      async deleteByIds() { return 0; }, async deleteByFilter() { return 0; }, async trimPubkey() { return { deleted: 0, remaining: 0 }; }, async deleteByPubkey() { return 0; },
      async purgeExpired() { return 0; }, async stats() { return { total: 0, byKind: [], sizeBytes: 0 }; },
      async kindCounts() { return []; },
    },
    invites: { async create() { throw new Error("stub"); }, async list() { return []; }, async redeem() { return false; }, async revoke() {} },
    ipRules: { async list() { return []; }, async add() {}, async remove() {} },
  };
}

export function stubSettings(bus?: EventBus): SettingsService {
  let s: RuntimeSettings = RuntimeSettingsSchema.parse({});
  const fns = new Set<(s: RuntimeSettings) => void>();
  return {
    get: () => s,
    async update(patch: DeepPartial<RuntimeSettings>, actor: string) {
      s = RuntimeSettingsSchema.parse({ ...s, ...patch, info: { ...s.info, ...(patch.info ?? {}) } });
      for (const f of fns) f(s);
      bus?.emit("settings.changed", { settings: s, actor });
      return s;
    },
    onChange(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
}

export interface StubRelay extends RelayEngine {
  started: boolean;
  stopped: boolean;
  sockets: RelaySocket[];
}

export function stubRelay(): StubRelay {
  const http = new Hono();
  http.get("/", (c) => {
    if (!(c.req.header("accept") ?? "").includes("application/nostr+json")) return c.notFound();
    return c.json({ name: "stub", supported_nips: [1, 11] }, 200, { "access-control-allow-origin": "*" });
  });
  http.get("/.well-known/nostr.json", (c) => c.json({ names: {} }));
  const relay: StubRelay = {
    pubkey: "0".repeat(64),
    started: false,
    stopped: false,
    sockets: [],
    http,
    handleConnection(socket, meta): ConnectionHandle {
      relay.sockets.push(socket);
      socket.send(JSON.stringify(["NOTICE", `hello ${meta.ip}`]));
      return { id: String(relay.sockets.length), onMessage: (d) => socket.send(JSON.stringify(["ECHO", d])), onClose() {} };
    },
    async publish() { return { ok: true, message: "" }; },
    sign() { throw new Error("stub"); },
    connections: () => [],
    disconnect: () => 0,
    nip11: () => ({ name: "stub", supported_nips: [1, 11, 42] }),
    groups: { async list() { return []; }, async get() { return undefined; }, async delete() {} },
    async start() { relay.started = true; },
    async stop() { relay.stopped = true; },
  };
  return relay;
}

export function stubBlossom(): BlossomService {
  const app = new Hono();
  app.get("/:sha{[0-9a-f]{64}(\\.[a-z0-9]+)?}", (c) => c.text("blob:" + c.req.param("sha")));
  app.put("/upload", (c) => c.json({ ok: true }));
  return {
    app,
    async list() { return { items: [], total: 0 }; }, async get() { return undefined; }, async read() { return undefined; }, async setStatus() {}, async delete() {},
    async deleteByPubkey() { return 0; }, async usage() { return { count: 0, bytes: 0 }; }, async stats() { return { count: 0, bytes: 0, byType: [] }; },
  };
}

export function stubMetrics(): MetricsService & { stopped: boolean; counters: Record<string, number> } {
  const counters: Record<string, number> = {};
  const m = {
    stopped: false,
    counters,
    async start() {},
    async stop() { m.stopped = true; },
    snapshot: () => ({}) as LiveSnapshot,
    onSnapshot: () => () => {},
    async series() { return []; }, async kinds() { return []; }, async topPubkeys() { return []; }, async rejections() { return []; }, async geo() { return []; },
    lookupIp: () => undefined,
    counter: (name: string) => ({ add: (v = 1) => { counters[name] = (counters[name] ?? 0) + v; } }),
    gauge: (name: string) => ({ set: (v: number) => { counters[name] = v; } }),
  };
  return m;
}

export function stubAdminApi(): AdminApi {
  const app = new Hono();
  // like the real admin-api: the client IP comes from the runtime adapter binding, never from a header
  app.get("/me", (c) => c.json({ pubkey: "me", ip: (c.env as { ip?: string } | undefined)?.ip }));
  return { app, nip86: async () => Response.json({ result: ["supportedmethods"] }) };
}

/** Factories that never touch the real packages. */
export function stubFactories(over: Partial<BeamhopFactories> = {}): Partial<BeamhopFactories> & { relay: StubRelay; stores: ReturnType<typeof stubStores> } {
  const stores = stubStores();
  const relay = stubRelay();
  return {
    stores,
    relay,
    createStores: async () => stores,
    createSettingsService: async (_s, bus) => stubSettings(bus),
    createRelay: async () => relay,
    createBlossom: async () => stubBlossom(),
    createMetrics: async () => stubMetrics(),
    createAdminApi: async () => stubAdminApi(),
    renderPrometheus: () => "# HELP beamhop_up up\nbeamhop_up 1\n",
    ...over,
  };
}
