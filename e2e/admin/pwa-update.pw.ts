/** A deploy while the panel is open: the new service worker takes over and the tab offers a reload to the new version. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";

test.use({ serviceWorkers: "allow" });

// the relay serves the built panel from disk on every request, so rewriting sw.js is what a deploy looks like to a tab
const SW = fileURLToPath(new URL("../../packages/admin-ui/dist/sw.js", import.meta.url));

test("a new service worker version shows the reload prompt; Reload loads the page under the new worker", async ({ page }) => {
  await page.goto("./");
  await page.waitForFunction(() => navigator.serviceWorker.controller != null, null, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  const original = readFileSync(SW, "utf8");
  try {
    writeFileSync(SW, `${original}\n// deploy ${Date.now()}\n`);
    // the panel checks for a new version whenever the tab becomes visible again
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const prompt = page.locator("[data-sonner-toast]").filter({ hasText: "New version available" });
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await expect(prompt.getByText("Reload to use the updated admin panel.")).toBeVisible();

    await prompt.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(prompt).toHaveCount(0);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated");
  } finally {
    writeFileSync(SW, original);
  }
});
