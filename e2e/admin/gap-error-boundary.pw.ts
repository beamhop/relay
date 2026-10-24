/** Error boundaries: a page that throws while rendering, a broken event card, and the root error screen. */
import type { Page } from "@playwright/test";
import { test, expect, note, publish, uid } from "./seed-content";

// React and the boundary itself log the caught render error on purpose
// (one regex: Playwright would read a second array element as fixture options)
const RENDER_ERRORS = [/\[beamhop\] .* crashed|The above error occurred|not iterable|Cannot read properties of null|TypeError|Objects are not valid as a React child|Minified React error/];

/**
 * /api/system with `nips: null`: the system page throws while rendering (spreads it).
 * The handler outlives the page it was meant for: a navigation (page.goto) or the end of the test aborts an
 * in-flight /api/system, and route.fetch()'s response is then disposed — res.json() throws "Response has been
 * disposed", which Playwright reports as a failure of the test. Such an aborted request has no page left to answer.
 */
async function breakSystem(page: Page) {
  await page.route("**/api/system", async (route) => {
    let json: Record<string, unknown>;
    let res: Awaited<ReturnType<typeof route.fetch>>;
    try {
      res = await route.fetch();
      json = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      if (/disposed|closed|aborted|Target page/i.test(String(e))) return;
      throw e;
    }
    await route.fulfill({ response: res, json: { ...json, nips: null } }).catch((e: unknown) => {
      if (!/disposed|closed|aborted|Target page|already handled/i.test(String(e))) throw e;
    });
  });
}

test.describe("page error boundary", () => {
  // routes mock API calls: keep the PWA service worker out, or requests it has claimed bypass page.route (seed-users fail500)
  test.use({ serviceWorkers: "block" });
  test.use({ allowConsole: RENDER_ERRORS });

  test("a page that throws shows the page-level fallback inside the shell", async ({ page }) => {
    await breakSystem(page);
    await page.goto("system");
    await expect(page.getByText("Page failed to render")).toBeVisible();
    await expect(page.getByText("is not iterable")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    // a full load of another page is unaffected (still served the broken /api/system)
    await page.goto("account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    // let an /api/system the account page still has in flight finish before the context is torn down
    await page.unrouteAll({ behavior: "wait" });
  });

  // regression: the boundary was keyed on location.pathname, which changes before the new route renders, so the
  // fresh boundary re-rendered the old crashing page and kept the fallback
  test("regression: after a page crash, client navigation to another page renders that page", async ({ page }) => {
    await breakSystem(page);
    await page.goto("system");
    const fallback = page.getByText("Page failed to render");
    await expect(fallback).toBeVisible();
    await expect(page.getByText(/not iterable|null/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // the shell (navigation) is still there and usable
    const nav = page.locator('[data-slot="sidebar"]');
    await nav.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(fallback).toHaveCount(0);
    await nav.getByRole("link", { name: "Account", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await expect(fallback).toHaveCount(0);
  });

  // regression: Retry only cleared its state; the bad response stayed cached (system staleTime 5 min)
  test("regression: Retry in the page boundary refetches instead of re-rendering the cached bad response", async ({ page }) => {
    await breakSystem(page);
    await page.goto("system");
    await expect(page.getByText("Page failed to render")).toBeVisible();
    await page.unroute("**/api/system");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
  });

  test("an event whose content can't render shows a placeholder card, not a broken page", async ({ page }) => {
    const id = uid();
    const ok = note(`fine ${id}`);
    const bad = note(`bad ${id}`);
    await publish(ok, bad);
    // a malformed event (content not a string) in the content API response
    await page.route(/\/api\/events\/query/, async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      for (const v of json.items ?? []) if (v.event.id === bad.id) v.event.content = { not: "a string" };
      return route.fulfill({ response: res, json });
    });
    await page.goto(`content?f=${encodeURIComponent(JSON.stringify(JSON.stringify({ ids: [ok.id, bad.id] })))}`);
    await expect(page.getByText(`fine ${id}`)).toBeVisible();
    // the card's or the content's own boundary catches it; either way the rest of the list renders
    await expect(page.getByText(/This event(’s content)? can’t be displayed/)).toHaveCount(1);
    await expect(page.getByText(`bad ${id}`)).toHaveCount(0);
    await expect(page.getByText("Page failed to render")).toHaveCount(0);
  });
});

test.describe("root error screen", () => {
  test.use({ serviceWorkers: "block" });
  // the router logs the failed beforeLoad as well
  test.use({ allowConsole: [/status of 500|HttpError: db down/] });

  test("a failing /auth/me (not 401) shows “Can’t load the admin panel”; Retry recovers", async ({ page }) => {
    await page.route("**/api/auth/me", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"db down"}' }));
    await page.goto("users");
    await expect(page.getByText("Can’t load the admin panel")).toBeVisible();
    await expect(page.getByText("db down")).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await page.unroute("**/api/auth/me");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
  });
});
