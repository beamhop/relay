/**
 * Shared helpers for the blossom-* and admin-* e2e suites. Black-box only: everything goes over http/ws; the boot
 * code below mirrors e2e/harness/relay.ts but keeps the data dir so a relay can be restarted on it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { createBeamhop } from "../../packages/server/src/app";
import { loadConfig } from "../../packages/server/src/config";
import { serve } from "../../packages/server/src/server";
import { freePort } from "../harness/relay";
import { now, sha256, type ApiResult } from "../harness/client";

const nonce = () => randomBytes(8).toString("hex");

/** NIP-98 header with a nonce tag, so two identical requests in the same second don't share an event id (replay). */
export function nip98(sk: Uint8Array, url: string, method: string, body?: string | Uint8Array, extra: string[][] = []): string {
  const tags = [["u", url], ["method", method.toUpperCase()], ["nonce", nonce()], ...extra];
  if (body !== undefined && body.length) tags.push(["payload", sha256(body)]);
  const ev = finalizeEvent({ kind: 27235, created_at: now(), tags, content: "" }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

/** Admin API call (NIP-98 per request). `path` is relative to /admin/api. */
export async function api<T = any>(
  base: string,
  sk: Uint8Array | null,
  method: string,
  path: string,
  body?: unknown,
  opts: { headers?: Record<string, string>; raw?: string; contentType?: string } = {},
): Promise<ApiResult<T>> {
  const url = `${base}/admin/api${path}`;
  const raw = opts.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (raw !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";
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

/** Kind 24242 Blossom token with a random content nonce (distinct ids even within one second). */
export function bauth(
  sk: Uint8Array,
  verb: string,
  opts: { hashes?: string[]; server?: string; expiresIn?: number; createdAt?: number; noExpiration?: boolean; kind?: number } = {},
): string {
  const tags: string[][] = [["t", verb]];
  if (!opts.noExpiration) tags.push(["expiration", String((opts.createdAt ?? now()) + (opts.expiresIn ?? 600))]);
  for (const h of opts.hashes ?? []) tags.push(["x", h]);
  if (opts.server) tags.push(["server", opts.server]);
  const ev = finalizeEvent({ kind: opts.kind ?? 24242, created_at: opts.createdAt ?? now(), tags, content: `${verb} ${nonce()}` }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

export function user() {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

/** Distinct bytes of a recognisable type. */
export function pdfBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n%${nonce()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`));
}
export function textBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(`hello ${nonce()} plain text\n`));
}

export interface Uploaded {
  status: number;
  body: any;
  headers: Headers;
  sha: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** PUT /upload with a token naming the blob. */
export async function upload(
  base: string,
  sk: Uint8Array | null,
  bytes: Uint8Array<ArrayBuffer>,
  opts: { type?: string; auth?: string; headers?: Record<string, string> } = {},
): Promise<Uploaded> {
  const sha = sha256(bytes);
  const headers: Record<string, string> = { "Content-Type": opts.type ?? "image/png", ...opts.headers };
  const auth = opts.auth ?? (sk ? bauth(sk, "upload", { hashes: [sha] }) : undefined);
  if (auth) headers.Authorization = auth;
  const res = await fetch(`${base}/upload`, { method: "PUT", headers, body: bytes });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, headers: res.headers, sha, bytes };
}

export async function waitUntil<T>(fn: () => Promise<T | undefined | null | false>, ms = 6000, step = 50): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`waitUntil timed out${last ? `: ${String(last)}` : ""}`);
    await Bun.sleep(step);
  }
}

export function signEvent(sk: Uint8Array, t: { kind: number; content?: string; tags?: string[][]; created_at?: number }): Event {
  return finalizeEvent({ created_at: now(), tags: [], content: "", ...t }, sk);
}

// ------------------------------------------------------------------ restartable relay

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
        ? merge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

export interface Booted {
  http: string;
  ws: string;
  dir: string;
  owner: { sk: Uint8Array; pubkey: string };
  /** stops the server, keeps the data dir */
  stop(): Promise<void>;
}

/** Boots beamhop on `dir` (created if omitted) with the given owner; `stop()` leaves the dir for a restart. */
export async function bootRelay(opts: { dir?: string; ownerSk?: Uint8Array; overrides?: Record<string, unknown> } = {}): Promise<Booted> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "beamhop-e2e-restart-"));
  const port = await freePort();
  const sk = opts.ownerSk ?? generateSecretKey();
  const pubkey = getPublicKey(sk);
  const http = `http://127.0.0.1:${port}`;
  const base = {
    logLevel: "error",
    server: { host: "127.0.0.1", port, publicUrl: http },
    database: { driver: "sqlite", sqlitePath: join(dir, "e2e.db") },
    blossom: { fsPath: join(dir, "blobs") },
    admin: { owners: [pubkey] },
    plugins: { dir: join(dir, "plugins") },
  };
  const { config } = loadConfig({ cwd: dir, env: {}, overrides: merge(base, opts.overrides ?? {}) as never });
  const beamhop = await createBeamhop(config, { autoDiscoverNpm: false });
  await beamhop.start();
  const server = await serve(beamhop, { runtime: "bun", port, host: "127.0.0.1" });
  let stopped = false;
  return {
    http,
    ws: `ws://127.0.0.1:${port}`,
    dir,
    owner: { sk, pubkey },
    async stop() {
      if (stopped) return;
      stopped = true;
      server.stopAccepting();
      await beamhop.stop();
      await server.stop();
    },
  };
}

export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });
export { bytesToHex };

/** Minimal SSE reader over fetch: collects `{event, data}` frames. */
export class SseClient {
  readonly frames: { event: string; data: any }[] = [];
  private ctrl = new AbortController();
  status = 0;
  ended = false;
  done: Promise<void> = Promise.resolve();
  static async open(url: string, headers: Record<string, string>): Promise<SseClient> {
    const c = new SseClient();
    const res = await fetch(url, { headers: { Accept: "text/event-stream", ...headers }, signal: c.ctrl.signal });
    c.status = res.status;
    if (!res.ok || !res.body) return c;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    c.done = (async () => {
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            if (!data.length) continue;
            let parsed: unknown = data.join("\n");
            try {
              parsed = JSON.parse(parsed as string);
            } catch {
              /* raw */
            }
            c.frames.push({ event, data: parsed });
          }
        }
      } catch {
        /* aborted */
      }
      c.ended = true;
    })();
    return c;
  }
  async waitFor(pred: (f: { event: string; data: any }) => boolean, ms = 5000) {
    return waitUntil(async () => this.frames.find(pred), ms, 20);
  }
  close() {
    this.ctrl.abort();
  }
}
