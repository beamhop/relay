/**
 * Shared helpers for the policy-*.test.ts black-box suites. Only talks to the relay over ws/http.
 * (Not a test file itself: no `.test.` in the name.)
 */
import { randomBytes } from "node:crypto";
import { finalizeEvent, type Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { RelayClient, now, sha256, sign, type ApiResult, type Msg } from "../harness/client";

/** A fresh unique private-range IPv4 address per call (used with server.trustProxy + X-Forwarded-For). */
let ipSeq = 0;
const ipBase = 1 + Math.floor(Math.random() * 200);
export function uniqueIp(prefix = "10"): string {
  ipSeq++;
  return `${prefix}.${ipBase}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

/** Connects with an `X-Forwarded-For` (only believed when the relay runs with server.trustProxy). */
export function connectAs(relay: Relay, ip?: string): Promise<RelayClient> {
  return RelayClient.connect(relay.ws, ip ? { headers: { "X-Forwarded-For": ip } } : {});
}

/** Connects (optionally from `ip`) and completes NIP-42 AUTH as `sk`. */
export async function connectAuthed(relay: Relay, sk: Uint8Array, ip?: string): Promise<RelayClient> {
  const c = await connectAs(relay, ip);
  const r = await c.auth(sk, relay.ws);
  if (!r.ok) throw new Error(`AUTH failed: ${r.message}`);
  return c;
}

/** The AUTH challenge the relay sent (left in the inbox). */
export async function challengeOf(c: RelayClient): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const f = c.inbox.find((m) => m[0] === "AUTH");
    if (f) return f[1] as string;
    if (Date.now() > deadline) throw new Error("no AUTH challenge received");
    await Bun.sleep(5);
  }
}

/** Sends a raw AUTH event and waits for its OK. */
export async function sendAuth(c: RelayClient, ev: Event): Promise<{ ok: boolean; message: string }> {
  c.send(["AUTH", ev]);
  const m = await c.waitFor((f) => f[0] === "OK" && f[1] === ev.id);
  return { ok: m[2] as boolean, message: m[3] as string };
}

/** Waits until the socket is closed by the server. */
export async function waitClosed(c: RelayClient, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!c.closed) {
    if (Date.now() > deadline) throw new Error("connection was not closed");
    await Bun.sleep(5);
  }
}

/** Opens a websocket and resolves with what happened in the first moments: closed (code + notices) or still open. */
export async function tryConnect(relay: Relay, ip?: string, settleMs = 300): Promise<{ client: RelayClient; closed: boolean; notices: string[] }> {
  const c = await connectAs(relay, ip);
  const deadline = Date.now() + settleMs;
  while (!c.closed && Date.now() < deadline) await Bun.sleep(5);
  const notices = c.inbox.filter((m) => m[0] === "NOTICE").map((m) => m[1] as string);
  return { client: c, closed: c.closed, notices };
}

export const isEose = (sub: string) => (m: Msg) => (m[0] === "EOSE" || m[0] === "CLOSED") && m[1] === sub;

/** REQ by ids (fresh sub id each time). */
let subSeq = 0;
export async function fetchIds(c: RelayClient, ids: string[]): Promise<string[]> {
  const { events, closed } = await c.query(`ids-${++subSeq}`, [{ ids }]);
  if (closed) throw new Error(`REQ closed: ${closed}`);
  return events.map((e) => e.id);
}
export const nextSub = (p = "s") => `${p}-${++subSeq}-${Math.random().toString(36).slice(2, 6)}`;

/** `Authorization: Nostr …` with a random nonce tag so identical requests within a second don't collide as replays. */
export function nip98(sk: Uint8Array, url: string, method: string, body?: string, extra: { tags?: string[][]; created_at?: number; noPayload?: boolean; payload?: string } = {}): string {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
    ["nonce", randomBytes(8).toString("hex")],
  ];
  if (extra.payload !== undefined) tags.push(["payload", extra.payload]);
  else if (!extra.noPayload && body !== undefined && body.length) tags.push(["payload", sha256(body)]);
  tags.push(...(extra.tags ?? []));
  const ev = finalizeEvent({ kind: 27235, created_at: extra.created_at ?? now(), tags, content: "" }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

/** Admin REST API call with NIP-98 (path relative to /admin/api). */
export async function api<T = any>(relay: Relay, sk: Uint8Array | null, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const url = `${relay.http}/admin/api${path}`;
  const raw = body === undefined ? (method === "GET" || method === "DELETE" ? undefined : "{}") : JSON.stringify(body);
  const headers: Record<string, string> = { "X-Requested-With": "beamhop", Accept: "application/json" };
  if (raw !== undefined) headers["Content-Type"] = "application/json";
  if (sk) headers.Authorization = nip98(sk, url, method, raw);
  const res = await fetch(url, { method, headers, body: raw });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** Owner-authenticated admin call that must succeed. */
export async function ownerApi<T = any>(relay: Relay, method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(relay, relay.owner.sk, method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function getSettings(relay: Relay): Promise<any> {
  return (await ownerApi(relay, "GET", "/settings")).settings;
}

export async function patchSettings(relay: Relay, patch: Record<string, unknown>): Promise<any> {
  return (await ownerApi(relay, "PATCH", "/settings", patch)).settings;
}

/** Applies a settings patch for the duration of `fn`, then restores the full previous settings. */
export async function withSettings<T>(relay: Relay, patch: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const before = await getSettings(relay);
  await patchSettings(relay, patch);
  try {
    return await fn();
  } finally {
    await patchSettings(relay, before);
  }
}

export interface Nip86Opts {
  /** override the signer (default: owner) */
  sk?: Uint8Array | null;
  /** tamper with the NIP-98 event */
  auth?: { url?: string; method?: string; created_at?: number; noPayload?: boolean; payload?: string };
  rawBody?: string;
  contentType?: string;
}

/** NIP-86 JSON-RPC call (POST / with application/nostr+json+rpc, NIP-98 with payload). */
export async function nip86(relay: Relay, method: string, params: unknown[] = [], o: Nip86Opts = {}): Promise<{ status: number; result: any; error?: string; headers: Headers }> {
  const body = o.rawBody ?? JSON.stringify({ method, params });
  const headers: Record<string, string> = { "Content-Type": o.contentType ?? "application/nostr+json+rpc" };
  const sk = o.sk === undefined ? relay.owner.sk : o.sk;
  if (sk) headers.Authorization = nip98(sk, o.auth?.url ?? relay.http, o.auth?.method ?? "POST", body, o.auth ?? {});
  const res = await fetch(`${relay.http}/`, { method: "POST", headers, body });
  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = { result: null, error: text };
  }
  return { status: res.status, result: j.result, error: j.error ?? undefined, headers: res.headers };
}

/** Owner NIP-86 call that must succeed (HTTP 200, no error). */
export async function nip86ok(relay: Relay, method: string, params: unknown[] = []): Promise<any> {
  const r = await nip86(relay, method, params);
  if (r.status !== 200 || r.error) throw new Error(`nip86 ${method} → ${r.status} ${r.error}`);
  return r.result;
}

/** GET NIP-11 document. */
export async function nip11(relay: Relay): Promise<any> {
  const r = await fetch(`${relay.http}/`, { headers: { Accept: "application/nostr+json" } });
  return r.json();
}

/** Signs a note with a unique content marker. */
export function note(sk: Uint8Array, content = `note ${Math.random()}`, extra: { kind?: number; tags?: string[][]; created_at?: number } = {}): Event {
  return sign(sk, { kind: extra.kind ?? 1, content, tags: extra.tags ?? [], ...(extra.created_at !== undefined ? { created_at: extra.created_at } : {}) });
}

/** Gives `pubkey` an admin-panel role (owner-only). */
export async function setRole(relay: Relay, pubkey: string, role: "owner" | "admin" | "moderator" | "viewer" | null): Promise<void> {
  await ownerApi(relay, "PUT", `/users/${pubkey}/role`, { role });
}
