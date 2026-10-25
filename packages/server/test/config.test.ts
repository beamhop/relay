import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import { loadConfig } from "../src/config";

const PK = "a".repeat(64);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadConfig", () => {
  test("defaults when no file/env", () => {
    const { config, configPath } = loadConfig({ cwd: dir, env: {} });
    expect(configPath).toBeUndefined();
    expect(config.server.port).toBe(3334);
    expect(config.database.sqlitePath).toBe(join(dir, "data/beamhop.db"));
    expect(config.blossom.enabled).toBe(true);
  });

  test("precedence: defaults < file < env < cli overrides", () => {
    writeFileSync(join(dir, "beamhop.config.json"), JSON.stringify({ server: { port: 4000, host: "127.0.0.1" }, logLevel: "warn", database: { sqlitePath: "db/x.db" } }));
    const fileOnly = loadConfig({ cwd: dir, env: {} });
    expect(fileOnly.config.server.port).toBe(4000);
    expect(fileOnly.config.server.host).toBe("127.0.0.1");
    expect(fileOnly.config.database.sqlitePath).toBe(join(dir, "db/x.db"));

    const withEnv = loadConfig({ cwd: dir, env: { BEAMHOP_PORT: "5000", BEAMHOP_LOG_LEVEL: "DEBUG" } });
    expect(withEnv.config.server.port).toBe(5000);
    expect(withEnv.config.server.host).toBe("127.0.0.1");
    expect(withEnv.config.logLevel).toBe("debug");

    const withCli = loadConfig({ cwd: dir, env: { BEAMHOP_PORT: "5000" }, overrides: { server: { port: 6000 } } });
    expect(withCli.config.server.port).toBe(6000);
  });

  test("publicUrl follows the port unless set explicitly", () => {
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_PORT: "4100" } }).config.server.publicUrl).toBe("http://localhost:4100");
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_PORT: "4100", BEAMHOP_PUBLIC_URL: "https://r.example/" } }).config.server.publicUrl).toBe("https://r.example");
  });

  test("--config / BEAMHOP_CONFIG path", () => {
    writeFileSync(join(dir, "other.json"), JSON.stringify({ server: { port: 4321 } }));
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_CONFIG: "other.json" } }).config.server.port).toBe(4321);
    expect(loadConfig({ cwd: dir, env: {}, configPath: join(dir, "other.json") }).config.server.port).toBe(4321);
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_CONFIG: "missing.json" } })).toThrow(/not found/);
  });

  test("owners accept npub and hex, normalized to hex", () => {
    const npub = nip19.npubEncode(PK);
    const { config } = loadConfig({ cwd: dir, env: { BEAMHOP_OWNERS: `${npub}, ${"B".repeat(64)}` } });
    expect(config.admin.owners).toEqual([PK, "b".repeat(64)]);
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_OWNERS: "nope" } })).toThrow(/invalid pubkey/);
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_OWNERS: "npub1notvalid" } })).toThrow(/invalid pubkey/);
  });

  test("blossom/s3/otel env + validation errors", () => {
    const { config, extras } = loadConfig({
      cwd: dir,
      env: {
        BEAMHOP_BLOSSOM_DRIVER: "s3", BEAMHOP_S3_ENDPOINT: "http://minio:9000", BEAMHOP_S3_BUCKET: "b", BEAMHOP_S3_ACCESS_KEY_ID: "k", BEAMHOP_S3_SECRET_ACCESS_KEY: "s",
        BEAMHOP_OTEL_ENABLED: "true", BEAMHOP_OTEL_HEADERS: "x-a=1,x-b=2", BEAMHOP_TRUST_PROXY: "1", BEAMHOP_METRICS_TOKEN: "t", BEAMHOP_PLUGINS_ENABLED: "hello,spam-filter",
      },
    });
    expect(config.blossom.driver).toBe("s3");
    expect(config.blossom.s3).toMatchObject({ endpoint: "http://minio:9000", bucket: "b", region: "auto" });
    expect(config.metrics.otel).toMatchObject({ enabled: true, headers: { "x-a": "1", "x-b": "2" } });
    expect(config.server.trustProxy).toBe(true);
    expect(extras).toMatchObject({ metricsToken: "t", pluginsEnabled: ["hello", "spam-filter"], prometheus: true });
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_PORT: "abc" } })).toThrow(/number/);
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_DB_DRIVER: "mysql" } })).toThrow(/database.driver/);
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_DB_DRIVER: "postgres" } })).toThrow(/postgresUrl/);
  });

  test("unknown file keys and BEAMHOP_* variables warn but still boot", () => {
    writeFileSync(
      join(dir, "beamhop.config.json"),
      JSON.stringify({
        $schema: "./schema.json",
        blosom: { enabled: false },
        server: { port: 4000, trustProxies: ["10.0.0.0/8"], metricsToken: "a-real-token", prometheus: false },
        metrics: { otel: { headers: { "x-anything": "1" } } }, // a record: its keys are free-form
        plugins: { enabled: ["hello"] },
      }),
    );
    const seen: string[] = [];
    const { config, extras, warnings } = loadConfig({
      cwd: dir,
      env: { BEAMHOP_PORTT: "1", BEAMHOP_CONFIG: "beamhop.config.json", BEAMHOP_PROMETHEUS: "", BEAMHOP_SESSION_SECRET: "x", OTHER: "1" },
      warn: (m) => seen.push(m),
    });
    expect(config.server.port).toBe(4000);
    expect(extras).toMatchObject({ metricsToken: "a-real-token", prometheus: false, pluginsEnabled: ["hello"] });
    expect(warnings).toEqual(seen);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain(`"blosom"`);
    expect(warnings[1]).toContain(`"server.trustProxies"`);
    expect(warnings[2]).toContain("BEAMHOP_PORTT");
    expect(loadConfig({ cwd: dir, env: {}, overrides: { blossom: { enabled: false } }, warn: () => {} }).warnings).toHaveLength(2);
  });
});
