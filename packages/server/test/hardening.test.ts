import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus, HookRegistry, createLogger, type BeamhopPlugin } from "@beamhop/sdk";
import { buildApp, createBeamhop } from "../src/app";
import { loadConfig } from "../src/config";
import { nodeModulesDirs } from "../src/plugins/discovery";
import { createPluginManager, redactConfigForPlugins } from "../src/plugins/manager";
import { clientIp } from "../src/runtime/common";
import { stubFactories, stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("client ip behind a proxy", () => {
  const h = (xff?: string, real?: string) => (n: string) => (n === "x-forwarded-for" ? xff : n === "x-real-ip" ? real : undefined);
  test("uses the rightmost X-Forwarded-For hop (the one our proxy appended)", () => {
    expect(clientIp("10.0.0.1", h("6.6.6.6, 7.7.7.7, 203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientIp("10.0.0.1", h("::ffff:203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientIp("10.0.0.1", h(" , "), true)).toBe("10.0.0.1");
    expect(clientIp("10.0.0.1", h(undefined, "198.51.100.2"), true)).toBe("198.51.100.2");
  });
  test("ignores headers without trustProxy", () => {
    expect(clientIp("::ffff:10.0.0.1", h("6.6.6.6"), false)).toBe("10.0.0.1");
  });
});

describe("config hardening", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".tmp-hard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("OTEL headers: no truncated keys, percent-decoding, bad pairs rejected", () => {
    const { config } = loadConfig({ cwd: dir, env: { BEAMHOP_OTEL_HEADERS: "Authorization=Basic%20a%2Cb,x-k = v" } });
    expect(config.metrics.otel.headers).toEqual({ Authorization: "Basic a,b", "x-k": "v" });
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_OTEL_HEADERS: "Authorization" } })).toThrow(/key=value/);
  });

  test("empty BEAMHOP_PLUGINS_ENABLED / BEAMHOP_PROMETHEUS mean unset", () => {
    writeFileSync(join(dir, "beamhop.config.json"), JSON.stringify({ plugins: { enabled: ["hello"] } }));
    const { extras } = loadConfig({ cwd: dir, env: { BEAMHOP_PLUGINS_ENABLED: "", BEAMHOP_PROMETHEUS: "" } });
    expect(extras.pluginsEnabled).toEqual(["hello"]);
    expect(extras.prometheus).toBe(true);
  });

  test("relative plugins.packages resolve against the config file dir", () => {
    mkdirSync(join(dir, "conf"));
    writeFileSync(join(dir, "conf", "beamhop.config.json"), JSON.stringify({ plugins: { packages: ["./local-plugin", "beamhop-plugin-x"] } }));
    const { config } = loadConfig({ cwd: dir, configPath: "conf/beamhop.config.json", env: {} });
    expect(config.plugins.packages).toEqual([join(dir, "conf", "local-plugin"), "beamhop-plugin-x"]);
  });

  test("deprecated admin.sessionSecret still loads", () => {
    writeFileSync(join(dir, "beamhop.config.json"), JSON.stringify({ admin: { sessionSecret: "old" } }));
    expect(() => loadConfig({ cwd: dir, env: {} })).not.toThrow();
  });
});

describe("plugin hardening", () => {
  test("npm discovery never walks into $HOME or /", () => {
    const root = mkdtempSync(join(import.meta.dir, ".tmp-nm-"));
    try {
      const home = join(root, "home");
      const project = join(home, "proj", "app");
      for (const d of [join(home, "node_modules"), join(home, "proj", "node_modules"), join(project, "node_modules")]) mkdirSync(d, { recursive: true });
      expect(nodeModulesDirs(project, home)).toEqual([join(project, "node_modules"), join(home, "proj", "node_modules")]);
      // running from $HOME itself still uses its own node_modules
      expect(nodeModulesDirs(home, home)).toEqual([join(home, "node_modules")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plugins get a config without secrets", () => {
    const cfg = testConfig({
      relaySecretKey: "f".repeat(64),
      admin: { sessionSecret: "s", vapid: { publicKey: "pub", privateKey: "VAPID-PRIV-KEY", subject: "mailto:x" } },
      database: { sqlitePath: ":memory:", postgresUrl: "postgres://u:hunter2@db/x" },
      blossom: { s3: { endpoint: "https://s3", bucket: "b", accessKeyId: "AKIA-TEST", secretAccessKey: "S3-SECRET-KEY" } },
      metrics: { otel: { headers: { authorization: "Bearer t" } } },
    });
    const red = redactConfigForPlugins(cfg);
    const dump = JSON.stringify(red);
    for (const secret of ["f".repeat(64), "VAPID-PRIV-KEY", "hunter2", "AKIA-TEST", "S3-SECRET-KEY", "Bearer t"]) expect(dump).not.toContain(secret);
    expect(red.blossom.s3?.bucket).toBe("b");
    expect(cfg.relaySecretKey).toBe("f".repeat(64)); // original untouched
  });

  test("concurrent enables run setup once; migrate() applies enabled plugins' migrations without running them", async () => {
    let setups = 0;
    const plugin: BeamhopPlugin = {
      name: "slow",
      version: "1.0.0",
      migrations: [{ id: "001", up: "CREATE TABLE plugin_slow_x (a INT)" }],
      async setup() {
        setups++;
        await sleep(20);
      },
    };
    const off: BeamhopPlugin = { name: "off", version: "1.0.0", migrations: [{ id: "001", up: "CREATE TABLE plugin_off_x (a INT)" }], setup() {} };
    const stores = stubStores();
    const pm = createPluginManager({
      config: testConfig(), stores, settings: stubSettings(), hooks: new HookRegistry(), bus: new EventBus(), logger: createLogger("error"),
      relay: stubRelay(), metrics: stubMetrics(), plugins: [{ plugin }, { plugin: off }], defaultEnabled: ["slow"],
    });
    expect(await pm.migrate()).toBe(1);
    expect(stores.db.migrations["plugin:slow"]).toEqual(["001"]);
    // a disabled plugin's tables are left alone until it is enabled
    expect(stores.db.migrations["plugin:off"]).toBeUndefined();
    expect(setups).toBe(0);
    await pm.start();
    await Promise.all([pm.enable("slow", "a"), pm.enable("slow", "b"), pm.enable("slow", "c")]);
    expect(setups).toBe(1);
    expect(pm.get("slow")?.status).toBe("running");
    await pm.stop();
  });

  test("a rejecting async bus handler doesn't become an unhandled rejection", async () => {
    const bus = new EventBus();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const origError = console.error;
    console.error = () => {};
    try {
      let after = false;
      bus.on("alert", async () => {
        throw new Error("plugin bug");
      });
      bus.on("alert", () => {
        after = true;
      });
      bus.emit("alert", { level: "info", title: "t", message: "m" });
      await sleep(10);
      expect(after).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      console.error = origError;
    }
  });
});

describe("endpoint hardening", () => {
  test("/health doesn't leak database errors", async () => {
    const f = stubFactories();
    const bh = await createBeamhop(testConfig(), { factories: f });
    const app = buildApp({
      config: bh.config, extras: bh.extras, settings: bh.settings, relay: bh.relay, metrics: bh.metrics, plugins: bh.plugins, assets: bh.assets,
      logger: createLogger("error"), checkHealth: async () => {
        throw new Error("connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5");
      },
    });
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("10.0.0.5");
    await bh.stop();
  });

  test("/metrics token check", async () => {
    const bh = await createBeamhop(testConfig(), { factories: stubFactories(), extras: { metricsToken: "s3cret" } });
    expect((await bh.fetch(new Request("http://x/metrics"))).status).toBe(401);
    expect((await bh.fetch(new Request("http://x/metrics", { headers: { authorization: "Bearer s3cre" } }))).status).toBe(401);
    expect((await bh.fetch(new Request("http://x/metrics", { headers: { authorization: "Bearer s3cret" } }))).status).toBe(200);
    await bh.stop();
  });
});
