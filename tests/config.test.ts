import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const TRACKED_ENV = ["RELAY_PASSWORD", "PORT", "RELAY_STORAGE_BACKEND", "RELAY_POSTGRES_URL", "DATABASE_URL", "RELAY_SQLITE_PATH"] as const;
const originalEnv = new Map(TRACKED_ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of TRACKED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function withTempFile(name: string, contents: string, run: (path: string) => Promise<void>): Promise<void> {
  const path = `${import.meta.dir}/tmp-${crypto.randomUUID()}-${name}`;
  await Bun.write(path, contents);
  try {
    await run(path);
  } finally {
    const file = Bun.file(path);
    if (await file.exists()) await file.delete();
  }
}

test("admin web mode requires a password", async () => {
  delete process.env.RELAY_PASSWORD;
  await expect(loadConfig(["--web"])).rejects.toThrow("admin web interface requires");
});

test("admin password can come from RELAY_PASSWORD and flags override it", async () => {
  process.env.RELAY_PASSWORD = "env-password";
  const envConfig = await loadConfig(["--web"]);
  expect(envConfig.admin).toEqual({ web: true, password: "env-password" });

  const flagConfig = await loadConfig(["--web", "--password", "flag-password"]);
  expect(flagConfig.admin).toEqual({ web: true, password: "flag-password" });
});

test("-w can enable web admin and receive the password value", async () => {
  delete process.env.RELAY_PASSWORD;
  const config = await loadConfig(["-w", "inline-password"]);
  expect(config.admin).toEqual({ web: true, password: "inline-password" });
});

test("port falls back to PORT before defaulting to 7777", async () => {
  delete process.env.PORT;
  const defaultConfig = await loadConfig([]);
  expect(defaultConfig.port).toBe(7777);

  process.env.PORT = "8888";
  const envConfig = await loadConfig([]);
  expect(envConfig.port).toBe(8888);
});

test("explicit port overrides PORT", async () => {
  process.env.PORT = "8888";
  const config = await loadConfig(["--port", "9999"]);
  expect(config.port).toBe(9999);
});

test("zero-config defaults to the in-memory backend", async () => {
  for (const key of TRACKED_ENV) delete process.env[key];
  const config = await loadConfig([]);
  expect(config.storage).toEqual({ backend: "memory" });
  expect(config.persistence).toBeUndefined();
});

test("--persistence selects the sqlite backend and path", async () => {
  const config = await loadConfig(["--persistence", "data/relay.sqlite"]);
  expect(config.storage).toEqual({ backend: "sqlite", sqlitePath: "data/relay.sqlite" });
  expect(config.persistence).toBe("data/relay.sqlite");
});

test("--postgres-url selects the postgres backend", async () => {
  const config = await loadConfig(["--postgres-url", "postgres://localhost/relay"]);
  expect(config.storage.backend).toBe("postgres");
  expect(config.storage.postgres?.url).toBe("postgres://localhost/relay");
});

test("rejects an invalid storage backend", async () => {
  await expect(loadConfig(["--storage", "mongo"])).rejects.toThrow("invalid storage backend");
});

test("reads YAML config including nested storage settings", async () => {
  await withTempFile(
    "relay.yaml",
    "host: 10.0.0.1\nport: 8080\nstorage:\n  backend: postgres\n  postgres:\n    host: db.internal\n    database: relay\n",
    async (path) => {
      const config = await loadConfig(["--config", path]);
      expect(config.host).toBe("10.0.0.1");
      expect(config.port).toBe(8080);
      expect(config.storage.backend).toBe("postgres");
      expect(config.storage.postgres).toMatchObject({ host: "db.internal", database: "relay" });
    },
  );
});

test("JSON config still loads through the YAML parser", async () => {
  await withTempFile("relay.json", JSON.stringify({ storage: { backend: "sqlite", sqlitePath: "j.sqlite" } }), async (path) => {
    const config = await loadConfig(["--config", path]);
    expect(config.storage).toEqual({ backend: "sqlite", sqlitePath: "j.sqlite" });
  });
});

test("precedence: env backend overrides file, CLI overrides env", async () => {
  await withTempFile("relay.yaml", "storage:\n  backend: sqlite\n", async (path) => {
    process.env.RELAY_STORAGE_BACKEND = "memory";
    const envWins = await loadConfig(["--config", path]);
    expect(envWins.storage.backend).toBe("memory");

    const cliWins = await loadConfig(["--config", path, "--storage", "sqlite"]);
    expect(cliWins.storage.backend).toBe("sqlite");
  });
});

test("auto-discovers relay.yaml in the working directory", async () => {
  const previousCwd = process.cwd();
  const dir = `${import.meta.dir}/tmp-cwd-${crypto.randomUUID()}`;
  await Bun.write(`${dir}/relay.yaml`, "port: 6001\nstorage:\n  backend: sqlite\n");
  try {
    process.chdir(dir);
    const config = await loadConfig([]);
    expect(config.port).toBe(6001);
    expect(config.storage.backend).toBe("sqlite");
  } finally {
    process.chdir(previousCwd);
    await Bun.$`rm -rf ${dir}`.quiet();
  }
});
