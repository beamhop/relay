/** Phone (Pixel 7, touch): no horizontal page overflow on any route, with the bottom nav and More drawer open. */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { uniq } from "./auth-support";

test.skip(({ isMobile }) => !isMobile, "phone layout only");

const ROUTES = ["./", "live", "users", "admins", "invites", "ip-rules", "content", "reports", "media", "groups", "settings", "plugins", "audit", "system", "account"];

const overflow = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);

for (const r of ROUTES) {
  test(`${r === "./" ? "dashboard" : r}: fits the phone width`, async ({ page }) => {
    await page.goto(r);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0);
  });
}

test("the More drawer and a 404 fit the phone width", async ({ page }) => {
  await page.goto(`nope-${uniq()}`);
  await expect(page.getByText("Page not found")).toBeVisible();
  await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0);
  await page.goto("./");
  await page.getByRole("button", { name: "More" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0);
});
