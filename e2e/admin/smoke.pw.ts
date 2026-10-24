import type { Page } from "@playwright/test";
import { test, expect, newUser, note, ownerApi, publish, uid } from "./seed-content";

const card = (page: Page, title: string) =>
  page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${title}$`) }) });
/** the KPI tile whose label is exactly `label` */
const kpi = (page: Page, label: string) => page.locator('[data-slot="card"]').filter({ has: page.getByText(label, { exact: true }) });

test("dashboard loads for the signed-in owner with the API's numbers and its charts", async ({ page }) => {
  // some traffic of its own, so the charts have a note to show even on a fresh relay
  await publish(note(`smoke ${uid()}`, { sk: newUser().sk }));
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  // formatted the way the app formats them (same browser locale)
  const fmt = (n: number, compact: boolean) =>
    page.evaluate(([n, compact]) => new Intl.NumberFormat(undefined, compact ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(n as number), [n, compact] as const);
  // the store stats (event count, media) are refreshed once a minute server-side, so on a fresh relay they can still
  // be 0 here; the tile must show whatever the API reports. The tiles follow the live SSE snapshot, so compare against
  // the API until both agree on the same sample
  await expect(async () => {
    const { status, body: s } = await ownerApi<{ totalEvents: number; mediaCount: number }>("GET", "/dashboard/snapshot");
    expect(status).toBe(200);
    await expect(kpi(page, "Total events").locator(".text-2xl")).toHaveText(await fmt(s.totalEvents, true), { timeout: 1000 });
    await expect(kpi(page, "Media")).toContainText(`${await fmt(s.mediaCount, false)} blobs`, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  for (const label of ["Connections", "Events in /s", "REQ /s", "CPU", "Memory (RSS)", "Event loop lag"]) {
    await expect(kpi(page, label).locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(kpi(page, label).locator(".text-2xl")).toHaveText(/\d/);
  }

  await expect(card(page, "Traffic").locator(".recharts-surface").first()).toBeVisible();
  await expect(card(page, "System").locator(".recharts-surface").first()).toBeVisible();
  await expect(card(page, "Events by kind").getByText("Note")).toBeVisible();
  for (const t of ["Traffic", "System", "Events by kind"]) await expect(card(page, t).getByText("Something went wrong")).toHaveCount(0);
});
