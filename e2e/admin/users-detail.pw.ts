import type { Page, Route } from "@playwright/test";
import { apiOk, expect, getUser, owner, seedUser, setRole, test, uid } from "./seed-users";

/** the name/badges line under the avatar */
const header = (page: Page) => page.locator("h1").locator("..");
const banBtn = (page: Page) => page.getByRole("button", { name: "Ban", exact: true });

async function openUser(page: Page, pubkey: string, name: string) {
  await page.goto(`users/${pubkey}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test.describe("user detail", () => {
  test("ban with 'Delete all their events' empties the events tab and /content without a reload", async ({ page }) => {
    const n1 = `first ${uid()}`;
    const n2 = `second ${uid()}`;
    const u = await seedUser({ notes: [n1, n2] });
    // warm /content's cache for this author first, then go to the user page in-app
    await page.goto(`content?f=${encodeURIComponent(JSON.stringify({ authors: [u.pubkey] }))}`);
    await expect(page.getByText(n1)).toBeVisible();
    await page.goto(`users/${u.pubkey}`);
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByText(n2)).toBeVisible();

    await banBtn(page).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText(`Ban ${u.name}?`)).toBeVisible();
    await dialog.getByLabel("Reason (optional)").fill("spam");
    await dialog.getByRole("checkbox", { name: "Delete all their events" }).check();
    await dialog.getByRole("button", { name: "Ban user" }).click();
    await expect(page.getByText("User banned")).toBeVisible();
    await expect(header(page).getByText("banned", { exact: true })).toBeVisible();
    await expect(page.getByText("Ban reason: spam")).toBeVisible();
    await expect(page.getByText("No events", { exact: true })).toBeVisible();
    await expect(page.getByText(n1)).toHaveCount(0);

    // in-app navigation (no reload) to the author's events
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Browse events" }).click();
    await expect(page).toHaveURL(/\/content/);
    await expect(page.getByText("No events match")).toBeVisible();
    await expect(page.getByText(n1)).toHaveCount(0);
    await expect(page.getByText(n2)).toHaveCount(0);
  });

  test("ban without deleting events keeps the events; Cancel bans nobody", async ({ page }) => {
    const note = `keep ${uid()}`;
    const u = await seedUser({ notes: [note] });
    await openUser(page, u.pubkey, u.name);
    await banBtn(page).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(header(page).getByText("active", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).status).toBe("active");

    await banBtn(page).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Ban user" }).click();
    await expect(header(page).getByText("banned", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByText(note)).toBeVisible();
  });

  test("unban, mute and unmute update the page in place", async ({ page }) => {
    const u = await seedUser();
    await apiOk("POST", `/users/${u.pubkey}/ban`, {});
    await openUser(page, u.pubkey, u.name);
    await expect(header(page).getByText("banned", { exact: true })).toBeVisible();
    // a banned user can't be muted from here
    await expect(page.getByRole("button", { name: "Mute" })).toHaveCount(0);
    await page.getByRole("button", { name: "Unban" }).click();
    await expect(page.getByText("User unbanned")).toBeVisible();
    await expect(header(page).getByText("active", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Mute" }).click();
    await expect(header(page).getByText("muted", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unmute" }).click();
    await expect(header(page).getByText("active", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).status).toBe("active");
  });

  test("moderation buttons are disabled while an action is pending", async ({ page }) => {
    const u = await seedUser();
    await openUser(page, u.pubkey, u.name);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/admin/api/users/${u.pubkey}/mute`, async (route: Route) => {
      await held;
      await route.continue();
    });
    await page.getByRole("button", { name: "Mute" }).click();
    await expect(page.getByRole("button", { name: "Mute" })).toBeDisabled();
    await expect(banBtn(page)).toBeDisabled();
    release();
    await expect(page.getByRole("button", { name: "Unmute" })).toBeEnabled();
    await expect(banBtn(page)).toBeEnabled();
  });

  test("a role change on the Admins page shows on the user page immediately", async ({ page }) => {
    const u = await seedUser();
    await setRole(u.pubkey, "viewer");
    await openUser(page, u.pubkey, u.name);
    await expect(header(page).getByText("viewer", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Admins" }).click();
    const adminRow = page.locator("div.border-b").filter({ hasText: u.name });
    await adminRow.getByRole("combobox").click();
    await page.getByRole("option", { name: "moderator" }).click();
    await expect(page.getByText("Role set to moderator")).toBeVisible();

    await page.goBack();
    await expect(header(page).getByText("moderator", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox").filter({ hasText: "Moderator — content & reports" })).toBeVisible();

    // and removing access there drops the badge here
    await page.goForward();
    await page.locator("div.border-b").filter({ hasText: u.name }).getByRole("combobox").click();
    await page.getByRole("option", { name: "Remove access" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Admin role removed")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("combobox").filter({ hasText: "No admin access" })).toBeVisible();
    await expect(header(page).getByText("moderator", { exact: true })).toHaveCount(0);
  });

  test("role card: granting a role from the user page", async ({ page }) => {
    const u = await seedUser();
    await openUser(page, u.pubkey, u.name);
    await page.getByRole("combobox").filter({ hasText: "No admin access" }).click();
    await page.getByRole("option", { name: /^Viewer/ }).click();
    await expect(header(page).getByText("viewer", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).role).toBe("viewer");
    await setRole(u.pubkey, null);
  });

  test("the owner can't be banned, muted or deleted, nor change their own role", async ({ page }) => {
    await page.goto(`users/${owner().pubkey}`);
    await expect(header(page).getByText("owner", { exact: true })).toBeVisible();
    await expect(banBtn(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mute" })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete user" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByText("You can't change your own role.")).toBeVisible();
    await expect(page.getByRole("combobox").filter({ hasText: "Owner — full control" })).toBeDisabled();
  });

  test("the owner's row in the users list has no Ban/Mute/Delete", async ({ page }) => {
    await page.goto(`users?search=${owner().npub}`);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.locator("tbody tr").getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Ban|Mute|Delete/ })).toHaveCount(0);
  });

  test("editing details: tags and notes save and survive a refetch", async ({ page }) => {
    const u = await seedUser();
    const tag = uid("dt");
    await openUser(page, u.pubkey, u.name);
    await page.getByLabel("Notes").fill("watch this one");
    await page.getByPlaceholder("Add tag and press Enter").fill(tag);
    await page.getByPlaceholder("Add tag and press Enter").press("Enter");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("User updated")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const saved = await getUser(u.pubkey);
    expect(saved.notes).toBe("watch this one");
    expect(saved.tags).toEqual([tag]);
  });
});
