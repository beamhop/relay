import type { Page } from "@playwright/test";
import { loginWithKey } from "./fixtures";
import { apiOk, expect, fail500, makeUser, setRole, test, uid } from "./seed-users";

interface Invite { code: string; url: string; note?: string }
const inviteRow = (page: Page, text: string) => page.locator("tbody tr").filter({ hasText: text });
const createInvite = async (note: string) => (await apiOk<{ items: Invite[] }>("POST", "/invites", { count: 1, maxUses: 1, note })).items[0];
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("invites", () => {
  // routes mock API calls: keep the PWA service worker out, or requests it has claimed bypass page.route (seed-users fail500)
  test.use({ serviceWorkers: "block" });
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("create form validates count, uses and expiry", async ({ page }) => {
    await page.goto("invites");
    await page.getByRole("button", { name: "Create invites" }).first().click();
    const dialog = page.getByRole("dialog");
    const create = dialog.getByRole("button", { name: "Create", exact: true });
    await expect(create).toBeEnabled();

    await dialog.getByLabel("How many").fill("0");
    await expect(dialog.getByText("Enter a whole number from 1 to 500.")).toBeVisible();
    await expect(create).toBeDisabled();
    await dialog.getByLabel("How many").fill("501");
    await expect(dialog.getByText("Enter a whole number from 1 to 500.")).toBeVisible();
    await dialog.getByLabel("How many").fill("2");
    await expect(dialog.getByText("Enter a whole number from 1 to 500.")).toHaveCount(0);

    await dialog.getByLabel("Uses each").fill("-1");
    await expect(dialog.getByText("Enter a whole number (0 = unlimited).")).toBeVisible();
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Uses each").fill("0");
    await expect(dialog.getByText("0 = unlimited")).toBeVisible();

    await dialog.getByLabel("Expires in (days)").fill("1.5");
    await expect(dialog.getByText("Enter a whole number of days, or leave empty.")).toBeVisible();
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Expires in (days)").fill("");
    await expect(create).toBeEnabled();
  });

  test("create several invites with a note; they show in the list", async ({ page }) => {
    const note = uid("conf");
    await page.goto("invites");
    await page.getByRole("button", { name: "Create invites" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("How many").fill("3");
    await dialog.getByLabel("Uses each").fill("5");
    await dialog.getByLabel("Expires in (days)").fill("7");
    await dialog.getByLabel("Note").fill(note);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog.getByText("3 invite(s) created")).toBeVisible();
    await expect(dialog.locator("li")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Copy all" }).click();
    const all = (await clipboard(page)).split("\n");
    expect(all).toHaveLength(3);
    for (const l of all) expect(l).toMatch(/^https?:\/\//);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(inviteRow(page, note)).toHaveCount(3);
    await expect(inviteRow(page, note).first()).toContainText("0 / 5 used");
    await expect(inviteRow(page, note).first()).toContainText("active");
  });

  test("copy an invite link from the list", async ({ page }) => {
    const inv = await createInvite(uid("copy"));
    await page.goto("invites");
    await inviteRow(page, inv.code).getByRole("button", { name: "Copy Invite link" }).click();
    await expect(page.getByText("Invite link copied")).toBeVisible();
    expect(await clipboard(page)).toBe(inv.url);
  });

  test("revoke asks for confirmation; Cancel keeps it, Revoke removes it", async ({ page }) => {
    const inv = await createInvite(uid("rev"));
    await page.goto("invites");
    await inviteRow(page, inv.code).getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Revoke invite?")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(inviteRow(page, inv.code)).toBeVisible();

    await inviteRow(page, inv.code).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Invite revoked")).toBeVisible();
    await expect(inviteRow(page, inv.code)).toHaveCount(0);
    const left = await apiOk<{ items: Invite[] }>("GET", "/invites");
    expect(left.items.some((i) => i.code === inv.code)).toBe(false);
  });

  test("revoke failing on the server: toast, the invite stays, no unhandled rejection", async ({ page, allowServerErrors }) => {
    allowServerErrors();
    const inv = await createInvite(uid("rf"));
    await page.goto("invites");
    await fail500(page, `**/admin/api/invites/${inv.code}`, "DELETE");
    await inviteRow(page, inv.code).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Action failed")).toBeVisible();
    await expect(page.getByText("boom from test")).toBeVisible();
    await expect(inviteRow(page, inv.code)).toBeVisible();
  });

  test("create failing on the server: toast, the form stays open with its values", async ({ page, allowServerErrors }) => {
    allowServerErrors();
    const note = uid("cf");
    await page.goto("invites");
    await fail500(page, "**/admin/api/invites", "POST");
    await page.getByRole("button", { name: "Create invites" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note").fill(note);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("boom from test")).toBeVisible();
    await expect(dialog.getByLabel("Note")).toHaveValue(note);
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await expect(inviteRow(page, note)).toHaveCount(0);
  });

  test("an expired unlimited invite shows as expired with ∞ uses", async ({ page }) => {
    const inv = (await apiOk<{ items: Invite[] }>("POST", "/invites", { count: 1, maxUses: 0, note: uid("ul"), expiresAt: Math.floor(Date.now() / 1000) - 10 })).items[0];
    await page.goto("invites");
    await expect(inviteRow(page, inv.code)).toContainText("expired");
    await expect(inviteRow(page, inv.code)).toContainText("∞");
  });
});

test.describe("invites (moderator)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("a moderator (invites.manage) can create and revoke invites", async ({ page }) => {
    const mod = makeUser();
    await setRole(mod.pubkey, "moderator");
    await loginWithKey(page, mod.nsec);
    await page.getByRole("link", { name: "Invites" }).click();
    await page.getByRole("button", { name: "Create invites" }).first().click();
    const note = uid("mod");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note").fill(note);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await inviteRow(page, note).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect(inviteRow(page, note)).toHaveCount(0);
  });
});
