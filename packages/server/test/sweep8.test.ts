import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssetSource, serveAdminAsset } from "../src/static";

describe("admin static: one spelling per document", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".tmp-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><script>1</script>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app-abc12345.js"), "1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const get = (sub: string) => serveAdminAsset(createAssetSource(dir), sub, new Request(`https://relay.test/admin/${sub}`));

  test("`.%2Findex.html` no longer serves the document without its headers", async () => {
    const res = (await get(".%2Findex.html"))!;
    expect(res.status).toBe(404);
    expect((await get("a%2F%2Findex.html"))!.status).toBe(404);
  });

  test("every HTML response carries CSP + framing policy and is revalidated", async () => {
    const upper = existsSync(join(dir, "INDEX.HTML")); // case-insensitive filesystem (macOS/Windows)
    for (const sub of ["", "users/abc", ...(upper ? ["INDEX.HTML"] : [])]) {
      const res = (await get(sub))!;
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("client routes containing dots fall back to the SPA; missing build assets 404", async () => {
    for (const sub of ["users/bob@example.com", "plugins/foo.bar", "p/hello/report.v2"]) {
      const res = (await get(sub))!;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    expect((await get("assets/missing.js"))!.status).toBe(404);
    expect((await get("missing.png"))!.status).toBe(404);
    expect((await get("assets/app-abc12345.js"))!.status).toBe(200);
  });
});
