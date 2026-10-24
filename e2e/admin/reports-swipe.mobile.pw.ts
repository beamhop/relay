import type { Page } from "@playwright/test";
import { test, expect } from "./seed-content";
import { http, newUser, note, ownerApi, publish, queryWs, report, swipe, uid, upload } from "./seed-content";

const card = (page: Page, text: string) =>
  page.locator("div.rounded-xl").filter({ hasText: text }).filter({ has: page.getByRole("button", { name: "Dismiss" }) }).last();

async function eventReport() {
  const id = uid();
  const author = newUser();
  const target = note(`swiped note ${id}`, { sk: author.sk });
  const r = report({ e: target.id, p: author.pubkey }, "spam", `swipe event report ${id}`);
  await publish(target, r);
  return { id, author, target, report: r, text: `swipe event report ${id}` };
}
async function profileReport() {
  const id = uid();
  const author = newUser();
  const r = report({ p: author.pubkey }, "spam", `swipe profile report ${id}`);
  await publish(r);
  return { id, author, report: r, text: `swipe profile report ${id}` };
}
const userStatus = async (pk: string) => (await ownerApi<{ status: string }>("GET", `/users/${pk}`)).body.status;

test.describe("reports on a phone", () => {
  // the desktop project matches every *.pw.ts; these need the Pixel 7 touch context
  test.skip(({ isMobile }) => !isMobile, "touch-only");
  test("left swipe on a profile-only report asks to Ban user (not Delete & ban) and bans", async ({ page }) => {
    const r = await profileReport();
    await page.goto("reports");
    await expect(page.getByText("Swipe right to dismiss")).toBeVisible();
    const c = card(page, r.text);
    await expect(c.getByRole("button", { name: "Ban user" })).toBeVisible();
    await expect(c.getByRole("button", { name: "Delete & ban" })).toHaveCount(0);
    await swipe(page, c, -260);
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByRole("heading", { name: "Ban user?" })).toBeVisible();
    await dlg.getByRole("button", { name: "Ban user" }).click();
    await expect(page.getByText(r.text)).toHaveCount(0);
    await expect.poll(() => userStatus(r.author.pubkey)).toBe("banned");
  });

  test("left swipe on an event report asks to Delete & ban", async ({ page }) => {
    const r = await eventReport();
    await page.goto("reports");
    const c = card(page, r.text);
    await swipe(page, c, -260);
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByRole("heading", { name: "Delete & ban?" })).toBeVisible();
    await dlg.getByRole("button", { name: "Delete & ban" }).click();
    await expect(page.getByText(r.text)).toHaveCount(0);
    expect(await queryWs([{ ids: [r.target.id] }])).toHaveLength(0);
    await expect.poll(() => userStatus(r.author.pubkey)).toBe("banned");
  });

  test("right swipe dismisses without a confirm", async ({ page }) => {
    const r = await eventReport();
    await page.goto("reports");
    await swipe(page, card(page, r.text), 260);
    await expect(page.getByText("Report dismissed")).toBeVisible();
    await expect(page.getByText(r.text)).toHaveCount(0);
    expect(await queryWs([{ ids: [r.target.id] }])).toHaveLength(1);
  });

  test("a short swipe snaps back and does nothing", async ({ page }) => {
    const r = await profileReport();
    await page.goto("reports");
    const c = card(page, r.text);
    await swipe(page, c, -40);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(c).toBeVisible();
    expect(await userStatus(r.author.pubkey)).not.toBe("banned");
  });

  test("reported media: first tap un-blurs instead of opening a new tab", async ({ page }) => {
    const id = uid();
    const uploader = newUser();
    const sha = await upload(uploader.sk);
    await publish(report({ x: sha, p: uploader.pubkey }, "nudity", `mobile media report ${id}`));
    await page.goto("reports");
    const img = card(page, `mobile media report ${id}`).getByRole("img", { name: "Reported media" });
    await expect(img).toHaveClass(/blur-md/);
    let popups = 0;
    page.context().on("page", () => popups++);
    await img.tap();
    await expect(img).not.toHaveClass(/blur-md/);
    await expect(page).toHaveURL(/\/reports/);
    expect(popups).toBe(0);
  });

  test("an image inside a reported note loads only on request, then the first tap un-blurs it", async ({ page }) => {
    const id = uid();
    const author = newUser();
    const sha = await upload(author.sk);
    const target = note(`look ${http()}/${sha}.png ${id}`, { sk: author.sk });
    await publish(target, report({ e: target.id, p: author.pubkey }, "nudity", `note media report ${id}`));
    await page.goto("reports");
    const c = card(page, `note media report ${id}`);
    const show = c.getByRole("button", { name: /Show reported image/ });
    await expect(show).toBeVisible();
    await expect(c.locator("img[src$='.png']")).toHaveCount(0);
    await show.tap();
    const img = c.locator(`img[src="${http()}/${sha}.png"]`);
    await expect(img).toHaveClass(/blur-md/);
    let popups = 0;
    page.context().on("page", () => popups++);
    await img.tap();
    await expect(img).not.toHaveClass(/blur-md/);
    expect(popups).toBe(0);
  });
});
