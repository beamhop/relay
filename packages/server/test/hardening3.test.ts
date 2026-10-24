import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("env parsing: blank values", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-cfg3-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("whitespace-only values count as unset (not 0 = unlimited)", () => {
    const { config } = loadConfig({ cwd: dir, env: { BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_IP: " ", BEAMHOP_PORT: "  " } });
    expect(config.blossom.limits?.uploadsPerMinutePerIp).toBeUndefined();
    expect(config.server.port).not.toBe(0);
  });

  test("an empty mirror port list is rejected instead of disabling mirroring", () => {
    expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_BLOSSOM_MIRROR_PORTS: "," } })).toThrow(/at least one port/);
  });
});

describe("beamhop migrate", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  };
  beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-migrate-"))));
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("plugins enabled via BEAMHOP_PLUGINS_ENABLED are migrated", async () => {
    (globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__ = true;
    const { main } = await import("../src/cli");
    cpSync(join(import.meta.dir, "fixtures/plugins/good"), join(dir, "plugins/good"), { recursive: true });
    setEnv("BEAMHOP_PLUGINS_ENABLED", "good");
    setEnv("BEAMHOP_BLOSSOM_FS_PATH", join(dir, "blobs"));
    setEnv("BEAMHOP_LOG_LEVEL", "error");
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    try {
      await main(["migrate", "--sqlite-path", join(dir, "db.sqlite"), "--plugins-dir", join(dir, "plugins")]);
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.some((l) => /checked 1 enabled plugin/.test(l))).toBe(true);
  });
});
