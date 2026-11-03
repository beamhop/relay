/**
 * Runtime adapters. The rest of the suite only ever runs the Bun adapter; this file runs one representative
 * protocol / Blossom / admin smoke set against
 *  1. the Bun adapter (control: proves the smoke itself),
 *  2. the node:http + `ws` adapter in-process (serve({ runtime: "node" }) under Bun),
 *  3. the real thing: the CLI bundled for Node (same Bun.build recipe as scripts/build-node.ts) running under `node`,
 *     including permessage-deflate negotiation and SIGTERM graceful shutdown.
 * (3) is skipped when no `node` >= 22 is on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools";
import { RelayClient, now, sha256, sign } from "../harness/client";
import { backendEnv, releaseBackend } from "../harness/backend";
import { freePort } from "../harness/relay";
import { api, bauth, upload, user } from "./admin-helpers";
import { nip86 } from "./policy-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

interface Target {
  http: string;
  ws: string;
  port: number;
  owner: { sk: Uint8Array; pubkey: string };
}

/** Raw HTTP/1.1 websocket handshake; resolves with the response head (status line + headers). */
export function rawUpgrade(port: number, path = "/", extraHeaders: Record<string, string> = {}): Promise<string> {
  return new Promise((resolveHead, reject) => {
    const s = connect(port, "127.0.0.1", () => {
      const extra = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
      );
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      const i = buf.indexOf("\r\n\r\n");
      if (i >= 0) {
        s.destroy();
        resolveHead(buf.slice(0, i));
      }
    });
    s.on("error", reject);
    s.on("close", () => resolveHead(buf));
  });
}

async function waitClosed(c: RelayClient, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!c.closed) {
    if (Date.now() > deadline) throw new Error("socket not closed");
    await Bun.sleep(5);
  }
}

/** The smoke set every runtime must pass. */
function smoke(get: () => Target, opts: { bunWsShim?: boolean } = {}) {
  test("NIP-11 document with CORS; landing page on plain GET /; /health", async () => {
    const t = get();
    const res = await fetch(`${t.http}/`, { headers: { Accept: "application/nostr+json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/nostr+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json()).supported_nips).toContain(1);
    const html = await fetch(`${t.http}/`, { headers: { Accept: "text/html" } });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain(`ws://127.0.0.1:${t.port}/`);
    const h = await fetch(`${t.http}/health`);
    expect(h.status).toBe(200);
    expect((await h.json()).ok).toBe(true);
  });

  test("ws: AUTH challenge first, publish → OK, stored query, live delivery to another client, COUNT, CLOSE", async () => {
    const t = get();
    const a = await RelayClient.connect(t.ws);
    const b = await RelayClient.connect(t.ws);
    try {
      expect((await a.waitFor((m) => m[0] === "AUTH"))[1]).toMatch(/^[0-9a-f]{32}$/);
      const u = user();
      const tag = `rt-${sha256(String(Math.random())).slice(0, 12)}`;
      b.send(["REQ", "live", { "#t": [tag] }]);
      await b.waitFor((m) => m[0] === "EOSE" && m[1] === "live");
      const ev = sign(u.sk, { kind: 1, content: "runtime smoke", tags: [["t", tag]] });
      expect(await a.publish(ev)).toEqual({ ok: true, message: "" });
      const got = await b.waitFor((m) => m[0] === "EVENT" && m[1] === "live");
      expect((got[2] as { id: string }).id).toBe(ev.id);
      const { events } = await a.query("stored", [{ ids: [ev.id] }]);
      expect(events.map((e) => e.id)).toEqual([ev.id]);
      a.send(["COUNT", "cnt", { "#t": [tag] }]);
      const cnt = await a.waitFor((m) => m[0] === "COUNT" && m[1] === "cnt");
      expect((cnt[2] as { count: number }).count).toBe(1);
      b.send(["CLOSE", "live"]);
      await Bun.sleep(50);
      await a.publish(sign(u.sk, { kind: 1, content: "after close", tags: [["t", tag]] }));
      await b.expectNone((m) => m[0] === "EVENT" && m[1] === "live", 200);
    } finally {
      a.close();
      b.close();
    }
  });

  test("ws: NIP-42 AUTH succeeds for the relay URL", async () => {
    const t = get();
    const c = await RelayClient.connect(t.ws);
    try {
      expect(await c.auth(user().sk, t.ws)).toEqual({ ok: true, message: "" });
    } finally {
      c.close();
    }
  });

  test("ws: a frame over maxMessageBytes gets OK false; one far over the transport cap closes only that socket", async () => {
    const t = get();
    const c = await RelayClient.connect(t.ws);
    const ev = sign(user().sk, { kind: 1, content: "x".repeat(140_000) }); // > 131072 default, < 2x transport cap
    c.send(["EVENT", ev]);
    const ok = await c.waitFor((m) => m[0] === "OK" && m[1] === ev.id);
    expect(ok[2]).toBe(false);
    expect(ok[3]).toBe("invalid: message too large (max 131072 bytes)");
    const huge = await RelayClient.connect(t.ws);
    const big = sign(user().sk, { kind: 1, content: "y".repeat(400_000) });
    huge.send(["EVENT", big]);
    // Bun's built-in `ws` shim (in-process node adapter) ignores maxPayload: the relay's own check answers instead
    if (opts.bunWsShim) expect((await huge.waitFor((m) => m[0] === "OK" && m[1] === big.id))[2]).toBe(false);
    else await waitClosed(huge);
    huge.close();
    // the relay and the other socket are unaffected
    const e2 = sign(user().sk, { kind: 1, content: "still fine" });
    expect((await c.publish(e2)).ok).toBe(true);
    c.close();
  });

  test("websocket upgrade on a path other than / is refused (404), with or without query string on /", async () => {
    const t = get();
    expect(await rawUpgrade(t.port, "/not-the-relay")).toStartWith("HTTP/1.1 404");
    expect(await rawUpgrade(t.port, "/?x=1")).toStartWith("HTTP/1.1 101");
  });

  test("blossom: upload as owner, GET byte-exact, HEAD size, Range 206, list", async () => {
    const t = get();
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n%${Math.random()}\n` + "z".repeat(5000) + "\n%%EOF\n"));
    const up = await upload(t.http, t.owner.sk, bytes, { type: "application/pdf" });
    expect(up.status).toBe(201);
    expect(up.body.sha256).toBe(up.sha);
    const get1 = await fetch(`${t.http}/${up.sha}`);
    expect(get1.status).toBe(200);
    expect(sha256(new Uint8Array(await get1.arrayBuffer()))).toBe(up.sha);
    const head = await fetch(`${t.http}/${up.sha}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
    const range = await fetch(`${t.http}/${up.sha}`, { headers: { Range: "bytes=0-7" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 0-7/${bytes.byteLength}`);
    expect(Buffer.from(await range.arrayBuffer()).toString()).toBe("%PDF-1.4");
    const list = await fetch(`${t.http}/list/${t.owner.pubkey}`, { headers: { Authorization: bauth(t.owner.sk, "list") } });
    expect(list.status).toBe(200);
    expect((await list.json()).map((d: { sha256: string }) => d.sha256)).toContain(up.sha);
  });

  test("admin API with NIP-98 (owner 200, anonymous 401) and NIP-86 supportedmethods", async () => {
    const t = get();
    expect((await api(t.http, t.owner.sk, "GET", "/auth/me")).status).toBe(200);
    expect((await api(t.http, null, "GET", "/auth/me")).status).toBe(401);
    const r = await nip86({ http: t.http, owner: t.owner } as never, "supportedmethods");
    expect(r.status).toBe(200);
    expect(r.result).toContain("banpubkey");
  });
}

// ------------------------------------------------------------------ 1 + 2: in-process adapters

// @hono/node-server (node adapter) replaces globalThis.Request/Response with its lightweight classes. Harmless in a
// real Node process, but under `bun test` every later file in the same process would get them: restore afterwards.
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
function restoreGlobals() {
  Object.defineProperty(globalThis, "Request", { value: NativeRequest, writable: true, configurable: true });
  Object.defineProperty(globalThis, "Response", { value: NativeResponse, writable: true, configurable: true });
}

for (const runtime of ["bun", "node"] as const) {
  describe(`in-process ${runtime} adapter`, () => {
    let relay: GapRelay;
    beforeAll(async () => {
      relay = await bootGap({ runtime });
    });
    afterAll(async () => {
      await relay?.stop();
      if (runtime === "node") restoreGlobals();
    });
    smoke(() => relay, { bunWsShim: runtime === "node" });

    // the in-process node adapter runs on Bun's built-in `ws` shim, which does not negotiate extensions; the real
    // `ws` package is covered under "CLI under real Node" below
    test.skipIf(runtime === "node")("permessage-deflate is negotiated and a large compressible event round-trips", async () => {
      const head = await rawUpgrade(relay.port, "/", { "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" });
      expect(head.toLowerCase()).toContain("sec-websocket-extensions: permessage-deflate");
      const c = await RelayClient.connect(relay.ws);
      try {
        expect(c.ws.extensions).toContain("permessage-deflate");
        const ev = sign(user().sk, { kind: 1, content: "compress me ".repeat(4000) });
        expect((await c.publish(ev)).ok).toBe(true);
        expect((await c.query("big", [{ ids: [ev.id] }])).events[0]?.content).toBe(ev.content);
      } finally {
        c.close();
      }
    });

    test("graceful stop: open sockets get NOTICE then close 1001; new connections are refused afterwards", async () => {
      const r = await bootGap({ runtime });
      const c = await RelayClient.connect(r.ws);
      c.send(["REQ", "open", { kinds: [1] }]);
      await c.waitFor((m) => m[0] === "EOSE");
      await r.stop();
      await waitClosed(c);
      expect(c.closeCode).toBe(1001);
      expect(c.inbox).toContainEqual(["NOTICE", "error: relay is shutting down"]);
      await expect(RelayClient.connect(r.ws)).rejects.toThrow();
    });
  });
}

// ------------------------------------------------------------------ 3: the CLI bundled for real Node

function nodeMajor(): number {
  try {
    const p = Bun.spawnSync(["node", "--version"]);
    return Number(/^v(\d+)/.exec(p.stdout.toString())?.[1] ?? 0);
  } catch {
    return 0;
  }
}
const HAS_NODE = nodeMajor() >= 22;
const SERVER = resolve(import.meta.dir, "../../packages/server");

/** Bundles src/cli.ts for node the way scripts/build-node.ts does, into `out`, without touching the repo. */
async function buildNodeCli(out: string): Promise<string> {
  const x509 = Bun.resolveSync("@peculiar/x509", Bun.resolveSync("@simplewebauthn/server", resolve(SERVER, "../admin-api")));
  const preload = [Bun.resolveSync("reflect-metadata", x509)];
  const src = join(out, "src");
  mkdirSync(src, { recursive: true });
  const entry = join(src, "entry.ts");
  writeFileSync(entry, [...preload, join(SERVER, "src/cli.ts")].map((f) => `import ${JSON.stringify(f)};`).join("\n") + "\n");
  const dist = join(out, "dist");
  const r = await Bun.build({
    entrypoints: [entry],
    outdir: dist,
    target: "node",
    format: "esm",
    external: ["better-sqlite3", "sharp", "postgres", "bufferutil", "utf-8-validate", "bun:sqlite", "bun"],
    minify: { syntax: true, whitespace: false, identifiers: false },
    naming: "cli.js",
  });
  if (!r.success) throw new Error(`node build failed: ${r.logs.join("\n")}`);
  // externals live with the workspace packages that use them (bun's isolated linker): link each one in
  const modules = join(dist, "node_modules");
  mkdirSync(modules);
  for (const name of ["better-sqlite3", "postgres", "sharp"]) {
    for (const from of ["server", "storage", "blossom"]) {
      try {
        const pkg = dirname(Bun.resolveSync(`${name}/package.json`, resolve(SERVER, "..", from)));
        symlinkSync(realpathSync(pkg), join(modules, name), "dir");
        break;
      } catch {}
    }
  }
  return join(dist, "cli.js");
}

describe.skipIf(!HAS_NODE)("CLI under real Node", () => {
  let root: string;
  let cli: string;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let target: Target;
  let dir: string | undefined;
  let output = "";

  async function startNode(): Promise<{ proc: ReturnType<typeof Bun.spawn>; target: Target; dir: string }> {
    const dir = mkdtempSync(join(root, "data-"));
    const port = await freePort();
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const http = `http://127.0.0.1:${port}`;
    const p = Bun.spawn(["node", cli, "start"], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        BEAMHOP_HOST: "127.0.0.1",
        BEAMHOP_PORT: String(port),
        BEAMHOP_PUBLIC_URL: http,
        BEAMHOP_SQLITE_PATH: join(dir, "e2e.db"),
        BEAMHOP_BLOSSOM_FS_PATH: join(dir, "blobs"),
        BEAMHOP_PLUGINS_DIR: join(dir, "plugins"),
        BEAMHOP_OWNERS: pubkey,
        BEAMHOP_LOG_LEVEL: "warn",
        ...(await backendEnv(dir)),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const s of [p.stdout, p.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        const dec = new TextDecoder();
        for await (const chunk of s) output += dec.decode(chunk);
      })();
    }
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (p.exitCode !== null) throw new Error(`node exited early (${p.exitCode}): ${output}`);
      try {
        if ((await fetch(`${http}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`node server did not come up: ${output}`);
      await Bun.sleep(50);
    }
    return { proc: p, target: { http, ws: `ws://127.0.0.1:${port}`, port, owner: { sk, pubkey } }, dir };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "beamhop-e2e-node-"));
    cli = await buildNodeCli(root);
    ({ proc, target, dir } = await startNode());
  }, 60_000);
  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    if (dir) await releaseBackend(dir);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  smoke(() => target);

  test("permessage-deflate is negotiated and a large compressible event round-trips", async () => {
    const head = await rawUpgrade(target.port, "/", { "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" });
    expect(head).toStartWith("HTTP/1.1 101");
    expect(head.toLowerCase()).toContain("sec-websocket-extensions: permessage-deflate");
    const c = await RelayClient.connect(target.ws);
    try {
      expect(c.ws.extensions).toContain("permessage-deflate");
      const ev = sign(user().sk, { kind: 1, content: "compress me ".repeat(4000) });
      expect((await c.publish(ev)).ok).toBe(true);
      const { events } = await c.query("big", [{ ids: [ev.id] }]);
      expect(events[0]?.content).toBe(ev.content);
    } finally {
      c.close();
    }
  });

  test("better-sqlite3 path: content starting with U+FEFF comes back exact and hash-valid", async () => {
    const c = await RelayClient.connect(target.ws);
    try {
      const ev = sign(user().sk, { kind: 1, content: "\ufeffleading bom" });
      expect((await c.publish(ev)).ok).toBe(true);
      const { events } = await c.query("bom", [{ ids: [ev.id] }]);
      expect(events[0].content).toBe(ev.content);
      expect(getEventHash(events[0])).toBe(ev.id);
    } finally {
      c.close();
    }
  });

  async function sigterm() {
    const started = await startNode();
    const c = await RelayClient.connect(started.target.ws);
    c.send(["REQ", "s", { kinds: [1], since: now() }]);
    await c.waitFor((m) => m[0] === "EOSE");
    started.proc.kill("SIGTERM");
    const code = await Promise.race([started.proc.exited, Bun.sleep(8000).then(() => "timeout")]);
    await waitClosed(c);
    await releaseBackend(started.dir);
    return { code, c };
  }

  test("SIGTERM: the process exits 0 and open sockets are closed", async () => {
    const { code, c } = await sigterm();
    expect(code).toBe(0);
    expect(c.closed).toBe(true);
  }, 20_000);

  // node.ts stop() terminate()s every socket right after relay.stop() queued the NOTICE and started the 1001 close
  // handshake, so neither reaches the client: it sees an abnormal 1006. The Bun adapter delivers both.
  test("node adapter shutdown sends the shutdown NOTICE and closes 1001 (regression)", async () => {
    const { code, c } = await sigterm();
    expect(code).toBe(0);
    expect(c.inbox).toContainEqual(["NOTICE", "error: relay is shutting down"]);
    expect(c.closeCode).toBe(1001);
  }, 20_000);
});
