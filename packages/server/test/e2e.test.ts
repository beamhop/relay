import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { createBeamhop, type Beamhop } from "../src/app";
import { loadConfig } from "../src/config";
import { serve, type RunningServer } from "../src/server";

const root = join(import.meta.dir, "../..");
const realAvailable = ["storage", "core", "blossom", "metrics", "admin-api"].every((p) => existsSync(join(root, p, "src/index.ts")));

describe.skipIf(!realAvailable)("e2e with real packages (bun runtime)", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-e2e-"));
  const owner = generateSecretKey();
  let bh: Beamhop;
  let server: RunningServer;
  let base: string;

  beforeAll(async () => {
    const { config } = loadConfig({
      cwd: dir,
      env: {},
      overrides: {
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
        database: { driver: "sqlite", sqlitePath: join(dir, "e2e.db") },
        blossom: { fsPath: join(dir, "blobs") },
        admin: { owners: [nip19.npubEncode(getPublicKey(owner))] },
        plugins: { dir: join(dir, "plugins") },
      },
    });
    bh = await createBeamhop(config, { autoDiscoverNpm: false });
    await bh.start();
    server = await serve(bh, { runtime: "bun", port: 0, host: "127.0.0.1" });
    base = `127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server?.stopAccepting();
    await bh?.stop();
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("NIP-11 + landing page", async () => {
    const info = await (await fetch(`http://${base}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(Array.isArray(info.supported_nips)).toBe(true);
    const html = await (await fetch(`http://${base}/`)).text();
    expect(html).toContain("ws://");
  });

  test("publish an event and REQ it back over websocket", async () => {
    const sk = generateSecretKey();
    const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "hello beamhop e2e" }, sk);
    const ws = new WebSocket(`ws://${base}/`);
    const inbox: unknown[][] = [];
    const waitFor = (pred: (m: unknown[]) => boolean) =>
      new Promise<unknown[]>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(inbox)}`)), 5000);
        const check = () => {
          const m = inbox.find(pred);
          if (m) {
            clearTimeout(t);
            resolve(m);
          } else setTimeout(check, 10);
        };
        check();
      });
    ws.onmessage = (m) => inbox.push(JSON.parse(String(m.data)));
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));

    ws.send(JSON.stringify(["EVENT", ev]));
    const ok = await waitFor((m) => m[0] === "OK" && m[1] === ev.id);
    expect(ok[2]).toBe(true);

    ws.send(JSON.stringify(["REQ", "s1", { ids: [ev.id] }]));
    const got = await waitFor((m) => m[0] === "EVENT" && m[1] === "s1");
    expect((got[2] as { content: string }).content).toBe("hello beamhop e2e");
    await waitFor((m) => m[0] === "EOSE" && m[1] === "s1");
    ws.close();
  });

  test("admin api is mounted and requires auth", async () => {
    const res = await fetch(`http://${base}/admin/api/auth/me`);
    expect(res.status).toBe(401);
    const spa = await fetch(`http://${base}/admin/some/deep/route`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
  });

  test("blossom is mounted", async () => {
    const res = await fetch(`http://${base}/${"0".repeat(64)}`);
    expect(res.status).toBe(404);
  });
});
