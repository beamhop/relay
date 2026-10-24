import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EventBus, HookRegistry, RuntimeSettingsSchema, createLogger, maskSecretValues, type BeamhopPlugin } from "@beamhop/sdk";
import { z } from "zod";
import { loadConfig } from "../src/config";
import { LANDING_CSP, renderLanding, safeHttpUrl } from "../src/landing";
import { createPluginManager } from "../src/plugins/manager";
import { clientIp } from "../src/runtime/common";
import { adminCsp, createAssetSource, serveAdminAsset } from "../src/static";
import { stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";

describe("landing page: settings URLs can't inject script (A2)", () => {
  const base = RuntimeSettingsSchema.parse({});
  const render = (info: Partial<typeof base.info>) =>
    renderLanding({ settings: { ...base, info: { ...base.info, ...info } }, publicUrl: "https://relay.test", nip11: {}, version: "1", blossom: true, admin: true });

  test("non-http(s) URLs are dropped at render time", () => {
    const html = render({
      termsOfService: "javascript:fetch('/admin/api/me')",
      postingPolicy: " JaVaScRiPt:alert(1)",
      icon: "data:image/svg+xml,<svg onload=alert(1)>",
      banner: "x'); background:url('https://evil.test/track",
    });
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("evil.test");
    expect(html).not.toContain("onclick");
  });

  test("http(s) URLs render; banner is an <img>, not CSS", () => {
    const html = render({ termsOfService: "https://relay.test/tos", banner: "https://img.test/b.png", icon: "https://img.test/i.png" });
    expect(html).toContain('href="https://relay.test/tos"');
    expect(html).toContain('<img class="banner" src="https://img.test/b.png"');
    expect(html).not.toContain("background-image");
  });

  test("CSP allows exactly the inline copy script", () => {
    const html = render({});
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const hash = createHash("sha256").update(script).digest("base64");
    expect(LANDING_CSP).toContain(`script-src 'sha256-${hash}'`);
    expect(LANDING_CSP).toContain("default-src 'none'");
    expect(LANDING_CSP).not.toContain("unsafe-inline' 'sha");
  });

  test("the settings schema rejects non-http(s) URLs", () => {
    expect(RuntimeSettingsSchema.safeParse({ info: { termsOfService: "javascript:alert(1)" } }).success).toBe(false);
    expect(RuntimeSettingsSchema.safeParse({ info: { banner: "data:image/png;base64,AAAA" } }).success).toBe(false);
    expect(RuntimeSettingsSchema.safeParse({ info: { icon: "https://x.test/i.png", postingPolicy: "" } }).success).toBe(true);
    expect(safeHttpUrl("ftp://x")).toBeUndefined();
  });
});

describe("admin SPA CSP", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-csp-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("inline scripts of index.html are allowed by hash, nothing else inline", async () => {
    const theme = "\n  (function(){document.documentElement.classList.add('dark')})();\n";
    const importmap = '{"imports":{"react":"/admin/plugin-shims/react.js"}}';
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><head><script>${theme}</script><script type="importmap">${importmap}</script><script type="module" crossorigin src="/admin/assets/index.js"></script></head><body></body></html>`,
    );
    const res = await serveAdminAsset(createAssetSource(dir), "users/abc", new Request("https://relay.test/admin/users/abc"));
    const csp = res!.headers.get("content-security-policy")!;
    const h = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
    expect(csp).toContain(`script-src 'self' ${h(theme)} ${h(importmap)}`);
    expect(csp).not.toContain("unsafe-inline' ;");
    expect(csp.split(";").find((d) => d.trim().startsWith("script-src"))).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // assets don't carry the document CSP
    writeFileSync(join(dir, "app.js"), "1");
    expect((await serveAdminAsset(createAssetSource(dir), "app.js", new Request("https://relay.test/admin/app.js")))!.headers.get("content-security-policy")).toBeNull();
    expect(adminCsp("<script src=x></script>")).toContain("script-src 'self';");
  });
});

describe("client ip: explicit proxy header (B4)", () => {
  const hdr = (m: Record<string, string>) => (n: string) => m[n];
  test("default: rightmost X-Forwarded-For wins over a client-sent X-Real-IP", () => {
    expect(clientIp("10.0.0.2", hdr({ "x-forwarded-for": "6.6.6.6, 198.51.100.23", "x-real-ip": "1.1.1.1" }), true)).toBe("198.51.100.23");
  });
  test("proxyIpHeader=x-real-ip ignores a passed-through X-Forwarded-For", () => {
    expect(clientIp("10.0.0.2", hdr({ "x-real-ip": "198.51.100.23", "x-forwarded-for": "6.6.6.6" }), true, "x-real-ip")).toBe("198.51.100.23");
    expect(clientIp("10.0.0.2", hdr({ "cf-connecting-ip": "2001:db8::1" }), true, "CF-Connecting-IP")).toBe("2001:db8::1");
  });
  test("non-IP header values fall back to the socket address", () => {
    expect(clientIp("10.0.0.2", hdr({ "x-forwarded-for": "<img src=x>" }), true)).toBe("10.0.0.2");
    expect(clientIp("10.0.0.2", hdr({ "x-real-ip": "evil" }), true, "x-real-ip")).toBe("10.0.0.2");
  });
});

describe("config (B4/B12)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-cfg2-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("BEAMHOP_PROXY_IP_HEADER", () => {
    expect(loadConfig({ cwd: dir, env: {} }).config.server.proxyIpHeader).toBe("x-forwarded-for");
    expect(loadConfig({ cwd: dir, env: { BEAMHOP_PROXY_IP_HEADER: " X-Real-IP " } }).config.server.proxyIpHeader).toBe("x-real-ip");
  });

  test("the example metrics token placeholder disables /metrics instead of protecting it (no crash loop)", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const t of ["change-me", "REPLACE-WITH-A-LONG-RANDOM-TOKEN"]) {
        const { extras } = loadConfig({ cwd: dir, env: { BEAMHOP_METRICS_TOKEN: t } });
        expect(extras.prometheus).toBe(false);
        expect(extras.metricsToken).toBeUndefined();
      }
      writeFileSync(join(dir, "beamhop.config.json"), JSON.stringify({ server: { metricsToken: "change-me" } }));
      expect(loadConfig({ cwd: dir, env: {} }).extras.prometheus).toBe(false);
      expect(errSpy.mock.calls.some((c) => /placeholder.*DISABLED/.test(String(c[0])))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    const ok = loadConfig({ cwd: dir, env: { BEAMHOP_METRICS_TOKEN: "a".repeat(40) } }).extras;
    expect(ok.metricsToken).toBe("a".repeat(40));
    expect(ok.prometheus).toBe(true);
  });

  test("blossom upload limits come from config / BEAMHOP_BLOSSOM_* env", () => {
    const { config } = loadConfig({
      cwd: dir,
      env: {
        BEAMHOP_BLOSSOM_MAX_UPLOADS_PER_IP: "16",
        BEAMHOP_BLOSSOM_MAX_BUFFERED_UPLOAD_BYTES: "1073741824",
        BEAMHOP_BLOSSOM_MIRROR_PORTS: "80,443,8443",
        BEAMHOP_BLOSSOM_MIRROR_TIMEOUT_MS: "120000",
      },
    });
    expect(config.blossom.limits?.maxConcurrentUploadsPerIp).toBe(16);
    expect(config.blossom.limits?.maxBufferedUploadBytes).toBe(1073741824);
    expect(config.blossom.limits?.mirrorPorts).toEqual([80, 443, 8443]);
    expect(config.blossom.limits?.mirrorTimeoutMs).toBe(120000);
  });
});

const redact = (v: unknown) => (v === undefined || v === null || v === "" ? v : "[redacted]");

describe("plugin settings never reach the audit log in cleartext", () => {
  test("the shared secret walker: schema hints and key names, at any depth", () => {
    const schema = {
      type: "object",
      properties: {
        webhook: { type: "object", properties: { url: { type: "string" }, signing: { type: "string", format: "password" } } },
        list: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string", writeOnly: true } } } },
      },
    };
    const out = maskSecretValues(
      {
        webhook: { url: "https://h.test", signing: "s1" },
        list: [{ label: "a", value: "v1" }],
        s3: { bucket: "b", secretAccessKey: "s2" },
        apiKey: "k",
        nested: { deeper: { authToken: "t", private_key: "p", ok: 1 } },
        emptySecret: "",
      },
      schema,
      redact,
    );
    expect(out).toEqual({
      webhook: "[redacted]", // a webhook URL is itself a credential, so the whole entry is redacted
      list: [{ label: "a", value: "[redacted]" }],
      s3: { bucket: "b", secretAccessKey: "[redacted]" },
      apiKey: "[redacted]",
      nested: { deeper: { authToken: "[redacted]", private_key: "[redacted]", ok: 1 } },
      emptySecret: "",
    });
  });

  test("updateSettings stores the real values and leaves auditing (masked) to the admin API", async () => {
    const plugin: BeamhopPlugin = {
      name: "secrets",
      version: "1.0.0",
      settings: z.object({ endpoint: z.string().default(""), creds: z.object({ user: z.string().default(""), password: z.string().default("") }).prefault({}) }),
      async setup() {},
    };
    const stores = stubStores();
    const pm = createPluginManager({
      config: testConfig(), stores, settings: stubSettings(), hooks: new HookRegistry(), bus: new EventBus(), logger: createLogger("error"),
      relay: stubRelay(), metrics: stubMetrics(), plugins: [{ plugin }],
    });
    await pm.start();
    const saved = await pm.updateSettings("secrets", { endpoint: "https://e.test", creds: { user: "u", password: "hunter2" } }, "admin1");
    expect((saved as { creds: { password: string } }).creds.password).toBe("hunter2");
    // one audit record per change, written by the admin API route (see admin-api security-round2); none here
    expect(stores.auditEntries.filter((e) => e.action === "plugin.settings")).toEqual([]);
    expect(JSON.stringify(stores.auditEntries)).not.toContain("hunter2");
    await pm.stop();
  });
});
