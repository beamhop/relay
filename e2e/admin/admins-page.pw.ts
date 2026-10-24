import type { Page } from "@playwright/test";
import { loginWithKey } from "./fixtures";
import { api, expect, getUser, makeUser, owner, seedUser, setRole, test } from "./seed-users";

const adminRow = (page: Page, text: string) => page.locator("div.border-b").filter({ hasText: text });

test.describe("admins page (owner)", () => {
  test("add an admin by npub with a chosen role", async ({ page }) => {
    const u = await seedUser();
    await page.goto("admins");
    await page.getByRole("button", { name: "Add admin" }).click();
    const dialog = page.getByRole("dialog");
    const grant = dialog.getByRole("button", { name: "Grant access" });
    await expect(grant).toBeDisabled();
    await dialog.getByLabel("npub or hex pubkey").fill("npub1notakey");
    await expect(dialog.getByLabel("npub or hex pubkey")).toHaveAttribute("aria-invalid", "true");
    await expect(grant).toBeDisabled();
    await dialog.getByLabel("npub or hex pubkey").fill(u.npub);
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: /^viewer/ }).click();
    await grant.click();
    await expect(page.getByText("Role set to viewer")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(adminRow(page, u.name).getByRole("combobox")).toHaveText("viewer");
    expect((await getUser(u.pubkey)).role).toBe("viewer");
  });

  test("add an admin by hex pubkey (no profile) with the default role", async ({ page }) => {
    const u = makeUser();
    await page.goto("admins");
    await page.getByRole("button", { name: "Add admin" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("npub or hex pubkey").fill(u.pubkey);
    await dialog.getByRole("button", { name: "Grant access" }).click();
    await expect(page.getByText("Role set to moderator")).toBeVisible();
    await expect(adminRow(page, u.npub.slice(0, 11)).getByRole("combobox")).toHaveText("moderator");
    // the server really granted it: the admins list has the pubkey with that role
    const admins = await api<{ items: { pubkey: string; role: string }[] }>("GET", "/admins");
    expect(admins.status).toBe(200);
    expect(admins.body.items.filter((a) => a.pubkey === u.pubkey).map((a) => a.role)).toEqual(["moderator"]);
    expect((await getUser(u.pubkey)).role).toBe("moderator");
  });

  test("change an admin's role", async ({ page }) => {
    const u = await seedUser();
    await setRole(u.pubkey, "moderator");
    await page.goto("admins");
    await adminRow(page, u.name).getByRole("combobox").click();
    await page.getByRole("option", { name: "admin", exact: true }).click();
    await expect(page.getByText("Role set to admin")).toBeVisible();
    await expect(adminRow(page, u.name).getByRole("combobox")).toHaveText("admin");
    expect((await getUser(u.pubkey)).role).toBe("admin");
  });

  test("remove access asks for confirmation; Cancel keeps it, Remove drops the row", async ({ page }) => {
    const u = await seedUser();
    await setRole(u.pubkey, "viewer");
    await page.goto("admins");
    await adminRow(page, u.name).getByRole("combobox").click();
    await page.getByRole("option", { name: "Remove access" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Remove admin access?")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(adminRow(page, u.name).getByRole("combobox")).toHaveText("viewer");
    expect((await getUser(u.pubkey)).role).toBe("viewer");

    await adminRow(page, u.name).getByRole("combobox").click();
    await page.getByRole("option", { name: "Remove access" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Admin role removed")).toBeVisible();
    await expect(adminRow(page, u.name)).toHaveCount(0);
    expect((await getUser(u.pubkey)).role ?? null).toBeNull();
  });

  test("the signed-in owner can't change their own role", async ({ page }) => {
    await page.goto("admins");
    const mine = page.locator("div.border-b").filter({ has: page.locator(`a[href$="/users/${owner().pubkey}"]`) });
    await expect(mine.getByRole("combobox")).toBeDisabled();
    await expect(mine.getByRole("combobox")).toHaveText("owner");
  });

  test("a failing role change shows a toast and keeps the old role", async ({ page, allowServerErrors }) => {
    allowServerErrors();
    const u = await seedUser();
    await setRole(u.pubkey, "viewer");
    await page.goto("admins");
    await page.route(`**/admin/api/users/${u.pubkey}/role`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom from test"}' }));
    await adminRow(page, u.name).getByRole("combobox").click();
    await page.getByRole("option", { name: "moderator" }).click();
    await expect(page.getByText("boom from test")).toBeVisible();
    await expect(adminRow(page, u.name).getByRole("combobox")).toHaveText("viewer");
  });
});

test.describe("permission enforcement (signed in as a viewer)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("viewer: no Admins/Invites/IP rules in the nav; users list has no mutating controls", async ({ page }) => {
    const viewer = makeUser();
    await setRole(viewer.pubkey, "viewer");
    const tag = `vw${Date.now()}`;
    const target = await seedUser();
    await api("PATCH", `/users/${target.pubkey}`, { tags: [tag] });
    await loginWithKey(page, viewer.nsec);
    await expect(page.getByRole("link", { name: "Users" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Admins" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Invites" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "IP rules" })).toHaveCount(0);

    await page.goto(`users?tag=${tag}`);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Ban|Mute|Unban|More)$/ })).toHaveCount(0);
    await page.locator("tbody tr").getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Allow|Ban|Mute|Delete/ })).toHaveCount(0);
  });

  test("viewer: user detail is read-only", async ({ page }) => {
    const viewer = makeUser();
    await setRole(viewer.pubkey, "viewer");
    const target = await seedUser();
    await loginWithKey(page, viewer.nsec);
    await page.goto(`users/${target.pubkey}`);
    await expect(page.getByRole("heading", { level: 1, name: target.name })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ban", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mute" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByLabel("Notes")).toBeDisabled();
    await expect(page.getByText("Admin role", { exact: true })).toHaveCount(0);
  });

  test("regression: a viewer opening /admins directly gets no 'Add admin' and disabled role selects", async ({ page }) => {
    const viewer = makeUser();
    await setRole(viewer.pubkey, "viewer");
    const other = await seedUser();
    await setRole(other.pubkey, "moderator");
    await loginWithKey(page, viewer.nsec);
    await page.goto("admins");
    await expect(page.getByRole("heading", { level: 1, name: "Admins" })).toBeVisible();
    await expect(adminRow(page, other.name)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add admin" })).toHaveCount(0);
    await expect(adminRow(page, other.name).getByRole("combobox")).toBeDisabled();
  });
});
