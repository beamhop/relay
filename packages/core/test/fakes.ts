import {
  type AuditLog,
  type BeamhopConfig,
  ConfigSchema,
  type CoreDeps,
  type DeepPartial,
  EventBus,
  type EventStore,
  type Filter,
  HookRegistry,
  type Invite,
  type InviteStore,
  type IpRule,
  type IpRuleStore,
  type KvStore,
  type Logger,
  type NostrEvent,
  type RelaySocket,
  type RuntimeSettings,
  RuntimeSettingsSchema,
  type SaveResult,
  type SettingsService,
  type Stores,
  type UserQuery,
  type UserRecord,
  type UserStore,
  getDTag,
  getTag,
  isAddressable,
  isEphemeral,
  isReplaceable,
} from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createRelay } from "../src";
import { matchFilter } from "../src/util/filter";

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger };

const cmp = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** In-memory EventStore with NIP-01 replaceable semantics, NIP-09 tombstones and NIP-40 purge. */
export class FakeEventStore implements EventStore {
  events = new Map<string, NostrEvent>();
  deletedIds = new Set<string>();
  async init() {}
  private coordKey(e: NostrEvent) {
    if (isReplaceable(e.kind)) return `${e.kind}:${e.pubkey}`;
    if (isAddressable(e.kind)) return `${e.kind}:${e.pubkey}:${getDTag(e)}`;
    return undefined;
  }
  async save(e: NostrEvent): Promise<SaveResult> {
    if (isEphemeral(e.kind)) return { status: "saved" };
    if (this.events.has(e.id)) return { status: "duplicate" };
    if (this.deletedIds.has(e.id)) return { status: "deleted", message: "blocked: event was deleted" };
    const key = this.coordKey(e);
    let status: SaveResult["status"] = "saved";
    if (key) {
      for (const old of this.events.values()) {
        if (this.coordKey(old) !== key) continue;
        if (cmp(old, e) <= 0) return { status: "stale" };
        this.events.delete(old.id);
        status = "replaced";
      }
    }
    this.events.set(e.id, e);
    return { status };
  }
  async query(filters: Filter[], opts?: { maxLimit?: number }): Promise<NostrEvent[]> {
    const out = new Map<string, NostrEvent>();
    const all = [...this.events.values()].sort(cmp);
    for (const f of filters) {
      const lim = Math.min(f.limit ?? Infinity, opts?.maxLimit ?? Infinity);
      let n = 0;
      for (const e of all) {
        if (n >= lim) break;
        if (matchFilter(f, e)) {
          out.set(e.id, e);
          n++;
        }
      }
    }
    return [...out.values()].sort(cmp);
  }
  async count(filters: Filter[]) {
    return (await this.query(filters)).length;
  }
  async getById(id: string) {
    return this.events.get(id);
  }
  async queryIdsForSync(filter: Filter) {
    const { limit: _l, ...f } = filter;
    return (await this.query([f])).map((e) => ({ id: e.id, created_at: e.created_at })).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  }
  async applyDeletion(del: NostrEvent) {
    let n = 0;
    for (const t of del.tags) {
      if (t[0] === "e" && t[1]) {
        const e = this.events.get(t[1]);
        if (e && e.pubkey === del.pubkey) {
          this.events.delete(t[1]);
          n++;
        }
        if (!e || e.pubkey === del.pubkey) this.deletedIds.add(t[1]);
      }
    }
    return n;
  }
  async deleteByIds(ids: string[]) {
    let n = 0;
    for (const id of ids) if (this.events.delete(id)) n++;
    return n;
  }
  async deleteByFilter(filters: Filter[]) {
    let n = 0;
    for (const e of [...this.events.values()]) if (filters.some((f) => matchFilter(f, e)) && this.events.delete(e.id)) n++;
    return n;
  }
  async deleteByPubkey(pk: string) {
    return this.deleteByFilter([{ authors: [pk] }]);
  }
  async purgeExpired(now: number) {
    let n = 0;
    for (const e of [...this.events.values()]) {
      const exp = getTag(e, "expiration");
      if (exp && Number(exp) <= now && this.events.delete(e.id)) n++;
    }
    return n;
  }
  async stats() {
    return { total: this.events.size, byKind: [], sizeBytes: 0 };
  }
}

const defaultUser = (pubkey: string): UserRecord => ({
  pubkey, status: "active", allowed: false, denied: false, role: null, notes: "", tags: [], rateLimit: null,
  blossomQuota: null, nip05Name: null, invitedBy: null, banReason: null, firstSeenAt: 0, lastSeenAt: 0, eventCount: 0,
});

export class FakeUserStore implements UserStore {
  users = new Map<string, UserRecord>();
  async get(pk: string) {
    return this.users.get(pk);
  }
  async upsert(pk: string, patch: Partial<Omit<UserRecord, "pubkey">>) {
    const u = { ...(this.users.get(pk) ?? defaultUser(pk)), ...patch };
    this.users.set(pk, u);
    return u;
  }
  async list(q: UserQuery) {
    let items = [...this.users.values()];
    if (q.sort === "eventCount") items.sort((a, b) => b.eventCount - a.eventCount);
    const total = items.length;
    items = items.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50));
    return { items, total };
  }
  async touch(pk: string, at: number) {
    const u = this.users.get(pk) ?? defaultUser(pk);
    this.users.set(pk, { ...u, lastSeenAt: at, eventCount: u.eventCount + 1, firstSeenAt: u.firstSeenAt || at });
  }
  async getByNip05(name: string) {
    return [...this.users.values()].find((u) => u.nip05Name === name);
  }
  async delete(pk: string) {
    this.users.delete(pk);
  }
}

export class FakeInviteStore implements InviteStore {
  invites = new Map<string, Invite>();
  constructor(private users: FakeUserStore) {}
  async create(input: { createdBy: string; maxUses?: number; expiresAt?: number | null; note?: string }) {
    const inv: Invite = { code: Math.random().toString(36).slice(2), createdBy: input.createdBy, createdAt: 0, maxUses: input.maxUses ?? 1, uses: 0, expiresAt: input.expiresAt ?? null, note: input.note ?? "" };
    this.invites.set(inv.code, inv);
    return inv;
  }
  async list() {
    return [...this.invites.values()];
  }
  async redeem(code: string, pubkey: string) {
    const inv = this.invites.get(code);
    if (!inv || inv.uses >= inv.maxUses) return false;
    inv.uses++;
    await this.users.upsert(pubkey, { allowed: true, invitedBy: inv.createdBy });
    return true;
  }
  async revoke(code: string) {
    this.invites.delete(code);
  }
}

export class FakeIpRuleStore implements IpRuleStore {
  rules: IpRule[] = [];
  async list() {
    return this.rules;
  }
  async add(r: Omit<IpRule, "createdAt">) {
    this.rules.push({ ...r, createdAt: 0 });
  }
  async remove(cidr: string) {
    this.rules = this.rules.filter((r) => r.cidr !== cidr);
  }
}

export class FakeKv implements KvStore {
  data = new Map<string, unknown>();
  async get<T>(ns: string, key: string) {
    return this.data.get(`${ns}/${key}`) as T | undefined;
  }
  async set(ns: string, key: string, value: unknown) {
    this.data.set(`${ns}/${key}`, value);
  }
  async delete(ns: string, key: string) {
    this.data.delete(`${ns}/${key}`);
  }
  async list<T>(ns: string) {
    const out: Record<string, T> = {};
    for (const [k, v] of this.data) if (k.startsWith(`${ns}/`)) out[k.slice(ns.length + 1)] = v as T;
    return out;
  }
}

const fakeAudit: AuditLog = { async record() {}, async list() { return []; } };

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out as T;
}

export class FakeSettings implements SettingsService {
  private s: RuntimeSettings;
  private fns = new Set<(s: RuntimeSettings) => void>();
  constructor(initial: DeepPartial<RuntimeSettings> = {}) {
    this.s = RuntimeSettingsSchema.parse(initial);
  }
  get() {
    return this.s;
  }
  async update(patch: DeepPartial<RuntimeSettings>) {
    this.s = RuntimeSettingsSchema.parse(deepMerge(this.s, patch));
    for (const fn of this.fns) fn(this.s);
    return this.s;
  }
  onChange(fn: (s: RuntimeSettings) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
}

export async function createFakeStores() {
  const users = new FakeUserStore();
  return {
    db: await createMemoryDb(),
    events: new FakeEventStore(),
    users,
    invites: new FakeInviteStore(users),
    ipRules: new FakeIpRuleStore(),
    kv: new FakeKv(),
    audit: fakeAudit,
  } satisfies Stores;
}

// ------------------------------------------------------------------ sockets & keys

export class FakeSocket implements RelaySocket {
  sent: unknown[][] = [];
  closed: { code?: number; reason?: string } | null = null;
  buffered = 0;
  private waiters: { pred: (m: unknown[]) => boolean; resolve: (m: unknown[]) => void }[] = [];
  send(data: string) {
    const msg = JSON.parse(data) as unknown[];
    this.sent.push(msg);
    this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  bufferedAmount() {
    return this.buffered;
  }
  of(type: string) {
    return this.sent.filter((m) => m[0] === type);
  }
  clear() {
    this.sent = [];
  }
  /** Resolves with the first message at index >= from (already sent or future) matching pred. */
  waitFor(pred: (m: unknown[]) => boolean, timeoutMs = 2000, from = 0): Promise<unknown[]> {
    const hit = this.sent.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; got ${JSON.stringify(this.sent).slice(0, 2000)}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }
}

export interface Keypair {
  sk: Uint8Array;
  pk: string;
}
export const keypair = (): Keypair => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};

export const now = () => Math.floor(Date.now() / 1000);

export function sign(kp: Keypair, t: { kind?: number; content?: string; tags?: string[][]; created_at?: number } = {}): NostrEvent {
  return finalizeEvent({ kind: t.kind ?? 1, content: t.content ?? "hello", tags: t.tags ?? [], created_at: t.created_at ?? now() }, kp.sk);
}

export const PUBLIC_URL = "https://relay.example.com";

export async function setup(opts: { settings?: DeepPartial<RuntimeSettings>; config?: Record<string, unknown> } = {}) {
  const config: BeamhopConfig = ConfigSchema.parse({ server: { publicUrl: PUBLIC_URL }, ...(opts.config ?? {}) });
  const stores = await createFakeStores();
  const settings = new FakeSettings(opts.settings);
  const bus = new EventBus();
  const hooks = new HookRegistry();
  const deps: CoreDeps = { config, stores, settings, hooks, bus, logger: silentLogger };
  const relay = await createRelay(deps);

  /** Opens a client connection; returns helpers. */
  const connect = (ip = "1.2.3.4") => {
    const socket = new FakeSocket();
    const handle = relay.handleConnection(socket, { ip });
    const challenge = (socket.of("AUTH")[0]?.[1] as string) ?? "";
    const send = (msg: unknown[]) => handle.onMessage(JSON.stringify(msg));
    const publish = async (event: NostrEvent) => {
      const from = socket.sent.length;
      send(["EVENT", event]);
      return (await socket.waitFor((m) => m[0] === "OK" && m[1] === event.id, 2000, from)) as [string, string, boolean, string];
    };
    const auth = async (kp: Keypair, relayUrl = "wss://relay.example.com") => {
      const ev = sign(kp, { kind: 22242, content: "", tags: [["relay", relayUrl], ["challenge", challenge]] });
      send(["AUTH", ev]);
      return (await socket.waitFor((m) => m[0] === "OK" && m[1] === ev.id)) as [string, string, boolean, string];
    };
    /** REQ and wait for EOSE/CLOSED; returns stored events */
    const req = async (subId: string, ...filters: Filter[]) => {
      const start = socket.sent.length;
      send(["REQ", subId, ...filters]);
      const end = await socket.waitFor((m) => (m[0] === "EOSE" || m[0] === "CLOSED") && m[1] === subId, 2000, start);
      const msgs = socket.sent.slice(start);
      return {
        end,
        events: msgs.filter((m) => m[0] === "EVENT" && m[1] === subId).map((m) => m[2] as NostrEvent),
      };
    };
    return { socket, handle, challenge, send, publish, auth, req };
  };

  return { relay, stores, settings, bus, hooks, config, deps, connect };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Polls `cond` until it holds (or fails after `timeoutMs`), for effects that run after an OK. */
export async function eventually(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await tick(5);
  }
}
