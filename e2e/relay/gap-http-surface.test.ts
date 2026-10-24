/**
 * The HTTP surface around the relay that browsers and probes hit: landing page, admin SPA serving (fallback routes,
 * cache and security headers, traversal), invite page, /health, /metrics gating and admin API response headers.
 * The admin UI is served from a fixture dist (admin.uiDir) so the assertions don't depend on a UI build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "./admin-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

const INLINE = `window.__theme=localStorage.getItem("t")||"dark"`;
const INDEX = `<!doctype html><html><head><meta charset="utf-8"><script>${INLINE}</script><script type="module" src="/admin/assets/app-AbCdEf12.js"></script></head><body><div id="root">fixture-index</div></body></html>`;
const sha256b64 = (s: string) => createHash("sha256").update(s).digest("base64");

let relay: GapRelay;
let uiDir: string;
beforeAll(async () => {
  uiDir = mkdtempSync(join(tmpdir(), "beamhop-e2e-ui-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), INDEX);
  writeFileSync(join(uiDir, "assets/app-AbCdEf12.js"), "console.log('app')");
  writeFileSync(join(uiDir, "sw.js"), "self.addEventListener('fetch',()=>{})");
  writeFileSync(join(uiDir, "manifest.webmanifest"), "{}");
  writeFileSync(join(uiDir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  relay = await bootGap({ overrides: { admin: { uiDir } } });
});
afterAll(async () => {
  await relay?.stop();
  rmSync(uiDir, { recursive: true, force: true });
});

const get = (path: string, init: RequestInit = {}) => fetch(`${relay.http}${path}`, { redirect: "manual", ...init });

describe("landing page", () => {
  test("plain GET / is an HTML page with a strict CSP whose script hash matches the inline script", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("vary") ?? "").toContain("Accept");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(d);
    const html = await res.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(csp).toContain(`'sha256-${sha256b64(scripts[0])}'`);
    expect(html).toContain(`<code class="url" id="ws">ws://127.0.0.1:${relay.port}/</code>`);
    expect(html).toContain(`href="/admin/"`);
  });

  test("HEAD / answers like GET without a body", async () => {
    const res = await get("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("relay info from settings is HTML-escaped; non-http icon URLs are refused by settings", async () => {
    const name = `<b onmouseover="x">Relay & 'co'</b>`;
    const patch = await api(relay.http, relay.owner.sk, "PATCH", "/settings", {
      info: { name, description: "line1\n<script>alert(1)</script>", icon: "https://img.example/icon.png", contact: "ops@example.com" },
    });
    expect(patch.status).toBe(200);
    const bad = await api(relay.http, relay.owner.sk, "PATCH", "/settings", { info: { icon: "javascript:alert(1)" } });
    expect(bad.status).toBe(400);
    const html = await (await get("/")).text();
    expect(html).not.toContain("<b onmouseover");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;b onmouseover=&quot;x&quot;&gt;Relay &amp; &#39;co&#39;&lt;/b&gt;");
    expect(html).toContain(`<img class="icon" src="https://img.example/icon.png"`);
    expect(html).toContain("ops@example.com");
    expect(html).not.toContain("javascript:");
  });
});

describe("admin SPA serving", () => {
  test("/admin redirects to /admin/ (301) keeping the query string", async () => {
    const a = await get("/admin");
    expect(a.status).toBe(301);
    expect(new URL(a.headers.get("location")!, relay.http).pathname).toBe("/admin/");
    const b = await get("/admin?next=%2Fusers");
    expect(b.status).toBe(301);
    expect(b.headers.get("location")).toEndWith("/admin/?next=%2Fusers");
  });

  test("index.html carries CSP (hash of its inline script), DENY framing, same-origin referrer, no-cache", async () => {
    const res = await get("/admin/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture-index");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`'sha256-${sha256b64(INLINE)}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  test("client routes (including dotted ones) fall back to index.html with the same headers", async () => {
    for (const p of ["/admin/users", "/admin/users/bob@example.com", "/admin/settings/general", "/admin/content/note.html"]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await res.text()).toContain("fixture-index");
    }
  });

  test("missing build assets are 404 no-store instead of the SPA shell", async () => {
    for (const p of ["/admin/assets/gone-12345678.js", "/admin/assets/whatever", "/admin/logo.png", "/admin/fonts/x.woff2"]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("cache policy per file: hashed assets immutable, sw.js/manifest no-cache, others 1h", async () => {
    const js = await get("/admin/assets/app-AbCdEf12.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-security-policy")).toBeNull();
    const sw = await get("/admin/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(sw.headers.get("service-worker-allowed")).toBe("/admin/");
    const mf = await get("/admin/manifest.webmanifest");
    expect(mf.headers.get("content-type")).toStartWith("application/manifest+json");
    expect(mf.headers.get("cache-control")).toBe("no-cache");
    const svg = await get("/admin/favicon.svg");
    expect(svg.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("path traversal and alternate spellings never serve files outside the dist or dodge the HTML headers", async () => {
    for (const p of ["/admin/%2e%2e/%2e%2e/etc/passwd", "/admin/..%2F..%2Fe2e.db", "/admin/assets/..%2F..%2Findex.html"]) {
      const res = await get(p);
      expect([400, 403, 404]).toContain(res.status);
    }
    expect((await get("/admin/.%2Findex.html")).status).toBe(404);
    expect((await get("/admin/assets//app-AbCdEf12.js")).status).toBe(404);
    expect((await get("/admin/%E0%A4%A")).status).toBe(400);
  });

  test("non-GET methods on the SPA are not served", async () => {
    const res = await get("/admin/users", { method: "POST", body: "x" });
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("fixture-index");
  });

  test("plugin UI bundles are only served for running plugins", async () => {
    expect((await get("/admin/plugins-ui/hello.js")).status).toBe(404);
    expect((await get("/admin/plugins-ui/constructor.js")).status).toBe(404);
  });
});

describe("admin API response headers", () => {
  test("every admin API response is no-store + nosniff, including 401 and unknown routes", async () => {
    for (const [sk, path] of [
      [null, "/auth/me"],
      [relay.owner.sk, "/auth/me"],
      [relay.owner.sk, "/definitely-not-a-route"],
    ] as const) {
      const r = await api(relay.http, sk, "GET", path);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-type") ?? "").toContain("application/json");
    }
  });
});

describe("probes", () => {
  test("/health is uncached JSON with the version", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(typeof j.version).toBe("string");
  });

  test("/metrics: loopback without a token gets Prometheus text; forwarded requests are refused", async () => {
    const res = await get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toMatch(/^# (HELP|TYPE) /m);
    for (const h of ["X-Forwarded-For", "X-Real-IP", "Forwarded", "CF-Connecting-IP"]) {
      expect((await get("/metrics", { headers: { [h]: h === "Forwarded" ? "for=1.2.3.4" : "1.2.3.4" } })).status).toBe(403);
    }
  });

  test("unknown paths are a plain 404", async () => {
    const res = await get("/no/such/thing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});

describe("invite page", () => {
  test("renders with anti-framing / no-referrer / no-store and never reflects the code as markup", async () => {
    const code = `abc</script><img src=x onerror=alert(1)>`;
    const res = await get(`/invite/${encodeURIComponent(code)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("abc</script>");
    const data = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(JSON.parse(data)).toEqual({ code, redeemUrl: `${relay.http}/invite/redeem` });
  });

  test("over-long codes and GET /invite/redeem are 404", async () => {
    expect((await get(`/invite/${"a".repeat(257)}`)).status).toBe(404);
    expect((await get(`/invite/${"a".repeat(256)}`)).status).toBe(200);
    expect((await get("/invite/redeem")).status).toBe(404);
  });
});
