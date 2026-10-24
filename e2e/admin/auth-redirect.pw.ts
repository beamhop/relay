import { randomBytes } from "node:crypto";
import { test, expect, owner } from "./fixtures";
import { openPalette, SIGNED_OUT, appHref, ownSession, signInWithKey } from "./auth-support";

test.use({ storageState: SIGNED_OUT });

const origin = () => new URL(owner().http).origin;
/** the router stores string search params JSON-encoded: ?f="{\"ids\":[…]}" */
const filterOf = (url: string) => JSON.parse(JSON.parse(new URL(url).searchParams.get("f")!));

test.describe("deep links while signed out", () => {
  test("/reports?status=dismissed → login → back to the same path and query", async ({ page }) => {
    await page.goto("reports?status=dismissed");
    await expect(page).toHaveURL(/\/admin\/login\?redirect=/);
    expect(new URL(page.url()).searchParams.get("redirect")).toBe("/reports?status=dismissed");
    await signInWithKey(page, owner().nsec);
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    expect(appHref(page)).toBe("/reports?status=dismissed");
    await expect(page.getByText(/^\d+ dismissed reports?$/)).toBeVisible();
  });

  test("/content?f=<json filter> keeps its encoded query through login", async ({ page }) => {
    const filter = { kinds: [1, 7], limit: 5 };
    await page.goto(`content?f=${encodeURIComponent(JSON.stringify(JSON.stringify(filter)))}`);
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await signInWithKey(page, owner().nsec);
    await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/admin/content");
    expect(filterOf(page.url())).toEqual(filter);
  });

  test("the dashboard root redirects without a redirect param", async ({ page }) => {
    await page.goto("./");
    await expect(page).toHaveURL(/\/admin\/login$/);
    await signInWithKey(page, owner().nsec);
    await expect(page).toHaveURL(/\/admin\/$/);
  });

  test("nested paths (settings section) survive the round trip", async ({ page }) => {
    await page.goto("settings/limits");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Flimits/);
    await signInWithKey(page, owner().nsec);
    await expect(page.getByText("Message sizes, subscription limits and rate limits")).toBeVisible();
    expect(appHref(page)).toBe("/settings/limits");
  });
});

test.describe("redirect param is restricted to same-origin app paths", () => {
  for (const evil of ["//evil.example", "https://evil.example/x", "javascript:alert(1)", "/login?redirect=/users", "/login"]) {
    test(`redirect=${evil} falls back to the dashboard`, async ({ page }) => {
      await page.goto(`login?redirect=${encodeURIComponent(evil)}`);
      await signInWithKey(page, owner().nsec);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      expect(new URL(page.url()).origin).toBe(origin());
      expect(new URL(page.url()).pathname).toBe("/admin/");
    });
  }
});

test("redirect=/\\evil.example stays on this origin", async ({ page }) => {
  // browsers read "/\\host" as "//host"; the app must not turn it into a cross-origin navigation
  await page.goto(`login?redirect=${encodeURIComponent("/\\evil.example")}`);
  await signInWithKey(page, owner().nsec);
  await expect(page.getByText("Page not found").or(page.getByRole("heading", { level: 1, name: "Dashboard" }))).toBeVisible();
  expect(new URL(page.url()).origin).toBe(origin());
  expect(new URL(page.url()).pathname.startsWith("/admin/")).toBe(true);
});

test.describe("session expiry mid-use", () => {
  test("a 401 on client navigation sends you to login with the target path + query, then back", async ({ page, context }) => {
    await ownSession(page, "users");
    await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
    await context.clearCookies();

    // client-side navigation that issues a fresh API request: palette → find event by id
    const id = randomBytes(32).toString("hex");
    await (await openPalette(page)).fill(id);
    await page.getByRole("option", { name: /Find event/ }).click();

    await expect(page).toHaveURL(/\/login\?redirect=/);
    const redirect = new URL(page.url()).searchParams.get("redirect")!;
    expect(redirect.startsWith("/content?f=")).toBe(true);
    await signInWithKey(page, owner().nsec);
    await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
    expect(filterOf(page.url())).toEqual({ ids: [id] });
  });

  test("an expired cookie on reload redirects with the query kept", async ({ page, context }) => {
    await ownSession(page, "reports?status=dismissed");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await context.clearCookies();
    await page.reload();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    expect(new URL(page.url()).searchParams.get("redirect")).toBe("/reports?status=dismissed");
  });

  test("a server-side revoked session is detected on the next request", async ({ page }) => {
    await ownSession(page, "audit");
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    // log this session out behind the app's back (same cookie, other request context)
    expect((await page.request.post("api/auth/logout", { headers: { "X-Requested-With": "beamhop" } })).status()).toBe(200);
    await page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Invites", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?redirect=%2Finvites/);
  });
});
