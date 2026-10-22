import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb } from "@beamhop/storage";
import {
  ConfigSchema,
  EventBus,
  HookRegistry,
  RuntimeSettingsSchema,
  createLogger,
  type AuditEntry,
  type AuditLog,
  type BeamhopConfig,
  type CoreDeps,
  type DeepPartial,
  type KvStore,
  type RuntimeSettings,
  type SettingsService,
  type Stores,
  type UserRecord,
  type UserStore,
} from "@beamhop/sdk";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createBlossomService, type BlossomOptions, type BlossomServiceImpl } from "../src";

export function createFakeUsers(): UserStore {
  const users = new Map<string, UserRecord>();
  const defaults = (pubkey: string): UserRecord => ({
    pubkey, status: "active", allowed: false, denied: false, role: null, notes: "", tags: [], rateLimit: null,
    blossomQuota: null, nip05Name: null, invitedBy: null, banReason: null, firstSeenAt: 0, lastSeenAt: 0, eventCount: 0,
  });
  return {
    async get(pubkey) { return users.get(pubkey); },
    async upsert(pubkey, patch) {
      const u = { ...(users.get(pubkey) ?? defaults(pubkey)), ...patch, pubkey };
      users.set(pubkey, u);
      return u;
    },
    async list() { return { items: [...users.values()], total: users.size }; },
    async touch() {},
    async getByNip05(name) { return [...users.values()].find((u) => u.nip05Name === name); },
    async delete(pubkey) { users.delete(pubkey); },
  };
}

function createFakeKv(): KvStore {
  const m = new Map<string, unknown>();
  return {
    async get<T>(ns: string, k: string) { return m.get(`${ns}:${k}`) as T | undefined; },
    async set(ns, k, v) { m.set(`${ns}:${k}`, v); },
    async delete(ns, k) { m.delete(`${ns}:${k}`); },
    async list<T>(ns: string) {
      const out: Record<string, T> = {};
      for (const [k, v] of m) if (k.startsWith(`${ns}:`)) out[k.slice(ns.length + 1)] = v as T;
      return out;
    },
  };
}

export function createFakeAudit(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async record(e) { entries.push({ ...e, id: entries.length + 1, at: e.at ?? Math.floor(Date.now() / 1000) }); },
    async list() { return entries; },
  };
}

const notImplemented = new Proxy({}, { get: () => () => { throw new Error("not implemented in fake"); } });

export async function createFakeStores(): Promise<Stores & { audit: ReturnType<typeof createFakeAudit> }> {
  return {
    db: await createMemoryDb(),
    users: createFakeUsers(),
    kv: createFakeKv(),
    audit: createFakeAudit(),
    events: notImplemented as Stores["events"],
    invites: notImplemented as Stores["invites"],
    ipRules: notImplemented as Stores["ipRules"],
  };
}

export function createFakeSettings(): SettingsService {
  let current: RuntimeSettings = RuntimeSettingsSchema.parse({});
  const listeners = new Set<(s: RuntimeSettings) => void>();
  return {
    get: () => current,
    async update(patch: DeepPartial<RuntimeSettings>) {
      const merged: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(patch)) merged[k] = { ...(current as Record<string, object>)[k], ...(v as object) };
      current = RuntimeSettingsSchema.parse(merged);
      for (const l of listeners) l(current);
      return current;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export interface Harness {
  svc: BlossomServiceImpl;
  deps: CoreDeps & { stores: Awaited<ReturnType<typeof createFakeStores>> };
  dir: string;
  bus: EventBus;
  request(path: string, init?: RequestInit): Promise<Response>;
  cleanup(): Promise<void>;
}

export async function createHarness(opts: BlossomOptions & { config?: Partial<BeamhopConfig> } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "beamhop-blossom-"));
  const config = ConfigSchema.parse({
    server: { publicUrl: "https://cdn.example.com" },
    blossom: { fsPath: join(dir, "blobs") },
    ...opts.config,
  });
  const stores = await createFakeStores();
  const bus = new EventBus();
  const deps = {
    config,
    stores,
    settings: createFakeSettings(),
    hooks: new HookRegistry(),
    bus,
    logger: createLogger("error"),
  };
  const svc = await createBlossomService(deps, opts);
  return {
    svc,
    deps,
    dir,
    bus,
    request: async (path, init) => svc.app.fetch(new Request(`https://cdn.example.com${path}`, init)),
    async cleanup() {
      await stores.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function newUser() {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

export function authHeader(
  sk: Uint8Array,
  verb: string,
  opts: { x?: string[]; server?: string[]; expiration?: number; createdAt?: number; kind?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const tags = [["t", verb], ["expiration", String(opts.expiration ?? now + 600)]];
  for (const x of opts.x ?? []) tags.push(["x", x]);
  for (const s of opts.server ?? []) tags.push(["server", s]);
  const ev = finalizeEvent({ kind: opts.kind ?? 24242, created_at: opts.createdAt ?? now - 1, tags, content: `${verb} blob` }, sk);
  const b64 = Buffer.from(JSON.stringify(ev)).toString("base64url");
  return `Nostr ${b64}`;
}

export const sha256 = async (data: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", data as BufferSource)).toString("hex");

/** Minimal PNG (1x1) — sniffable by file-type. */
export const PNG_1x1 = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
);

/** Hand-built JPEG: SOI, APP0 JFIF, APP1 Exif (with fake GPS text), COM, DQT stub, SOS, scan data, EOI. */
export function jpegWithExif(): { withExif: Uint8Array; withoutExif: Uint8Array } {
  const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
  const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
  const soi = [0xff, 0xd8];
  const app0 = seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const app1 = seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("MM"), 0, 42, 0, 0, 0, 8, ...ascii("GPS 52.5200N 13.4050E")]);
  const com = seg(0xfe, ascii("secret comment"));
  const dqt = seg(0xdb, [0, ...new Array(64).fill(1)]);
  const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
  const scan = [0x12, 0x34, 0xff, 0x00, 0x56];
  const eoi = [0xff, 0xd9];
  return {
    withExif: Uint8Array.from([...soi, ...app0, ...app1, ...com, ...dqt, ...sos, ...scan, ...eoi]),
    withoutExif: Uint8Array.from([...soi, ...app0, ...dqt, ...sos, ...scan, ...eoi]),
  };
}
