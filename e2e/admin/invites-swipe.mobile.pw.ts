import { apiOk, expect, swipe, test, uid } from "./seed-users";

// the desktop project matches every *.pw.ts: these gestures only make sense on the phone layout
test.skip(({ isMobile }) => !isMobile, "phone layout only");

interface Invite { code: string; url: string }
const createInvite = async () => (await apiOk<{ items: Invite[] }>("POST", "/invites", { count: 1, maxUses: 2, note: uid("m") })).items[0];

test.describe("invites on a phone", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("tapping an invite card copies its link", async ({ page }) => {
    const inv = await createInvite();
    await page.goto("invites");
    await page.getByText(inv.code, { exact: true }).tap();
    await expect(page.getByText("Invite link copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inv.url);
  });

  test("swipe left revokes after confirming; Cancel keeps it", async ({ page }) => {
    const inv = await createInvite();
    await page.goto("invites");
    const code = page.getByText(inv.code, { exact: true });
    await swipe(page, code.locator(".."), "left");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).tap();
    await expect(code).toBeInViewport();
    await swipe(page, code.locator(".."), "left");
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).tap();
    await expect(page.getByText("Invite revoked")).toBeVisible();
    await expect(code).toHaveCount(0);
  });

  test("create invites from the bottom drawer", async ({ page }) => {
    const note = uid("drawer");
    await page.goto("invites");
    await page.getByRole("button", { name: "Create invites" }).first().tap();
    const drawer = page.getByRole("dialog");
    await drawer.getByLabel("How many").fill("2");
    await drawer.getByLabel("Note").fill(note);
    await drawer.getByRole("button", { name: "Create", exact: true }).tap();
    await expect(drawer.getByText("2 invite(s) created")).toBeVisible();
    await drawer.getByRole("button", { name: "Done" }).tap();
    await expect(page.getByText(note)).toHaveCount(2);
  });
});
