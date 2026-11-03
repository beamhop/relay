/**
 * Response hardening of the HTML-ish public surfaces that share the admin panel's origin: the invite page runs only its
 * own hashed script, and plugin public routes can't run script (or be framed) unless the plugin opts in with a policy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { api } from "./admin-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

const PLUGINS = join(import.meta.dir, "../../plugins");
let relay: GapRelay;
beforeAll(async () => {
  relay = await bootGap({
    overrides: { plugins: { packages: [join(PLUGINS, "hello")] } },
    extras: { pluginsEnabled: ["hello"] },
  });
}, 30_000);
afterAll(() => relay?.stop(true));

describe("invite page", () => {
  test("has a CSP that allows exactly its inline script and only connects to the relay", async () => {
    const r = await api(relay.http, relay.owner.sk, "POST", "/invites", {});
    expect(r.status).toBe(201);
    // a hostile-looking code still renders inert
    for (const code of [r.body.code as string, `"><script>alert(1)</script>`]) {
      const res = await fetch(`${relay.http}/invite/${encodeURIComponent(code)}`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain(`connect-src 'self' ${relay.http}`);
      expect(csp).not.toContain("unsafe-inline'; script");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const html = await res.text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(scripts.length).toBe(1);
      const hash = `'sha256-${createHash("sha256").update(scripts[0]).digest("base64")}'`;
      expect(csp).toContain(`script-src ${hash}`);
      expect(html).not.toContain("<script>alert(1)");
    }
  });
});

describe("plugin public routes", () => {
  test("responses without their own policy are sandboxed, unframeable and nosniff", async () => {
    for (const path of ["/plugins/hello/ping", "/plugins/hello/", "/plugins/hello/does-not-exist"]) {
      const res = await fetch(`${relay.http}${path}`);
      expect([path, res.headers.get("content-security-policy")]).toEqual([path, "default-src 'none'; frame-ancestors 'none'; sandbox"]);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(await (await fetch(`${relay.http}/plugins/hello/ping`)).text()).toBe("pong");
  });
});
