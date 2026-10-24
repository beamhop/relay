/** System page against the API and NIP-11; PWA manifest, icons and service worker registration. */
import { nip19 } from "nostr-tools";
import { test, expect, owner } from "./fixtures";

// these specs exercise the PWA service worker (blocked by default in playwright.config.ts)
test.use({ serviceWorkers: "allow" });

const row = (page: import("@playwright/test").Page, label: string) => page.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");

test.describe("system page", () => {
  test("instance rows match /api/system", async ({ page }) => {
    const s = await (await page.request.get("api/system")).json();
    await page.goto("system");
    await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
    await expect(row(page, "Name")).toHaveText(s.name);
    await expect(row(page, "Version")).toHaveText(s.version);
    await expect(row(page, "Runtime")).toHaveText(`${s.runtime} ${s.runtimeVersion}`);
    await expect(row(page, "Database")).toHaveText(s.dbDialect);
    await expect(row(page, "Public URL").getByRole("link")).toHaveAttribute("href", s.publicUrl);
    await expect(row(page, "Relay pubkey").locator("code")).toHaveText(nip19.npubEncode(s.relayPubkey));
    await expect(row(page, "Uptime")).not.toBeEmpty();
    await expect(row(page, "Live stream")).toHaveText(/\S/);
    // features: enabled ones are not muted
    for (const [label, on] of [["Blossom media", s.blossomEnabled], ["GeoIP", s.geoipEnabled], ["OpenTelemetry", s.otelEnabled], ["Web push", s.pushEnabled]] as const) {
      const el = page.locator('[data-slot="card"]').filter({ hasText: "Features" }).getByText(label, { exact: true });
      if (on) await expect(el).not.toHaveClass(/text-muted-foreground/);
      else await expect(el).toHaveClass(/text-muted-foreground/);
    }
  });

  test("supported NIPs equal the NIP-11 document, sorted, each linking to its spec", async ({ page }) => {
    const info = await (await fetch(owner().http, { headers: { Accept: "application/nostr+json" } })).json();
    const nips: number[] = [...info.supported_nips].sort((a: number, b: number) => a - b);
    expect(nips.length).toBeGreaterThan(5);
    await page.goto("system");
    const card = page.locator('[data-slot="card"]').filter({ hasText: "Supported NIPs" });
    const links = card.getByRole("link");
    await expect(links).toHaveCount(nips.length);
    const shown = await links.evaluateAll((els) => els.map((e) => [e.textContent ?? "", e.getAttribute("href") ?? ""]));
    shown.forEach(([text, href], i) => {
      const n = String(nips[i]).padStart(2, "0");
      expect(text.startsWith(`NIP-${n}`), text).toBe(true);
      expect(href).toBe(`https://github.com/nostr-protocol/nips/blob/master/${n}.md`);
    });
  });

  test("the live process card shows metrics once the stream connects", async ({ page }) => {
    await page.goto("system");
    const proc = page.locator('[data-slot="card"]').filter({ hasText: "Process" });
    await expect(proc).toBeVisible({ timeout: 15_000 });
    for (const m of ["CPU", "Memory", "Loop lag", "p95 latency"]) await expect(proc.getByText(m, { exact: true })).toBeVisible();
    await expect(proc).toContainText(/\d/);
  });
});

test.describe("PWA", () => {
  test("the manifest is linked, valid, and every icon is served", async ({ page }) => {
    await page.goto("./");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBeTruthy();
    const url = new URL(href!, page.url()).toString();
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.name).toBeTruthy();
    expect(m.start_url).toBe("/admin/");
    expect(m.scope).toBe("/admin/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i); // the page's own meta follows the light/dark theme instead
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.icons.some((i: { purpose?: string }) => i.purpose?.includes("maskable"))).toBe(true);
    for (const icon of m.icons) {
      const r = await page.request.get(new URL(icon.src, url).toString());
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"], icon.src).toContain(icon.type);
    }
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    expect((await page.request.get(new URL(apple!, page.url()).toString())).status()).toBe(200);
  });

  test("the service worker registers for the /admin/ scope and takes control", async ({ page }) => {
    await page.goto("./");
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { scope: r.scope, script: r.active?.scriptURL ?? "" };
    });
    expect(new URL(reg.scope).pathname).toBe("/admin/");
    expect(new URL(reg.script).pathname).toBe("/admin/sw.js");
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller != null, null, { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });
});
