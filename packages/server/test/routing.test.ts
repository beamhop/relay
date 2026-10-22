import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBeamhop, type Beamhop } from "../src/app";
import { createAssetSource } from "../src/static";
import { stubFactories, testConfig } from "./stubs";

let bh: Beamhop;
let uiDir: string;
const url = (p: string) => `http://localhost${p}`;

beforeAll(async () => {
  uiDir = mkdtempSync(join(import.meta.dir, ".tmp-ui-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>admin</title>");
  writeFileSync(join(uiDir, "sw.js"), "self.x=1");
  writeFileSync(join(uiDir, "manifest.webmanifest"), "{}");
  writeFileSync(join(uiDir, "assets", "index-AbCdEf12.js"), "console.log(1)");
  bh = await createBeamhop(testConfig(), { factories: stubFactories(), extras: { metricsToken: "sekret" }, assets: createAssetSource(uiDir) });
  await bh.start();
});
afterAll(async () => {
  await bh.stop();
  rmSync(uiDir, { recursive: true, force: true });
});

describe("routing order", () => {
  test("NIP-11 vs landing page on GET /", async () => {
    const nip11 = await bh.fetch(new Request(url("/"), { headers: { accept: "application/nostr+json" } }));
    expect(nip11.headers.get("content-type")).toContain("json");
    expect((await nip11.json()).name).toBe("stub");

    const landing = await bh.fetch(new Request(url("/"), { headers: { accept: "text/html" } }));
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain("beamhop relay");
    expect(html).toContain("ws://localhost:3334/");
    expect(html).toContain("NIP-42");
    expect(html).toContain('href="/admin/"');
  });

  test("websocket upgrade reaching the app is not treated as landing", async () => {
    const res = await bh.fetch(new Request(url("/"), { headers: { upgrade: "websocket", connection: "Upgrade" } }));
    expect(res.status).toBe(426);
  });

  test("POST / with nostr+json+rpc goes to NIP-86", async () => {
    const res = await bh.fetch(new Request(url("/"), { method: "POST", headers: { "content-type": "application/nostr+json+rpc" }, body: '{"method":"supportedmethods","params":[]}' }));
    expect(await res.json()).toEqual({ result: ["supportedmethods"] });
    const other = await bh.fetch(new Request(url("/"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(other.status).toBe(404);
  });

  test("relay http routes (NIP-05)", async () => {
    const res = await bh.fetch(new Request(url("/.well-known/nostr.json?name=x")));
    expect(await res.json()).toEqual({ names: {} });
  });

  test("admin api before static, unknown api paths 404 json (no SPA fallback)", async () => {
    const me = await bh.fetch(new Request(url("/admin/api/me")), { ip: "203.0.113.9" });
    expect(await me.json()).toEqual({ pubkey: "me", ip: "203.0.113.9" });
    const missing = await bh.fetch(new Request(url("/admin/api/nope")));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("json");
  });

  test("client ip header cannot be spoofed", async () => {
    const me = await bh.fetch(new Request(url("/admin/api/me"), { headers: { "x-beamhop-client-ip": "6.6.6.6" } }), { ip: "10.0.0.1" });
    expect((await me.json()).ip).toBe("10.0.0.1");
  });

  test("admin static: SPA fallback, caching, mime, 404 for missing assets", async () => {
    const redirect = await bh.fetch(new Request(url("/admin")));
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/admin/");

    const index = await bh.fetch(new Request(url("/admin/")));
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("cache-control")).toBe("no-cache");

    const deep = await bh.fetch(new Request(url("/admin/users/abc")));
    expect(await deep.text()).toContain("<title>admin</title>");

    const asset = await bh.fetch(new Request(url("/admin/assets/index-AbCdEf12.js")));
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const sw = await bh.fetch(new Request(url("/admin/sw.js")));
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(sw.headers.get("service-worker-allowed")).toBe("/admin/");

    const manifest = await bh.fetch(new Request(url("/admin/manifest.webmanifest")));
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");

    expect((await bh.fetch(new Request(url("/admin/assets/missing-12345678.js")))).status).toBe(404);
    expect((await bh.fetch(new Request(url("/admin/%2e%2e/%2e%2e/package.json")))).status).toBeOneOf([403, 404]);
  });

  test("placeholder when admin UI not built", async () => {
    const b = await createBeamhop(testConfig(), { factories: stubFactories(), assets: { kind: "none", resolve: () => undefined } });
    const res = await b.fetch(new Request(url("/admin/")));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("has not been built");
    await b.stop();
  });

  test("/metrics protected by bearer token", async () => {
    expect((await bh.fetch(new Request(url("/metrics")))).status).toBe(401);
    const ok = await bh.fetch(new Request(url("/metrics"), { headers: { authorization: "Bearer sekret" } }));
    expect(await ok.text()).toContain("beamhop_up 1");
  });

  test("blossom routes after everything else; unknown → 404", async () => {
    const sha = "f".repeat(64);
    expect(await (await bh.fetch(new Request(url(`/${sha}.png`)))).text()).toBe(`blob:${sha}.png`);
    expect((await bh.fetch(new Request(url("/upload"), { method: "PUT", body: "x" }))).status).toBe(200);
    expect((await bh.fetch(new Request(url("/nothing-here")))).status).toBe(404);
  });

  test("unknown plugin → 404", async () => {
    expect((await bh.fetch(new Request(url("/plugins/nope/x")))).status).toBe(404);
  });

  test("lifecycle: start/stop reach services", async () => {
    const f = stubFactories();
    const b = await createBeamhop(testConfig(), { factories: f });
    await b.start();
    expect(f.relay.started).toBe(true);
    await b.stop();
    expect(f.relay.stopped).toBe(true);
    expect((f.stores.db as unknown as { closed: boolean }).closed).toBe(true);
    // secrets were generated & persisted
    expect(typeof f.stores.kvData.get("server/relaySecretKey")).toBe("string");
    expect(b.config.admin.sessionSecret).toBe(f.stores.kvData.get("server/sessionSecret") as string);
  });
});
