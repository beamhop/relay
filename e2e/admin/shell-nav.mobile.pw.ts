import { test, expect } from "./fixtures";
import { SIGNED_OUT, ownSession, ownerApi, toast, uniq } from "./auth-support";
import type { Page } from "@playwright/test";

const TABS = [
  { label: "Dashboard", path: "/" },
  { label: "Users", path: "/users" },
  { label: "Events", path: "/content" },
  { label: "Reports", path: "/reports" },
];
const MORE = [
  { label: "Live", path: "/live" },
  { label: "Admins", path: "/admins" },
  { label: "Invites", path: "/invites" },
  { label: "IP rules", path: "/ip-rules" },
  { label: "Media", path: "/media" },
  { label: "Groups", path: "/groups" },
  { label: "Settings", path: "/settings/info", heading: "Settings" },
  { label: "Plugins", path: "/plugins" },
  { label: "Audit log", path: "/audit" },
  { label: "System", path: "/system" },
  { label: "Account", path: "/account" },
];
/** pages registered by plugin UIs, listed in the drawer too: the e2e relay loads the bundled hello plugin */
const PLUGIN_PAGES = [{ label: "Hello", path: "/p/hello/hello" }];

// the desktop project matches every *.pw.ts; these only make sense on the phone project
test.skip(({ isMobile }) => !isMobile, "phone layout only");

const pathOf = (url: string) => new URL(url).pathname.replace(/^\/admin/, "") || "/";
const bottomNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "More" });
/** the Reports tab's accessible name also carries the open-report badge count */
const tab = (page: Page, label: string) => bottomNav(page).getByRole("link", { name: new RegExp(`^${label}( \\d+\\+?)?$`) });

test("the desktop sidebar is hidden and the bottom nav shows the main tabs + More", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(bottomNav(page)).toBeVisible();
  for (const t of TABS) await expect(tab(page, t.label)).toBeVisible();
  await expect(bottomNav(page).getByRole("button", { name: "More" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toBeHidden();
});

test("each bottom tab navigates and becomes the active one", async ({ page }) => {
  await page.goto("system");
  await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();
  for (const t of TABS) {
    const link = tab(page, t.label);
    await link.tap();
    await expect.poll(() => pathOf(page.url())).toBe(t.path);
    await expect(page.getByRole("heading", { level: 1, name: t.label, exact: true })).toBeVisible();
    await expect(link).toHaveClass(/text-primary/);
    for (const other of TABS.filter((o) => o !== t)) await expect(tab(page, other.label)).not.toHaveClass(/text-primary/);
    await expect(bottomNav(page).getByRole("button", { name: "More" })).not.toHaveClass(/text-primary/);
  }
});

for (const m of MORE) {
  test(`More drawer → ${m.label} navigates, closes the drawer and highlights More`, async ({ page }) => {
    await page.goto("./");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await bottomNav(page).getByRole("button", { name: "More" }).tap();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByRole("link")).toHaveCount(MORE.length + PLUGIN_PAGES.length);
    for (const p of PLUGIN_PAGES) await expect(drawer(page).getByRole("link", { name: p.label, exact: true })).toHaveAttribute("href", `/admin${p.path}`);
    await drawer(page).getByRole("link", { name: m.label, exact: true }).tap();
    await expect(drawer(page)).toBeHidden();
    await expect.poll(() => pathOf(page.url())).toBe(m.path);
    await expect(page.getByRole("heading", { level: 1, name: m.heading ?? m.label, exact: true })).toBeVisible();
    await expect(page.getByText(/failed to render/)).toHaveCount(0);
    await expect(bottomNav(page).getByRole("button", { name: "More" })).toHaveClass(/text-primary/);
  });
}

test("the More drawer theme menu switches the theme", async ({ page }) => {
  await page.goto("./");
  await bottomNav(page).getByRole("button", { name: "More" }).tap();
  await drawer(page).getByRole("button", { name: "Theme" }).tap();
  await page.getByRole("menuitemradio", { name: "Dark" }).tap();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});

test("the search button opens the command palette on touch", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Search", exact: true }).tap();
  await page.getByPlaceholder(/Search pages/).fill("audit");
  await page.getByRole("option", { name: "Audit log", exact: true }).tap();
  await expect.poll(() => pathOf(page.url())).toBe("/audit");
});

test("the settings save bar sits above the bottom nav and can be tapped", async ({ page }) => {
  await page.goto("settings/info");
  const name = uniq("mobile");
  await page.getByLabel("Name", { exact: true }).fill(name);
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeVisible();
  // not covered by the fixed bottom navigation
  const [s, n] = await Promise.all([save.boundingBox(), bottomNav(page).boundingBox()]);
  expect(s!.y + s!.height).toBeLessThanOrEqual(n!.y + 1);
  await save.tap();
  await expect(toast(page, "Settings saved")).toBeVisible();
  await expect.poll(async () => (await ownerApi("GET", "/settings")).body.settings.info.name).toBe(name);
});

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT });

  test("sign out from the More drawer", async ({ page }) => {
    await ownSession(page);
    await bottomNav(page).getByRole("button", { name: "More" }).tap();
    await drawer(page).getByRole("button", { name: "Sign out" }).tap();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("api/auth/me")).status()).toBe(401);
  });

  test("the account menu in the top bar opens on tap", async ({ page }) => {
    await ownSession(page);
    await page.getByRole("button", { name: "Account" }).tap();
    await page.getByRole("menuitem", { name: /Account & security/ }).tap();
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  });
});
