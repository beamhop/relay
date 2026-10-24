import { nip19 } from "nostr-tools";
import { test, expect, owner } from "./fixtures";
import { freshPage, openPalette, toast } from "./auth-support";
import { stateFile } from "./fixtures";

// these specs exercise the PWA service worker (blocked by default in playwright.config.ts)
test.use({ serviceWorkers: "allow" });

const html = (page: import("@playwright/test").Page) => page.locator("html");

test.describe("theme", () => {
  test.use({ colorScheme: "light" });

  test("user menu theme switch applies and survives a reload", async ({ page }) => {
    await page.goto("./");
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await page.locator('[data-slot="sidebar"]').getByRole("button", { name: /owner/ }).click();
    await page.getByRole("menuitem", { name: "Theme" }).hover();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    expect(await page.evaluate(() => localStorage.getItem("beamhop-theme"))).toBe("dark");
  });

  test("palette and account page switch theme; System follows the OS setting", async ({ page }) => {
    await page.goto("account");
    await (await openPalette(page)).fill("dark");
    await page.getByRole("option", { name: "Dark theme", exact: true }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("data-state", "on");

    await page.getByRole("radio", { name: "Light" }).click();
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await page.getByRole("radio", { name: "System" }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await page.reload();
    await expect(page.getByRole("radio", { name: "System" })).toHaveAttribute("data-state", "on");
  });
});

// cmdk matches the item's `value` ("theme dark"), not its label, so typing the label as shown finds nothing
test("regression: command palette finds 'Dark theme' by its label", async ({ page }) => {
  await page.goto("./");
  await (await openPalette(page)).fill("dark theme");
  await expect(page.getByRole("option", { name: "Dark theme", exact: true })).toBeVisible();
});

test.describe("blocked storage", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const boom = () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      };
      Object.defineProperty(window, "localStorage", { configurable: true, get: boom });
      Object.defineProperty(window, "sessionStorage", { configurable: true, get: boom });
    });
  });

  test("the app renders and works when localStorage access throws", async ({ page }) => {
    await page.goto("./");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
    // theme still switches for this page's lifetime
    await (await openPalette(page)).fill("dark");
    await page.getByRole("option", { name: "Dark theme", exact: true }).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
  });

  test("the account page (theme, privacy and push prefs read storage) renders", async ({ page }) => {
    await page.goto("account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await expect(page.getByText("Notifications", { exact: true })).toBeVisible();
    const remote = page.getByRole("switch", { name: /Load remote images and video/ });
    await remote.click();
    await expect(remote).toHaveAttribute("data-state", "checked");
  });

  test("the login page renders when localStorage throws", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL!);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new DOMException("blocked", "SecurityError"); } });
    });
    await page.goto("login");
    await expect(page.getByText("Sign in to manage your relay")).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });
});

test.describe("copy buttons", () => {
  test("copies the npub with the async clipboard API", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("account");
    const npub = nip19.npubEncode(owner().pubkey);
    await expect(page.getByText(npub)).toBeVisible();
    await page.getByRole("button", { name: "Copy", exact: true }).first().click();
    await expect(toast(page, "Copied to clipboard")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(npub);
  });

  test("falls back to execCommand when navigator.clipboard is undefined", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => undefined });
      const w = window as unknown as { __copied?: string };
      const orig = document.execCommand.bind(document);
      document.execCommand = (cmd: string, ...rest: unknown[]) => {
        if (cmd === "copy") w.__copied = (document.querySelector("textarea[readonly]") as HTMLTextAreaElement | null)?.value;
        return (orig as (...a: unknown[]) => boolean)(cmd, ...rest);
      };
    });
    await page.goto("account");
    expect(await page.evaluate(() => navigator.clipboard)).toBeUndefined();
    await page.getByRole("button", { name: "Copy", exact: true }).first().click();
    await expect(toast(page, "Copied to clipboard")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(nip19.npubEncode(owner().pubkey));
    // the helper textarea is cleaned up
    await expect(page.locator("textarea[readonly]")).toHaveCount(0);
  });

  test("reports an error when no clipboard is available at all", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => undefined });
      document.execCommand = () => false;
    });
    await page.goto("account");
    await page.getByRole("button", { name: "Copy", exact: true }).first().click();
    await expect(toast(page, "Clipboard not available")).toBeVisible();
  });
});

test.describe("service worker / offline", () => {
  test("API responses are never cached and offline navigations get the offline page", async ({ browser, baseURL }) => {
    // own context: going offline makes the live stream log network errors, which the console guard would flag
    const { context, page } = await freshPage(browser, baseURL!, { storageState: stateFile });
    await page.goto("./");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 });
    // a controlled page loads data through the worker
    await page.goto("system");
    await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();

    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(r.url);
      return urls;
    });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.filter((u) => new URL(u).pathname.startsWith("/admin/api/"))).toEqual([]);

    await context.setOffline(true);
    const api = await page.evaluate(() => fetch("/admin/api/system", { credentials: "include" }).then((r) => `status ${r.status}`, () => "network error"));
    expect(api).toBe("network error");
    await page.goto("users");
    await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("link", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
    await context.close();
  });

  test("a signed-out offline reload does not show cached admin data", async ({ browser, baseURL }) => {
    const { context, page } = await freshPage(browser, baseURL!, { storageState: stateFile });
    await page.goto("system");
    await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 });
    await context.clearCookies();
    await page.reload();
    // the API is network-only: without a session the app must ask for a login, not render the old data
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsystem/);
    await expect(page.getByText("Runtime information about this beamhop instance")).toHaveCount(0);
    await context.close();
  });
});
