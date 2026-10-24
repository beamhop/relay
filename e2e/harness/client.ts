/** Black-box clients for the e2e suites: a Nostr websocket client, NIP-98 admin API calls, Blossom auth. */
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools";

export type Msg = unknown[];
export const now = () => Math.floor(Date.now() / 1000);
export const sha256 = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");

export function newUser() {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

export function sign(sk: Uint8Array, t: Partial<EventTemplate> & { kind: number }): Event {
  return finalizeEvent({ created_at: now(), tags: [], content: "", ...t }, sk);
}

/** Minimal NIP-01 client that records every frame it receives. */
export class RelayClient {
  readonly inbox: Msg[] = [];
  closed = false;
  closeCode?: number;
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (m) => this.inbox.push(JSON.parse(String(m.data)));
    ws.onclose = (e) => {
      this.closed = true;
      this.closeCode = e.code;
    };
  }

  static async connect(url: string, opts: { headers?: Record<string, string> } = {}): Promise<RelayClient> {
    // Bun's WebSocket accepts headers; used to simulate an Origin / forwarded IP where needed
    const ws = new WebSocket(url, opts.headers ? ({ headers: opts.headers } as never) : undefined);
    const c = new RelayClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`websocket to ${url} failed`));
    });
    return c;
  }

  send(msg: unknown[]) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Waits for (and consumes) the first frame matching `pred`. */
  async waitFor(pred: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`timeout waiting for frame; inbox: ${JSON.stringify(this.inbox).slice(0, 2000)}`);
      await Bun.sleep(5);
    }
  }

  /** Asserts no frame matching `pred` arrives within `ms`. */
  async expectNone(pred: (m: Msg) => boolean, ms = 300) {
    await Bun.sleep(ms);
    const m = this.inbox.find(pred);
    if (m) throw new Error(`unexpected frame: ${JSON.stringify(m)}`);
  }

  async publish(ev: Event): Promise<{ ok: boolean; message: string }> {
    this.send(["EVENT", ev]);
    const m = await this.waitFor((f) => f[0] === "OK" && f[1] === ev.id);
    return { ok: m[2] as boolean, message: m[3] as string };
  }

  /** REQ → collects events until EOSE (or CLOSED). Leaves the subscription open unless `close`. */
  async query(subId: string, filters: Record<string, unknown>[], close = true): Promise<{ events: Event[]; closed?: string }> {
    this.send(["REQ", subId, ...filters]);
    const end = await this.waitFor((f) => (f[0] === "EOSE" || f[0] === "CLOSED") && f[1] === subId);
    const events: Event[] = [];
    for (let i = 0; i < this.inbox.length; ) {
      const f = this.inbox[i];
      if (f[0] === "EVENT" && f[1] === subId) {
        events.push(f[2] as Event);
        this.inbox.splice(i, 1);
      } else i++;
    }
    if (close && end[0] === "EOSE") this.send(["CLOSE", subId]);
    return { events, closed: end[0] === "CLOSED" ? (end[2] as string) : undefined };
  }

  /** NIP-42: answers the relay's AUTH challenge (waits for it if not yet received). */
  async auth(sk: Uint8Array, relayUrl: string): Promise<{ ok: boolean; message: string }> {
    const ch = await this.waitFor((f) => f[0] === "AUTH");
    const ev = sign(sk, { kind: 22242, tags: [["relay", relayUrl], ["challenge", ch[1] as string]] });
    this.send(["AUTH", ev]);
    const m = await this.waitFor((f) => f[0] === "OK" && f[1] === ev.id);
    return { ok: m[2] as boolean, message: m[3] as string };
  }

  close() {
    this.ws.close();
  }
}

/** `Authorization: Nostr …` for NIP-98 (admin API, NIP-86). */
export function nip98Header(sk: Uint8Array, url: string, method: string, body?: string | Uint8Array): string {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
    // the server refuses a replayed auth event: identical calls within one second would otherwise share an id
    ["nonce", crypto.randomUUID()],
  ];
  if (body !== undefined && body.length) tags.push(["payload", sha256(body)]);
  const ev = sign(sk, { kind: 27235, tags });
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Admin API call authenticated per request with NIP-98. `path` is relative to /admin/api. */
export async function adminApi<T = any>(base: string, sk: Uint8Array | null, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const url = `${base}/admin/api${path}`;
  const raw = body === undefined ? (method === "GET" || method === "DELETE" ? undefined : "{}") : JSON.stringify(body);
  const headers: Record<string, string> = { "X-Requested-With": "beamhop", Accept: "application/json" };
  if (raw !== undefined) headers["Content-Type"] = "application/json";
  if (sk) headers.Authorization = nip98Header(sk, url, method, raw);
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

/** BUD-01/02 authorization event (kind 24242). */
export function blossomAuth(sk: Uint8Array, verb: "upload" | "get" | "delete" | "list" | "media", opts: { hash?: string; server?: string; expiresIn?: number } = {}): string {
  const tags = [
    ["t", verb],
    ["expiration", String(now() + (opts.expiresIn ?? 600))],
  ];
  if (opts.hash) tags.push(["x", opts.hash]);
  if (opts.server) tags.push(["server", opts.server]);
  const ev = sign(sk, { kind: 24242, tags, content: `${verb} blob` });
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

/** A tiny valid PNG (1x1), varied by `seed` so each call has a distinct hash. */
export function pngBytes(seed = 0): Uint8Array<ArrayBuffer> {
  const base = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  // append bytes after IEND: still decodes as the same image, but hashes differently
  return new Uint8Array(Buffer.concat([base, Buffer.from(`seed:${seed}:${Math.random()}`)]));
}
