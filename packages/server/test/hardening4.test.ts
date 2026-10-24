import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBeamhop, makeEnv } from "../src/app";
import { loadConfig } from "../src/config";
import { discoverPlugins } from "../src/plugins/discovery";
import { clientIp, proxyMatcher } from "../src/runtime/common";
import { stubFactories, testConfig } from "./stubs";

const hdr = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;

describe("trusted proxies", () => {
  test("forwarded client IP is only believed from a trusted peer", () => {
    const spoof = hdr({ "x-forwarded-for": "198.51.100.7", "x-real-ip": "198.51.100.8" });
    // a client reaching the published port directly can't pick its own address
    expect(clientIp("203.0.113.5", spoof, true)).toBe("203.0.113.5");
    expect(clientIp("2001:db8::5", spoof, true)).toBe("2001:db8::5");
    expect(clientIp("203.0.113.5", hdr({ "x-real-ip": "198.51.100.8" }), true, "x-real-ip")).toBe("203.0.113.5");
    // default: loopback and private networks (a proxy on the host or in a container network)
    for (const peer of ["127.0.0.1", "::1", "::ffff:10.1.2.3", "172.18.0.2", "192.168.1.10", "100.64.0.1", "fd00::2"]) expect(clientIp(peer, spoof, true)).toBe("198.51.100.7");
  });

  test("an explicit list replaces the defaults", () => {
    const only = proxyMatcher(["203.0.113.0/24", "2001:db8::/32"]);
    const fwd = hdr({ "x-forwarded-for": "198.51.100.7" });
    expect(clientIp("203.0.113.9", fwd, true, "x-forwarded-for", only)).toBe("198.51.100.7");
    expect(clientIp("2001:db8::1", fwd, true, "x-forwarded-for", only)).toBe("198.51.100.7");
    expect(clientIp("10.0.0.1", fwd, true, "x-forwarded-for", only)).toBe("10.0.0.1");
    expect(clientIp("203.0.113.9", fwd, false, "x-forwarded-for", only)).toBe("203.0.113.9");
  });

  describe("config", () => {
    let dir: string;
    beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-cfg4-"))));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("BEAMHOP_TRUSTED_PROXIES is a list, defaults to private networks, and bad entries fail at boot", () => {
      expect(loadConfig({ cwd: dir, env: {} }).config.server.trustedProxies).toContain("10.0.0.0/8");
      expect(loadConfig({ cwd: dir, env: { BEAMHOP_TRUSTED_PROXIES: "203.0.113.4, 2001:db8::/32" } }).config.server.trustedProxies).toEqual(["203.0.113.4", "2001:db8::/32"]);
      expect(() => loadConfig({ cwd: dir, env: { BEAMHOP_TRUSTED_PROXIES: "proxy.local" } })).toThrow(/trustedProxies/);
    });
  });
});

describe("/metrics without a token", () => {
  test("only answers the local network, directly", async () => {
    const bh = await createBeamhop(testConfig(), { factories: stubFactories() });
    try {
      const get = (ip: string, headers: Record<string, string> = {}) => bh.fetch(new Request("http://x/metrics", { headers }), makeEnv(ip));
      expect((await get("127.0.0.1")).status).toBe(200);
      expect((await get("172.18.0.5")).status).toBe(200);
      expect((await get("203.0.113.9")).status).toBe(403);
      // relayed by a proxy on the host: its address is private, but it speaks for internet clients
      expect((await get("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
      expect((await get("10.0.0.2", { forwarded: "for=203.0.113.9" })).status).toBe(403);
    } finally {
      await bh.stop();
    }
  });
});

describe("npm plugin auto-discovery is opt-in", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".tmp-npm4-"));
    mkdirSync(join(dir, "node_modules", "beamhop-plugin-sneaky"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "beamhop-plugin-sneaky", "index.js"), "globalThis.__sneaky = true; export default {};");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("node_modules beamhop-plugin-* packages are only found when enabled", () => {
    const opts = { dir: join(dir, "plugins"), packages: [], cwd: dir };
    expect(discoverPlugins(opts).map((p) => p.id)).toEqual([]);
    expect(discoverPlugins({ ...opts, autoDiscoverNpm: true }).map((p) => p.id)).toEqual(["beamhop-plugin-sneaky"]);
    // listing it explicitly still works
    expect(discoverPlugins({ ...opts, packages: ["beamhop-plugin-sneaky"] }).map((p) => p.id)).toEqual(["beamhop-plugin-sneaky"]);
  });

  test("config default is off; BEAMHOP_PLUGINS_AUTO_DISCOVER turns it on", () => {
    expect(loadConfig({ cwd: dir, env: {} }).config.plugins.autoDiscoverNpm).toBe(false);
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_PLUGINS_AUTO_DISCOVER: "true" } }).config.plugins.autoDiscoverNpm).toBe(true);
  });
});
