import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nip19 } from "nostr-tools";
import type { DatabaseTarget } from "@beamhop/sdk";
import { DATABASE_PINNED_WARNING, databaseEnvPinned, loadConfig } from "../src/config";

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

    const withEnv = loadConfig({ cwd: dir, env: { BEAMHOP_PORT: "5000", BEAMHOP_LOG_LEVEL: "DEBUG", BEAMHOP_LOG_FORMAT: "JSON" } });
    expect(withEnv.config.server.port).toBe(5000);
    expect(withEnv.config.server.host).toBe("127.0.0.1");
    expect(withEnv.config.logLevel).toBe("debug");
    expect(withEnv.config.logFormat).toBe("json");

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

describe("loadConfig: database state file", () => {
  const PG = "postgres://u:p@pg:5432/beamhop";
  const PG2 = "postgres://other@pg2/beamhop";
  const writeState = (current: DatabaseTarget, path = join(dir, "data", "database.json")) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, current, rollbacks: [] }));
  };
  const writeConfig = (json: unknown, name = "beamhop.config.json") => writeFileSync(join(dir, name), JSON.stringify(json));
  const quiet = { warn: () => {} };

  test("databaseEnvPinned", () => {
    expect(databaseEnvPinned({})).toBe(false);
    expect(databaseEnvPinned({ BEAMHOP_DB_DRIVER: "  " })).toBe(false);
    expect(databaseEnvPinned({ BEAMHOP_DB_DRIVER: "sqlite" })).toBe(true);
    // locations alone don't pin: the image sets BEAMHOP_SQLITE_PATH, the URL also prefills the panel
    expect(databaseEnvPinned({ BEAMHOP_SQLITE_PATH: "/x.db" })).toBe(false);
    expect(databaseEnvPinned({ BEAMHOP_DATABASE_URL: PG })).toBe(false);
  });

  test("precedence matrix: default < config < state < env < override", () => {
    const d = loadConfig({ cwd: dir, env: {} });
    expect(d.databaseSource).toBe("default");
    expect(d.databaseState).toBeUndefined();
    expect(d.config.database.stateFile).toBe(join(dir, "data/database.json"));

    writeConfig({ database: { sqlitePath: "db/file.db" } });
    const c = loadConfig({ cwd: dir, env: {} });
    expect(c.databaseSource).toBe("config");
    expect(c.config.database).toMatchObject({ driver: "sqlite", sqlitePath: join(dir, "db/file.db") });
    // the state file defaults to database.json next to the sqlite file
    expect(c.config.database.stateFile).toBe(join(dir, "db/database.json"));

    writeState({ driver: "postgres", postgresUrl: PG }, join(dir, "db/database.json"));
    const s = loadConfig({ cwd: dir, env: {} });
    expect(s.databaseSource).toBe("state");
    expect(s.databaseState?.current).toEqual({ driver: "postgres", postgresUrl: PG });
    expect(s.config.database).toMatchObject({ driver: "postgres", postgresUrl: PG });
    expect(s.warnings).toEqual([]);

    const e = loadConfig({ cwd: dir, env: { BEAMHOP_DB_DRIVER: "sqlite" }, ...quiet });
    expect(e.databaseSource).toBe("env");
    expect(e.databaseState).toBeDefined();
    expect(e.config.database).toMatchObject({ driver: "sqlite", sqlitePath: join(dir, "db/file.db") });

    const o = loadConfig({ cwd: dir, env: { BEAMHOP_DB_DRIVER: "sqlite" }, overrides: { database: { driver: "postgres", postgresUrl: PG2 } }, ...quiet });
    expect(o.databaseSource).toBe("override");
    expect(o.config.database).toMatchObject({ driver: "postgres", postgresUrl: PG2 });
  });

  test("without a state file env / override sources are reported", () => {
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_SQLITE_PATH: "x.db" } }).databaseSource).toBe("env");
    expect(loadConfig({ cwd: dir, env: {}, overrides: { database: { driver: "sqlite" } } }).databaseSource).toBe("override");
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_DB_DRIVER: "sqlite" } }).warnings).toEqual([]);
  });

  test("the state target replaces driver/sqlitePath/postgresUrl as a whole and keeps its absolute path", () => {
    writeConfig({ database: { driver: "postgres", postgresUrl: PG, sqlitePath: "db/file.db" } });
    writeState({ driver: "sqlite", sqlitePath: "/var/lib/beamhop/switched.db" }, join(dir, "db/database.json"));
    const { config, databaseSource } = loadConfig({ cwd: dir, env: {} });
    expect(databaseSource).toBe("state");
    expect(config.database.driver).toBe("sqlite");
    expect(config.database.sqlitePath).toBe("/var/lib/beamhop/switched.db");
    expect(config.database.postgresUrl).toBeUndefined();

    // a postgres state doesn't inherit the config file's sqlite path
    writeState({ driver: "postgres", postgresUrl: PG2 }, join(dir, "db/database.json"));
    const pg = loadConfig({ cwd: dir, env: {} }).config.database;
    expect(pg).toMatchObject({ driver: "postgres", postgresUrl: PG2 });
    expect(pg.sqlitePath).toBe(join(dir, "data/beamhop.db"));
  });

  test("env pins the database only through BEAMHOP_DB_DRIVER, which wins with a warning", () => {
    writeState({ driver: "sqlite", sqlitePath: "/abs/state.db" });
    const seen: string[] = [];
    const driver = loadConfig({ cwd: dir, env: { BEAMHOP_DB_DRIVER: "postgres", BEAMHOP_DATABASE_URL: PG }, warn: (m) => seen.push(m) });
    expect(driver.config.database).toMatchObject({ driver: "postgres", postgresUrl: PG });
    expect(driver.warnings).toEqual([DATABASE_PINNED_WARNING]);
    expect(seen).toEqual([DATABASE_PINNED_WARNING]);
    expect(DATABASE_PINNED_WARNING).toBe("database pinned by environment; the database chosen in the admin panel (data/database.json) is ignored");

    // a URL alone doesn't override the state file (compose always passes one; it's the panel's prefill)
    const url = loadConfig({ cwd: dir, env: { BEAMHOP_DATABASE_URL: PG }, ...quiet });
    expect(url.databaseSource).toBe("state");
    expect(url.warnings).toEqual([]);
    expect(url.config.database).toMatchObject({ driver: "sqlite", sqlitePath: "/abs/state.db" });

    writeState({ driver: "postgres", postgresUrl: PG });
    const other = loadConfig({ cwd: dir, env: { BEAMHOP_DATABASE_URL: PG2 }, ...quiet });
    expect(other.databaseSource).toBe("state");
    expect(other.config.database.postgresUrl).toBe(PG);

    // BEAMHOP_SQLITE_PATH alone (set by the container image) doesn't override the state file
    // (the state file is looked up next to it)
    const path = loadConfig({ cwd: dir, env: { BEAMHOP_SQLITE_PATH: join(dir, "data/beamhop.db") }, ...quiet });
    expect(path.databaseSource).toBe("state");
    expect(path.config.database).toMatchObject({ driver: "postgres", postgresUrl: PG });
    expect(path.warnings).toEqual([]);
  });

  test("CLI overrides of database fields pin the database too", () => {
    writeState({ driver: "sqlite", sqlitePath: join(dir, "data/state.db") });
    const drv = loadConfig({ cwd: dir, env: {}, overrides: { database: { driver: "sqlite" } }, ...quiet });
    expect(drv.databaseSource).toBe("override");
    expect(drv.warnings).toEqual([DATABASE_PINNED_WARNING]);
    expect(drv.config.database.sqlitePath).toBe(join(dir, "data/beamhop.db"));

    const path = loadConfig({ cwd: dir, env: {}, overrides: { database: { sqlitePath: "other.db" } }, ...quiet });
    expect(path.databaseSource).toBe("override");
    expect(path.config.database.sqlitePath).toBe(join(dir, "other.db"));

    // the same path as the state file is not a conflict
    const same = loadConfig({ cwd: dir, env: {}, overrides: { database: { sqlitePath: "data/state.db" } }, ...quiet });
    expect(same.databaseSource).toBe("state");
    expect(same.warnings).toEqual([]);
  });

  test("stateFile is resolved relative to the config file", () => {
    mkdirSync(join(dir, "etc"));
    writeConfig({ database: { stateFile: "state/db.json" } }, "etc/beamhop.json");
    writeState({ driver: "postgres", postgresUrl: PG }, join(dir, "etc/state/db.json"));
    const viaFile = loadConfig({ cwd: dir, env: {}, configPath: "etc/beamhop.json" });
    expect(viaFile.config.database.stateFile).toBe(join(dir, "etc/state/db.json"));
    expect(viaFile.databaseSource).toBe("state");

    // default: ./data/database.json next to the config file
    writeConfig({}, "etc/plain.json");
    expect(loadConfig({ cwd: dir, env: {}, configPath: "etc/plain.json" }).config.database.stateFile).toBe(join(dir, "etc/data/database.json"));
  });

  test("a corrupt or invalid state file fails the boot with its path", () => {
    const p = join(dir, "data", "database.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{");
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(p);
    writeFileSync(p, JSON.stringify({ version: 1, current: { driver: "postgres" }, rollbacks: [] }));
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(p);
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/postgresUrl/);
  });
});
