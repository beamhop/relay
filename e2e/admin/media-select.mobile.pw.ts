import type { Page } from "@playwright/test";
import { test, expect } from "./seed-content";
import { longPress, newUser, ownerApi, pngBytes, swipe, upload } from "./seed-content";

const mediaUrl = (pk: string) => `media?pubkey=${encodeURIComponent(JSON.stringify(pk))}`;
const openBtn = (page: Page, sha: string) => page.getByRole("button", { name: `Open ${sha.slice(0, 8)}` });

async function seed(n: number) {
  const u = newUser();
  const shas: string[] = [];
  for (let i = 0; i < n; i++) shas.push(await upload(u.sk, pngBytes(i)));
  return { u, shas };
}

test.describe("media on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "touch-only");

  test("long-press starts selection; later taps toggle instead of opening", async ({ page }) => {
    const { u, shas } = await seed(2);
    await page.goto(mediaUrl(u.pubkey));
    await expect(openBtn(page, shas[1])).toBeVisible();
    // no "Select all" on touch screens
    await expect(page.getByText(/^Select all/)).toHaveCount(0);
    await longPress(page, openBtn(page, shas[0]));
    await expect(page.getByText("1 selected")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openBtn(page, shas[1]).tap();
    await expect(page.getByText("2 selected")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openBtn(page, shas[1]).tap();
    await expect(page.getByText("1 selected")).toBeVisible();
  });

  test("a plain tap opens the lightbox", async ({ page }) => {
    const { u, shas } = await seed(1);
    await page.goto(mediaUrl(u.pubkey));
    await openBtn(page, shas[0]).tap();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Delete" })).toBeVisible();
  });

  test("swipe-deleting a selected blob removes it from the selection count", async ({ page }) => {
    const { u, shas } = await seed(3);
    await page.goto(mediaUrl(u.pubkey));
    await longPress(page, openBtn(page, shas[0]));
    await openBtn(page, shas[1]).tap();
    await expect(page.getByText("2 selected")).toBeVisible();
    await swipe(page, openBtn(page, shas[0]), -150);
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText("Delete this blob?")).toBeVisible();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(openBtn(page, shas[0])).toHaveCount(0);
    await expect(page.getByText("1 selected")).toBeVisible();
    expect((await ownerApi("GET", `/media/${shas[0]}`)).status).toBe(404);
  });

  test("bulk block from the selection bar", async ({ page }) => {
    const { u, shas } = await seed(2);
    await page.goto(mediaUrl(u.pubkey));
    await longPress(page, openBtn(page, shas[0]));
    await openBtn(page, shas[1]).tap();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Block", exact: true }).tap();
    await page.getByRole("alertdialog").getByRole("button", { name: "Block" }).tap();
    await expect(page.getByText("2 blob(s) updated")).toBeVisible();
    for (const s of shas) expect((await ownerApi("GET", `/media/${s}`)).body.status).toBe("blocked");
  });
});
