import type { Page } from "@playwright/test";
import { test, expect, ALLOW_500 } from "./seed-content";
import { newUser, note, publish, sign, uid, withWs } from "./seed-content";

const card = (page: Page, title: string) =>
  page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${title}$`) }) });

const CHART_CARDS = ["Traffic", "System", "Events by kind", "World", "Top publishers", "Rejection reasons"];
const EMPTY_TEXTS = ["No data for this range yet", "No activity yet", "Nothing rejected", "No geo data", "No located connections"];

/** some accepted traffic from a fresh user, plus one rejected event (created_at too far in the future) */
async function seedTraffic() {
  const u = newUser();
  const id = uid();
  await publish(note(`dash ${id}`, { sk: u.sk }), note(`dash2 ${id}`, { sk: u.sk }), sign(u.sk, { kind: 7, content: "+", tags: [] }));
  const bad = sign(u.sk, { kind: 1, content: `future ${id}`, created_at: Math.floor(Date.now() / 1000) + 7200 });
  const r = await withWs((ws) => ws.publish(bad));
  expect(r.ok).toBe(false);
  return { u, reason: r.message };
}

test.describe("dashboard", () => {
  test("every card renders with data", async ({ page }) => {
    await seedTraffic();
    await page.goto("./");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    for (const k of ["Connections", "Events in /s", "REQ /s", "Total events", "Database", "Media", "CPU", "Memory (RSS)", "Event loop lag"]) {
      const c = page.locator('[data-slot="card"]').filter({ hasText: k }).first();
      await expect(c).toBeVisible();
      await expect(c.locator('[data-slot="skeleton"]')).toHaveCount(0);
      await expect(c).toContainText(/\d/);
    }
    await expect(card(page, "Traffic").locator(".recharts-surface").first()).toBeVisible();
    await expect(card(page, "Traffic").getByText("Events in")).toBeVisible();
    await expect(card(page, "System").locator(".recharts-surface").first()).toBeVisible();
    await expect(card(page, "Events by kind").getByText("Note")).toBeVisible();
    await expect(card(page, "Events by kind").getByText("Reaction")).toBeVisible();
    await expect(card(page, "Top publishers").getByRole("row")).not.toHaveCount(0);
    await expect(card(page, "Top publishers").getByRole("columnheader", { name: "Rejected" })).toBeVisible();
    await expect(card(page, "Rejection reasons").locator("li").first()).toBeVisible();
    // this relay has no GeoIP database: the world card says so instead of drawing a map
    await expect(card(page, "World").getByText("No geo data. Configure a GeoIP database to enable.")).toBeVisible();
    for (const t of CHART_CARDS) await expect(card(page, t).getByText("Something went wrong")).toHaveCount(0);
  });

  test("Events by kind switches between bar and pie", async ({ page }) => {
    await seedTraffic();
    await page.goto("./");
    const c = card(page, "Events by kind");
    await expect(c.locator(".recharts-bar-rectangle").first()).toBeVisible();
    await c.getByRole("radio", { name: "Pie" }).click();
    await expect(c.locator(".recharts-pie").first()).toBeVisible();
    await expect(c.locator(".recharts-bar-rectangle")).toHaveCount(0);
  });

  test("the range toggle refetches every metric for the new range", async ({ page }) => {
    await page.goto("./");
    await expect(card(page, "Top publishers").getByText("last 24 hours")).toBeVisible();
    const req = page.waitForRequest((r) => r.url().includes("/admin/api/metrics/top-pubkeys") && /from=\d+/.test(r.url()));
    await page.getByRole("radio", { name: "7d" }).click();
    const url = new URL((await req).url());
    expect(Number(url.searchParams.get("to")) - Number(url.searchParams.get("from"))).toBe(7 * 86400);
    await expect(card(page, "Top publishers").getByText("last 7 days")).toBeVisible();
    await expect(card(page, "Traffic").getByText("last 7 days")).toBeVisible();
  });

  test.describe("when the metrics API fails", () => {
    test.use({ allowConsole: ALLOW_500 });

    test("each card shows an error with Retry instead of an empty all-good state", async ({ page }) => {
      await seedTraffic();
      await page.route("**/admin/api/metrics/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "metrics down" }) }));
      await page.goto("./");
      for (const t of CHART_CARDS) {
        const c = card(page, t);
        await expect(c.getByText("Something went wrong")).toBeVisible({ timeout: 15_000 });
        await expect(c.getByText("metrics down")).toBeVisible();
        await expect(c.getByRole("button", { name: "Try again" })).toBeVisible();
        for (const e of EMPTY_TEXTS) await expect(c.getByText(e)).toHaveCount(0);
      }
      // KPIs come from the live snapshot, not /metrics: they keep working
      await expect(page.locator('[data-slot="card"]').filter({ hasText: "Total events" }).first()).toContainText(/\d/);
    });

    test("Try again recovers a card once the API is back", async ({ page }) => {
      await seedTraffic();
      let failing = true;
      await page.route("**/admin/api/metrics/**", (r) =>
        failing ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "metrics down" }) }) : r.continue(),
      );
      await page.goto("./");
      const c = card(page, "Rejection reasons");
      await expect(c.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 15_000 });
      failing = false;
      await c.getByRole("button", { name: "Try again" }).click();
      await expect(c.locator("li").first()).toBeVisible();
      await expect(c.getByText("Something went wrong")).toHaveCount(0);
      // the others still show their error until retried
      await expect(card(page, "Top publishers").getByRole("button", { name: "Try again" })).toBeVisible();
      await card(page, "Top publishers").getByRole("button", { name: "Try again" }).click();
      await expect(card(page, "Top publishers").getByRole("row").first()).toBeVisible();
    });
  });
});
