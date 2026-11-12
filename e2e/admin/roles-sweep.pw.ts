/**
 * Every page a role's navigation offers renders without a 403: each one only fetches (and shows controls for) what the
 * role may do. A failed request on a page shows "Something went wrong" or logs a 403.
 */
import { test, expect } from "./fixtures";
import { freshPage, makeAdmin, signInWithKey } from "./auth-support";

/** page → the permission its navigation entry needs (packages/admin-ui/src/lib/nav.ts) */
const PAGES: [string, string | null][] = [
  ["", "dashboard.view"], ["live", "dashboard.view"], ["users", "users.view"], ["admins", "admins.manage"], ["invites", "invites.manage"],
  ["ip-rules", "ip.manage"], ["content", "content.view"], ["reports", "reports.view"], ["media", "media.view"], ["groups", "groups.view"],
  ["settings/info", "settings.view"], ["settings/moderation", "settings.view"], ["plugins", "plugins.view"], ["plugins/hello", "plugins.view"],
  ["audit", "audit.view"], ["system", null], ["account", null],
];

for (const role of ["viewer", "moderator", "admin"] as const) {
  test(`${role}: every page in the navigation loads without forbidden requests`, async ({ browser, baseURL }) => {
    const admin = await makeAdmin(role);
    const { context, page } = await freshPage(browser, baseURL!);
    const forbidden: string[] = [];
    page.on("response", (r) => {
      if (r.status() === 403 && r.url().includes("/admin/api/")) forbidden.push(`${new URL(page.url()).pathname} → ${r.request().method()} ${new URL(r.url()).pathname}`);
    });
    try {
      await page.goto("login");
      await signInWithKey(page, admin.nsec);
      await expect(page).not.toHaveURL(/\/login/);
      const me = await (await page.request.get("api/auth/me")).json();
      const visited: string[] = [];
      for (const [path, perm] of PAGES) {
        if (perm && !me.permissions.includes(perm)) continue;
        visited.push(path);
        await page.goto(path || "./");
        // (the plugin detail page has no h1 of its own; its card title names the plugin)
        await expect(page.getByRole("heading", { level: 1 }).or(page.getByText("v0.1.0")).first(), `${role} on /${path}`).toBeVisible();
        // the live stream keeps the network busy: give the page's queries a moment instead
        await page.waitForTimeout(400);
        await expect(page.getByText("Something went wrong"), `${role} on /${path}`).toHaveCount(0);
      }
      // the navigation offers each role at least the read-only pages
      expect(visited.length, visited.join(" ")).toBeGreaterThanOrEqual(role === "viewer" ? 10 : 13);
      expect(forbidden, `${role} (${me.permissions.length} permissions)`).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("regression: a viewer opening a plugin page by URL is told why, and nothing polls the plugin's routes", async ({ browser, baseURL }) => {
  const viewer = await makeAdmin("viewer");
  const { context, page } = await freshPage(browser, baseURL!);
  const pluginCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/admin/api/plugins/hello/")) pluginCalls.push(r.url());
  });
  try {
    await page.goto("login");
    await signInWithKey(page, viewer.nsec);
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto("p/hello/hello");
    await expect(page.getByText("You can't use plugin pages")).toBeVisible();
    await page.waitForTimeout(6000);
    expect(pluginCalls).toEqual([]);
  } finally {
    await context.close();
  }
});
