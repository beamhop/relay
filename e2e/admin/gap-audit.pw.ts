/** Audit log page: entries from real actions, filters (form, badge and target clicks), details, pagination. */
import type { Page } from "@playwright/test";
import { newUser } from "../harness/client";
import { test, expect } from "./fixtures";
import { appHref, makeAdmin, ownerApi, uniq, type TestAdmin } from "./auth-support";

const rows = (page: Page) => page.locator('[data-slot="card"] > div.border-b');
const actorBox = (page: Page) => page.getByPlaceholder(/^Actor/);
const actionBox = (page: Page) => page.getByPlaceholder(/^Action/);
const targetBox = (page: Page) => page.getByPlaceholder("Target");

/** n user.update entries by `admin`, each on a fresh target; returns the targets oldest first */
async function patchUsers(admin: TestAdmin, n: number, notes = uniq("note")) {
  const targets: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = newUser().pubkey;
    const r = await admin.api("PATCH", `/users/${t}`, { notes: `${notes}-${i}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    targets.push(t);
  }
  return targets;
}

test.describe("audit log", () => {
  test("an IP rule added in the UI is logged with its target and details", async ({ page }) => {
    const ip = `198.19.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
    const reason = uniq("audit-reason");
    try {
      await page.goto("ip-rules");
      await page.getByRole("button", { name: "Add rule" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("IP or CIDR").fill(ip);
      await dialog.getByLabel("Reason").fill(reason);
      await dialog.getByRole("button", { name: "Add rule" }).click();
      await expect(dialog).toHaveCount(0);

      await page.goto(`audit?target=${encodeURIComponent(ip)}`);
      await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
      await expect(targetBox(page)).toHaveValue(ip);
      await expect(rows(page)).toHaveCount(1);
      const row = rows(page).first();
      await expect(row.getByText("ip.add", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: ip })).toBeVisible();
      // details are collapsed until asked for
      await expect(row.getByText(reason)).toHaveCount(0);
      await row.getByRole("button", { name: "details" }).click();
      await expect(row.getByText(reason)).toBeVisible();
      await expect(row.getByText('"block"')).toBeVisible();
      await row.getByRole("button", { name: "hide details" }).click();
      await expect(row.getByText(reason)).toHaveCount(0);
    } finally {
      await ownerApi("DELETE", `/ip-rules/${encodeURIComponent(ip)}`);
    }
  });

  test("actor filter: an npub is stored as hex and narrows to that admin's entries; Clear resets", async ({ page }) => {
    const admin = await makeAdmin("admin");
    const targets = await patchUsers(admin, 3);
    await page.goto("audit");
    await actorBox(page).fill(admin.npub);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("actor")).toBe(admin.pubkey);
    await expect(rows(page)).toHaveCount(3);
    // newest first
    await expect(rows(page).first().getByRole("button", { name: new RegExp(targets[2].slice(0, 16)) })).toBeVisible();
    await expect(rows(page).last().getByRole("button", { name: new RegExp(targets[0].slice(0, 16)) })).toBeVisible();
    for (const r of await rows(page).all()) await expect(r.getByText("user.update", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect.poll(() => appHref(page)).toBe("/audit");
    await expect(actorBox(page)).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  });

  test("clicking a target, then an action badge adds each to the filter", async ({ page }) => {
    const admin = await makeAdmin("admin");
    const targets = await patchUsers(admin, 2);
    // another actor on the same target: must stay out of the actor-filtered list
    await ownerApi("PATCH", `/users/${targets[0]}`, { notes: "by owner" });
    await page.goto(`audit?actor=${admin.pubkey}`);
    await expect(rows(page)).toHaveCount(2);

    await rows(page).last().getByRole("button", { name: new RegExp(targets[0].slice(0, 16)) }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("target")).toBe(targets[0]);
    expect(new URL(page.url()).searchParams.get("actor")).toBe(admin.pubkey);
    await expect(rows(page)).toHaveCount(1);
    await expect(targetBox(page)).toHaveValue(targets[0]);

    await rows(page).first().getByText("user.update", { exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("action")).toBe("user.update");
    await expect(actionBox(page)).toHaveValue("user.update");
    await expect(rows(page)).toHaveCount(1);
  });

  test("a filter matching nothing shows the empty state", async ({ page }) => {
    await page.goto("audit");
    await actionBox(page).fill(uniq("no.such.action"));
    await actionBox(page).press("Enter");
    await expect(page.getByText("No audit entries")).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
  });

  test("more than one page (50): scrolling loads the rest without duplicates", async ({ page }) => {
    const admin = await makeAdmin("admin");
    const targets = await patchUsers(admin, 57);
    const pages: string[] = [];
    page.on("request", (r) => r.url().includes("/api/audit") && pages.push(r.url()));
    await page.goto(`audit?actor=${admin.pubkey}`);
    await expect(rows(page).first()).toBeVisible();
    await expect(async () => {
      await page.mouse.wheel(0, 20_000);
      await expect(rows(page)).toHaveCount(57, { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    expect(pages.some((u) => /[?&]before=\d+/.test(u))).toBe(true);
    // every target exactly once, newest first
    const shown = await rows(page).evaluateAll((els) => els.map((e) => e.querySelectorAll("button")[1]?.textContent ?? ""));
    expect(shown.length).toBe(57);
    expect(new Set(shown).size).toBe(57);
    expect(shown[0]).toContain(targets[56].slice(0, 16));
    expect(shown[56]).toContain(targets[0].slice(0, 16));
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });
});
