import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { EventBus, HookRegistry, createLogger, type AdminApi, type BeamhopPlugin, type NostrEvent } from "@beamhop/sdk";
import { PROMETHEUS_CONTENT_TYPE } from "@beamhop/metrics";
import { createDb, createTestStores } from "@beamhop/storage";
import { Hono } from "hono";
import { createBeamhop, ensureSecrets, makeEnv } from "../src/app";
import { createPluginManager, PluginError } from "../src/plugins/manager";
import { createAssetSource, serveAdminAsset, setEmbeddedUi, uiDirCandidates } from "../src/static";
import { DEFAULT_SPAM_LIMITS, SpamScorer, remember, type SpamSettings } from "../../../plugins/spam-filter/src/index";
import { stubFactories, stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";

const repo = join(import.meta.dir, "../../..");
type Validate = (e: unknown) => { event: NostrEvent } | { reason: string };
// the core package adds validateEventShape to its exports in the same round; until then the import test is skipped
const validate = ((await import("@beamhop/core").catch(() => ({}))) as { validateEventShape?: Validate }).validateEventShape;
const silent = createLogger("error");

describe("/metrics without a token: loopback only (item 3)", () => {
  test("private-network peers are refused; loopback is served with the Prometheus content type", async () => {
    const bh = await createBeamhop(testConfig(), { factories: stubFactories() });
    try {
      const get = (ip: string, headers: Record<string, string> = {}) => bh.fetch(new Request("http://x/metrics", { headers }), makeEnv(ip));
      for (const ip of ["127.0.0.1", "127.8.9.10", "::1"]) {
        const res = await get(ip);
        expect([ip, res.status]).toEqual([ip, 200]);
        expect(res.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
      }
      // Docker's userland proxy (IPv6 clients), a k8s Service SNAT, nginx without forwarding headers: all look private
      for (const ip of ["172.18.0.1", "10.0.0.2", "192.168.1.20", "100.64.0.1", "fd00::2", "unknown"]) expect([ip, (await get(ip)).status]).toEqual([ip, 403]);
      expect((await get("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
    } finally {
      await bh.stop();
    }
  });

  test("behind a reverse proxy (trustProxy) a token is required even from loopback", async () => {
    const bh = await createBeamhop(testConfig({ server: { trustProxy: true } }), { factories: stubFactories() });
    try {
      // bare-metal nginx with the default proxy_pass: internet clients arrive from loopback, no forwarding header
      for (const ip of ["127.0.0.1", "::1"]) expect([ip, (await bh.fetch(new Request("http://x/metrics"), makeEnv(ip))).status]).toEqual([ip, 403]);
    } finally {
      await bh.stop();
    }
    const withToken = await createBeamhop(testConfig({ server: { trustProxy: true } }), { factories: stubFactories(), extras: { metricsToken: "k".repeat(32) } });
    try {
      const res = await withToken.fetch(new Request("http://x/metrics", { headers: { authorization: `Bearer ${"k".repeat(32)}` } }), makeEnv("127.0.0.1"));
      expect(res.status).toBe(200);
    } finally {
      await withToken.stop();
    }
  });

  test("with a token, any peer may scrape (Prometheus in the compose network)", async () => {
    const bh = await createBeamhop(testConfig(), { factories: stubFactories(), extras: { metricsToken: "t".repeat(32) } });
    try {
      const res = await bh.fetch(new Request("http://x/metrics", { headers: { authorization: `Bearer ${"t".repeat(32)}` } }), makeEnv("172.18.0.5"));
      expect(res.status).toBe(200);
    } finally {
      await bh.stop();
    }
  });

  test("the compose Prometheus profile scrapes beamhop with BEAMHOP_METRICS_TOKEN", () => {
    const yaml = (Bun as unknown as { YAML: { parse(s: string): any } }).YAML;
    const prom = yaml.parse(readFileSync(join(repo, "deploy/prometheus.yml"), "utf8"));
    const job = prom.scrape_configs.find((j: { job_name: string }) => j.job_name === "beamhop");
    expect(job.authorization).toEqual({ type: "Bearer", credentials_file: "/prometheus/beamhop-metrics-token" });
    const compose = yaml.parse(readFileSync(join(repo, "docker-compose.yml"), "utf8"));
    const svc = compose.services.prometheus;
    expect(svc.environment.BEAMHOP_METRICS_TOKEN).toBe("${BEAMHOP_METRICS_TOKEN:-}");
    expect(svc.entrypoint.join(" ")).toContain("> /prometheus/beamhop-metrics-token");
    expect(compose.services.beamhop.environment.BEAMHOP_METRICS_TOKEN).toBe("${BEAMHOP_METRICS_TOKEN:-}");
  });
});

describe("admin CSP works behind any proxy (review follow-up to item 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".tmp-csp5-"));
    writeFileSync(join(dir, "index.html"), `<!doctype html><script>1</script><script type="module" src="/admin/assets/i.js"></script>`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const scriptSrc = (res: Response | undefined) =>
    res!.headers.get("content-security-policy")!.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!.split(/\s+/).slice(1);

  test("script-src is 'self' plus the inline hashes, whatever Host the proxy sends and whatever publicUrl says", async () => {
    // nginx's default proxy_pass sends Host: 127.0.0.1:3334 while the browser is on https://relay.example.com and
    // publicUrl was left at localhost: a host source would match neither and blank the panel
    const bh = await createBeamhop(testConfig({ server: { publicUrl: "http://localhost:3334" } }), { factories: stubFactories(), assets: createAssetSource(dir) });
    try {
      for (const url of ["http://127.0.0.1:3334/admin/login", "http://[::1]:3334/admin/", "https://relay.example.com/admin/users"]) {
        const src = scriptSrc(await bh.fetch(new Request(url)));
        expect(src[0]).toBe("'self'");
        expect(src.length).toBe(2);
        expect(src[1]).toStartWith("'sha256-");
        expect(src.join(" ")).not.toContain("unsafe-inline");
      }
    } finally {
      await bh.stop();
    }
  });
});

describe("embedded admin assets: own keys only (item 5)", () => {
  afterEach(() => setEmbeddedUi({}));

  test("constructor / __proto__ / toString fall back to the SPA instead of throwing", async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp-emb5-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title>");
      setEmbeddedUi({ "index.html": join(dir, "index.html") });
      const src = createAssetSource();
      expect(src.kind).toBe("embedded");
      for (const p of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
        expect(src.resolve(p)).toBeUndefined();
        const res = await serveAdminAsset(src, p, new Request(`http://x/admin/${p}`));
        expect([p, res!.status, res!.headers.get("content-type")]).toEqual([p, 200, "text/html; charset=utf-8"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("admin UI auto-detection never looks outside the install (item 9)", () => {
  test("no working-directory candidates; the workspace build only from a source checkout", () => {
    const cwd = process.cwd();
    for (const here of ["/srv/app/node_modules/beamhop", "/$bunfs/root", "/opt/beamhop/packages/server/dist/node"]) {
      const c = uiDirCandidates(undefined, here);
      expect(c).toEqual([join(here, "admin-ui")]);
      expect(c.some((d) => d.startsWith(cwd))).toBe(false);
    }
    expect(uiDirCandidates(undefined, "/repo/packages/server/src")).toEqual(["/repo/packages/server/src/admin-ui", "/repo/packages/admin-ui/dist"]);
    expect(uiDirCandidates("/explicit")).toEqual(["/explicit"]);
  });
});

describe("relay key: insert-if-absent, then read back (item 6)", () => {
  test("instances booting together on one database end up with the same key", async () => {
    const stores = await createTestStores();
    try {
      const configs = [testConfig(), testConfig(), testConfig()];
      await Promise.all(configs.map((c) => ensureSecrets(c, stores, silent)));
      const stored = await stores.kv.get<string>("server", "relaySecretKey");
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      for (const c of configs) expect(c.relaySecretKey).toBe(stored);
      // a later boot keeps it; a configured key wins and isn't persisted
      const again = testConfig();
      await ensureSecrets(again, stores, silent);
      expect(again.relaySecretKey).toBe(stored);
      const explicit = testConfig({ relaySecretKey: "1".repeat(64) });
      await ensureSecrets(explicit, stores, silent);
      expect(explicit.relaySecretKey).toBe("1".repeat(64));
      expect(await stores.kv.get("server", "relaySecretKey")).toBe(stored);
    } finally {
      await stores.close();
    }
  });

  test("stores without setIfAbsent still get a key", async () => {
    const stores = stubStores();
    const c = testConfig();
    await ensureSecrets(c, stores, silent);
    expect(c.relaySecretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(stores.kvData.get("server/relaySecretKey")).toBe(c.relaySecretKey);
  });
});

describe("plugin manager: no duplicate audit records, no dead redirect (items 12, 13)", () => {
  test("enable / disable / settings leave auditing to the admin API (which records each once)", async () => {
    const ok: BeamhopPlugin = { name: "ok", version: "1.0.0", async setup(ctx) { ctx.adminHttp.get("/", (c) => c.text("root")); } };
    const broken: BeamhopPlugin = { name: "broken", version: "1.0.0", async setup() { throw new Error("nope"); } };
    const stores = stubStores();
    const pm = createPluginManager({
      config: testConfig(), stores, settings: stubSettings(), hooks: new HookRegistry(), bus: new EventBus(), logger: silent,
      relay: stubRelay(), metrics: stubMetrics(), plugins: [{ plugin: ok }, { plugin: broken }],
    });
    await pm.start();
    await pm.enable("ok", "admin1");
    await pm.updateSettings("ok", { a: 1 }, "admin1");
    await expect(pm.enable("broken", "admin1")).rejects.toBeInstanceOf(PluginError);
    // `/:name/*` also matches `/:name`: the bare plugin path reaches the plugin, no redirect to a wrong `/ok/`
    const bare = await pm.adminRoutes.fetch(new Request("http://x/ok"));
    expect([bare.status, await bare.text()]).toEqual([200, "root"]);
    await pm.disable("ok", "admin1");
    expect(stores.auditEntries).toEqual([]);
    await pm.stop();
  });
});

describe("beamhop export / import (items 10, 11)", () => {
  test("export refuses a NIP-50 search filter (ranked results can't be paged by time)", async () => {
    (globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__ = true;
    const { main } = await import("../src/cli");
    await expect(main(["export", "--filter", '{"search":"needle"}', "--sqlite-path", ":memory:"])).rejects.toThrow(/search/);
    await expect(main(["export", "--filter", "[1]", "--sqlite-path", ":memory:"])).rejects.toThrow(/filter/);
  });

  test.skipIf(!validate)("import applies the relay's own event shape rules (core validateEventShape)", async () => {
    (globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__ = true;
    const { parseImportLine } = await import("../src/cli");
    const sk = generateSecretKey();
    const sign = (t: { kind: number; tags?: string[][]; content?: string }) =>
      finalizeEvent({ kind: t.kind, created_at: 1_700_000_000, tags: t.tags ?? [], content: t.content ?? "x" }, sk) as unknown as NostrEvent;
    const good = sign({ kind: 1 });
    expect(parseImportLine(JSON.stringify(good), validate!)).toMatchObject({ id: good.id });
    expect(parseImportLine(JSON.stringify(["EVENT", good]), validate!)).toMatchObject({ id: good.id });
    // signed and well-formed JSON, but the relay would refuse them
    for (const bad of [sign({ kind: 70_000 }), sign({ kind: 1, tags: [[]] }), sign({ kind: 1, content: "a\u0000b" }), sign({ kind: 30_000, tags: [["d", "x".repeat(5000)]] })]) {
      expect(parseImportLine(JSON.stringify(bad), validate!)).toBeUndefined();
    }
    expect(parseImportLine(JSON.stringify({ ...good, sig: "0".repeat(128) }), validate!)).toBeUndefined();
    expect(parseImportLine(JSON.stringify({ ...good, sig: "0".repeat(128) }), validate!, true)).toMatchObject({ id: good.id });
    expect(parseImportLine("not json", validate!)).toBeUndefined();
  });
});

describe("spam-filter memory is bounded (item 7)", () => {
  const settings = (): SpamSettings => ({
    kinds: [], threshold: 1, action: "reject", exemptPubkeys: [], exemptAdmins: true,
    duplicateWindowSec: 900, duplicateMaxPubkeys: 3, duplicateMinLength: 20, duplicateWeight: 1,
    repeatMaxPerPubkey: 3, repeatWeight: 0.6, maxLinks: 4, maxLinkRatio: 0.5, linkWeight: 0.6,
    maxMentions: 25, mentionWeight: 1, newAccountAgeSec: 3600, newAccountEventsPerMinute: 5, newAccountLinkWeight: 0.4, rateWeight: 1,
  });
  let n = 0;
  const ev = (content: string, pubkey: string) => ({ id: String(++n).padStart(64, "0"), pubkey, created_at: 0, kind: 1, tags: [], content, sig: "s" }) as NostrEvent;

  test("a flood of distinct messages from fresh pubkeys can't grow the maps past their caps", () => {
    const s = new SpamScorer(settings, () => 1_000_000, { maxContentKeys: 100, maxTrackedPubkeys: 50 });
    for (let i = 0; i < 2000; i++) s.score(ev(`unique message number ${i} with enough length`, i.toString(16).padStart(64, "0")));
    expect(s.size.contentKeys).toBe(100);
    expect(s.size.trackedPubkeys).toBe(50);
    // recent content is still tracked: the 4th pubkey repeating it is flagged
    const text = "copy paste spam that keeps coming back";
    for (let i = 0; i < 3; i++) expect(s.score(ev(text, `p${i}`.padEnd(64, "0"))).score).toBeLessThan(1);
    expect(s.score(ev(text, "p3".padEnd(64, "0"))).reasons.join()).toContain("same content from 4 pubkeys");
  });

  test("the per-message pubkey cap follows duplicateMaxPubkeys, so a high threshold still detects floods", () => {
    const high = (): SpamSettings => ({ ...settings(), duplicateMaxPubkeys: 1500 });
    const s = new SpamScorer(high, () => 1_000_000);
    const text = "the same promotional text from a botnet of fresh keys";
    const key = (i: number) => String(i).padStart(64, "0");
    for (let i = 0; i < 1500; i++) expect(s.score(ev(text, key(i))).reasons.join()).not.toContain("same content");
    expect(s.score(ev(text, key(1500))).reasons.join()).toContain("same content from 1501 pubkeys");
    // and it stays flagged as more keys join (the oldest entries are evicted, the count stays above the threshold)
    expect(s.score(ev(text, key(1501))).reasons.join()).toContain("same content from 1501 pubkeys");
  });

  test("remember() keeps the most recently used entries", () => {
    const m = new Map<string, number>();
    for (const k of ["a", "b", "c"]) remember(m, k, 1, 2);
    expect([...m.keys()]).toEqual(["b", "c"]);
    remember(m, "b", 2, 2);
    remember(m, "d", 1, 2);
    expect([...m.keys()]).toEqual(["b", "d"]);
    expect(DEFAULT_SPAM_LIMITS.maxContentKeys).toBeGreaterThan(0);
  });
});

describe("repo hygiene (items 2, 15)", () => {
  /** Docker's .dockerignore semantics, enough for these patterns: root-anchored globs, `**` spans directories. */
  const patterns = readFileSync(join(repo, ".dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const toRe = (p: string) =>
    new RegExp(
      "^" +
        p
          .replace(/^\//, "")
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "\u0000")
          .replace(/\*\*/g, "\u0001")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0000/g, "(?:.*/)?")
          .replace(/\u0001/g, ".*") +
        "$",
    );
  const res = patterns.map(toRe);
  const ignored = (path: string) => {
    const parts = path.split("/");
    return parts.some((_, i) => res.some((re) => re.test(parts.slice(0, i + 1).join("/"))));
  };

  test(".dockerignore keeps nested databases, data dirs, env files and agent worktrees out of the image", () => {
    for (const p of [
      "data/beamhop.db", "packages/server/data/beamhop.db", "packages/server/data/blobs/ab/cd", "packages/x/foo.db-wal", ".env",
      "packages/server/.env", "packages/server/.env.local", ".claude/worktrees/wt/data/beamhop.db", ".claude/settings.local.json",
      "packages/server/test/.tmp-abc/x", "beamhop.config.json", "packages/server/beamhop.config.json", "tsconfig.tsbuildinfo",
    ])
      expect([p, ignored(p)]).toEqual([p, true]);
    for (const p of ["packages/server/src/app.ts", "beamhop.config.example.json", "plugins/hello/src/index.ts", "deploy/prometheus.yml", "package.json", "bun.lock"])
      expect([p, ignored(p)]).toEqual([p, false]);
  });

  test("the root typecheck script also covers the admin UI", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toContain("-p packages/admin-ui/tsconfig.json");
    expect(pkg.scripts.typecheck).toContain("-p plugins/hello/ui/tsconfig.json");
  });
});

describe("NIP-86 gets the client IP (coordinator item: audit IPs)", () => {
  test("POST / with the NIP-86 content type hands the runtime env (ip) to the admin API", async () => {
    const seen: (string | undefined)[] = [];
    const adminApi: AdminApi = { app: new Hono(), nip86: async (_req, env) => (seen.push(env?.ip), Response.json({ result: true })) };
    const bh = await createBeamhop(testConfig(), { factories: stubFactories({ createAdminApi: async () => adminApi }) });
    try {
      const res = await bh.fetch(new Request("http://x/", { method: "POST", headers: { "content-type": "application/nostr+json+rpc" }, body: "{}" }), makeEnv("198.51.100.7"));
      expect(res.status).toBe(200);
      expect(seen).toEqual(["198.51.100.7"]);
    } finally {
      await bh.stop();
    }
  });
});

describe("beamhop admin remove revokes access like the admin API does", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  };
  beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-adminrm-"))));
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("sessions, push devices, password/TOTP and passkeys go with the role; other admins keep theirs", async () => {
    (globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__ = true;
    const { main } = await import("../src/cli");
    setEnv("BEAMHOP_BLOSSOM_FS_PATH", join(dir, "blobs"));
    setEnv("BEAMHOP_PLUGINS_DIR", join(dir, "plugins"));
    setEnv("BEAMHOP_LOG_LEVEL", "error");
    const dbPath = join(dir, "db.sqlite");
    const target = "a".repeat(64);
    const other = "b".repeat(64);
    const quiet = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
    try {
      await main(["migrate", "--sqlite-path", dbPath]);
      const db = await createDb({ database: { driver: "sqlite", sqlitePath: dbPath } });
      for (const pk of [target, other]) {
        await db.run("INSERT INTO admin_credentials (pubkey, password_hash, totp_secret, updated_at) VALUES (?, 'h', 'totp', 1)", [pk]);
        await db.run("INSERT INTO admin_passkeys (id, pubkey, public_key, created_at) VALUES (?, ?, 'k', 1)", [`pk-${pk}`, pk]);
        await db.run("INSERT INTO admin_sessions (id, pubkey, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 9999999999, 1)", [`s-${pk}`, pk]);
        await db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, created_at) VALUES (?, ?, '{}', 1)", [`https://push.test/${pk}`, pk]);
      }
      await db.close();
      await main(["admin", "add", target, "--role", "admin", "--sqlite-path", dbPath]);
      await main(["admin", "remove", target, "--sqlite-path", dbPath]);
    } finally {
      for (const q of quiet) q.mockRestore();
    }
    const db = await createDb({ database: { driver: "sqlite", sqlitePath: dbPath } });
    try {
      for (const table of ["admin_credentials", "admin_passkeys", "admin_sessions", "admin_push_subscriptions"]) {
        const count = async (pk: string) => Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE pubkey = ?`, [pk]))!.n);
        expect([table, await count(target), await count(other)]).toEqual([table, 0, 1]);
      }
      expect((await db.get<{ role: string | null }>("SELECT role FROM users WHERE pubkey = ?", [target]))?.role).toBeNull();
    } finally {
      await db.close();
    }
  });
});
