import { test, expect } from "./fixtures";
import { openPalette } from "./auth-support";

/** every entry of lib/nav.ts NAV (the owner has every permission, so all are shown) */
const NAV = [
  { label: "Dashboard", path: "/", heading: "Dashboard" },
  { label: "Live", path: "/live", heading: "Live" },
  { label: "Users", path: "/users", heading: "Users" },
  { label: "Admins", path: "/admins", heading: "Admins" },
  { label: "Invites", path: "/invites", heading: "Invites" },
  { label: "IP rules", path: "/ip-rules", heading: "IP rules" },
  { label: "Events", path: "/content", heading: "Events" },
  { label: "Reports", path: "/reports", heading: "Reports" },
  { label: "Media", path: "/media", heading: "Media" },
  { label: "Groups", path: "/groups", heading: "Groups" },
  { label: "Settings", path: "/settings/info", heading: "Settings" },
  { label: "Plugins", path: "/plugins", heading: "Plugins" },
  { label: "Audit log", path: "/audit", heading: "Audit log" },
  { label: "System", path: "/system", heading: "System" },
  { label: "Account", path: "/account", heading: "Account" },
];

/** pages registered by plugin UIs: the e2e relay loads the bundled hello plugin (harness/serve.ts), which adds one */
const PLUGIN_PAGES = [{ label: "Hello", path: "/p/hello/hello" }];

const pathOf = (url: string) => new URL(url).pathname.replace(/^\/admin/, "") || "/";

test("the sidebar lists exactly the expected entries", async ({ page }) => {
  await page.goto("./");
  const sidebar = page.locator('[data-slot="sidebar"]');
  const links = sidebar.locator('[data-sidebar="menu-button"]').filter({ has: page.locator("svg") });
  for (const n of NAV) await expect(sidebar.getByRole("link", { name: n.label, exact: true })).toBeVisible();
  for (const p of PLUGIN_PAGES) await expect(sidebar.getByRole("link", { name: p.label, exact: true })).toHaveAttribute("href", `/admin${p.path}`);
  // logo link + nav entries + plugin pages + user menu button
  await expect(links).toHaveCount(NAV.length + PLUGIN_PAGES.length + 2);
});

for (const n of NAV) {
  test(`sidebar → ${n.label} renders its page and marks the link active`, async ({ page }) => {
    // start somewhere else so the click is a real client-side navigation
    await page.goto(n.path === "/system" ? "account" : "system");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByRole("link", { name: n.label, exact: true }).click();
    await expect.poll(() => pathOf(page.url())).toBe(n.path);
    await expect(page.getByRole("heading", { level: 1, name: n.heading, exact: true })).toBeVisible();
    await expect(page.getByText(/failed to render/)).toHaveCount(0);
    await expect(page.getByText("Page not found")).toHaveCount(0);
    // exactly one active entry, and it is this one
    const active = sidebar.locator('[data-sidebar="menu-button"][data-active="true"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(n.label);
    // top bar title follows the page
    await expect(page.locator("header h2")).toHaveText(n.label);
  });
}

test("every command palette page entry navigates to a rendering page", async ({ page }) => {
  await page.goto("./");
  for (const n of NAV) {
    const input = await openPalette(page);
    await input.fill(n.label);
    await page.getByRole("option", { name: n.label, exact: true }).click();
    await expect(page.getByPlaceholder(/Search pages/)).toBeHidden();
    await expect.poll(() => pathOf(page.url()), { message: n.label }).toBe(n.path);
    await expect(page.getByRole("heading", { level: 1, name: n.heading, exact: true })).toBeVisible();
    await expect(page.getByText(/failed to render/)).toHaveCount(0);
  }
});

test("command palette matches on keywords and toggles with the shortcut", async ({ page }) => {
  await page.goto("./");
  const input = await openPalette(page);
  await input.fill("firewall");
  await expect(page.getByRole("option", { name: "IP rules", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Users", exact: true })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => pathOf(page.url())).toBe("/ip-rules");
  // the shortcut opens and closes it; Escape closes it too
  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder(/Search pages/)).toBeHidden();
});

test("command palette search entry carries the query to the users page", async ({ page }) => {
  await page.goto("./");
  const input = await openPalette(page);
  await input.fill("alice-xyz");
  await page.getByRole("option", { name: /Search users for/ }).click();
  await expect.poll(() => pathOf(page.url())).toBe("/users");
  expect(new URL(page.url()).searchParams.get("search")).toContain("alice-xyz");
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
});

test("an unknown route shows the 404 page with a way back", async ({ page }) => {
  await page.goto("does-not-exist");
  await expect(page.getByText("Page not found")).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
});

test("the sidebar trigger collapses the sidebar to icons and back", async ({ page }) => {
  await page.goto("./");
  const sidebar = page.locator('[data-slot="sidebar"][data-state]').first();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});
