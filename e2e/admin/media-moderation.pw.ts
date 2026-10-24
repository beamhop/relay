import type { Page } from "@playwright/test";
import { test, expect } from "./seed-content";
import { http, newUser, ownerApi, pngBytes, upload } from "./seed-content";

const mediaUrl = (pk: string, extra = "") => `media?pubkey=${encodeURIComponent(JSON.stringify(pk))}${extra}`;
const openBtn = (page: Page, sha: string) => page.getByRole("button", { name: `Open ${sha.slice(0, 8)}` });
const tile = (page: Page, sha: string) => openBtn(page, sha).locator("xpath=..");
const blob = async (sha: string) => (await ownerApi<{ status: string }>("GET", `/media/${sha}`));

async function seed(n: number) {
  const u = newUser();
  const shas: string[] = [];
  for (let i = 0; i < n; i++) shas.push(await upload(u.sk, pngBytes(i)));
  return { u, shas };
}

test.describe("media grid", () => {
  test("shows a user's uploads, filtered by owner", async ({ page }) => {
    const { u, shas } = await seed(3);
    const other = await seed(1);
    await page.goto(mediaUrl(u.pubkey));
    for (const s of shas) await expect(openBtn(page, s)).toBeVisible();
    await expect(openBtn(page, other.shas[0])).toHaveCount(0);
    await expect(page.getByText("Select all (3/3)")).toBeVisible();
    // thumbnails are served from the session-authenticated media endpoint
    await expect(tile(page, shas[0]).locator("img")).toHaveAttribute("src", new RegExp(`/admin/api/media/${shas[0]}/raw`));
    await expect(page.getByRole("button", { name: "Clear owner filter" })).toBeVisible();
  });

  test("owner input filters the grid and Clear removes the filter", async ({ page }) => {
    const { u, shas } = await seed(1);
    await page.goto("media");
    await page.getByPlaceholder("Owner npub or hex").fill(u.pubkey);
    await page.getByPlaceholder("Owner npub or hex").press("Enter");
    await expect(page.getByText("Select all (1/1)")).toBeVisible();
    await expect(openBtn(page, shas[0])).toBeVisible();
    await page.getByRole("button", { name: "Clear owner filter" }).click();
    await expect(page.getByPlaceholder("Owner npub or hex")).toHaveValue("");
    await expect(page.getByText("Select all (1/1)")).toHaveCount(0);
  });

  test("status and type filters", async ({ page }) => {
    const { u, shas } = await seed(2);
    const pdf = await upload(u.sk, new TextEncoder().encode(`%PDF-1.4\n% ${Math.random()}\n%%EOF\n`), "application/pdf");
    expect((await ownerApi("POST", `/media/${shas[1]}/status`, { status: "blocked" })).status).toBe(200);
    await page.goto(mediaUrl(u.pubkey));
    await expect(page.getByText("Select all (3/3)")).toBeVisible();

    await page.getByRole("combobox").filter({ hasText: "Any status" }).click();
    await page.getByRole("option", { name: "blocked" }).click();
    await expect(page).toHaveURL(/status=blocked/);
    await expect(openBtn(page, shas[1])).toBeVisible();
    await expect(openBtn(page, shas[0])).toHaveCount(0);
    await expect(tile(page, shas[1]).getByText("blocked")).toBeVisible();

    await page.getByRole("combobox").filter({ hasText: "blocked" }).click();
    await page.getByRole("option", { name: "Any status" }).click();
    await page.getByRole("combobox").filter({ hasText: "Any type" }).click();
    await page.getByRole("option", { name: "Documents" }).click();
    await expect(page).toHaveURL(/type=application/);
    await expect(openBtn(page, pdf)).toBeVisible();
    await expect(page.getByText("Select all (1/1)")).toBeVisible();

    await page.getByRole("combobox").filter({ hasText: "Documents" }).click();
    await page.getByRole("option", { name: "Videos" }).click();
    await expect(page.getByText("No media")).toBeVisible();
  });
});

test.describe("media lightbox", () => {
  test("block then approve, with the actions disabled while a request is pending", async ({ page }) => {
    const { u, shas } = await seed(1);
    const sha = shas[0];
    let release!: () => void;
    let held = new Promise<void>((r) => (release = r));
    await page.route(`**/admin/api/media/${sha}/status`, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(mediaUrl(u.pubkey));
    await openBtn(page, sha).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("approved", { exact: true })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Approve" })).toHaveCount(0);

    await dlg.getByRole("button", { name: "Block" }).click();
    await expect(dlg.getByRole("button", { name: "Block" })).toBeDisabled();
    await expect(dlg.getByRole("button", { name: "Delete" })).toBeDisabled();
    release();
    await expect(page.getByText("Blob blocked")).toBeVisible();
    await expect(dlg.getByText("blocked", { exact: true })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Block" })).toHaveCount(0);
    expect((await blob(sha)).body.status).toBe("blocked");

    held = new Promise<void>((r) => (release = r));
    await dlg.getByRole("button", { name: "Approve" }).click();
    await expect(dlg.getByRole("button", { name: "Approve" })).toBeDisabled();
    release();
    await expect(dlg.getByText("approved", { exact: true })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Block" })).toBeEnabled();
    expect((await blob(sha)).body.status).toBe("approved");
  });

  test("delete from the lightbox removes the blob and (optionally) blocks the hash", async ({ page }) => {
    const { u, shas } = await seed(2);
    await page.goto(mediaUrl(u.pubkey));
    await openBtn(page, shas[0]).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText("Delete this blob?")).toBeVisible();
    await expect(confirm.getByRole("checkbox")).toBeChecked();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Blob deleted and blocked")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openBtn(page, shas[0])).toHaveCount(0);
    await expect(openBtn(page, shas[1])).toBeVisible();
    expect((await blob(shas[0])).status).toBe(404);
    expect((await fetch(`${http()}/${shas[0]}`)).status).toBe(404);
    const list = await ownerApi<{ items: { sha256: string }[] }>("GET", "/media/blocklist");
    expect(list.body.items.map((b) => b.sha256)).toContain(shas[0]);
  });

  test("arrow keys step through the grid", async ({ page }) => {
    const { u, shas } = await seed(2);
    await page.goto(mediaUrl(u.pubkey));
    const first = page.getByRole("button", { name: /^Open / }).first();
    await first.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Next" })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Previous" })).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(dlg.getByRole("button", { name: "Previous" })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Next" })).toHaveCount(0);
    // the second blob's hash is shown
    const shown = await dlg.locator("code").first().textContent();
    expect(shas.some((s) => shown!.startsWith(s.slice(0, 16)))).toBe(true);
  });
});

test.describe("media bulk actions", () => {
  test("select all → block, approve, delete", async ({ page }) => {
    const { u, shas } = await seed(3);
    await page.goto(mediaUrl(u.pubkey));
    await page.getByText("Select all (3/3)").click();
    await expect(page.getByText("3 selected")).toBeVisible();

    await page.getByRole("button", { name: "Block", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Block" }).click();
    await expect(page.getByText("3 blob(s) updated")).toBeVisible();
    await expect(page.getByText("3 selected")).toHaveCount(0);
    for (const s of shas) await expect(tile(page, s).getByText("blocked")).toBeVisible();
    for (const s of shas) expect((await blob(s)).body.status).toBe("blocked");

    await page.getByText("Select all (3/3)").click();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("3 selected")).toHaveCount(0);
    for (const s of shas) await expect(tile(page, s).getByText("blocked")).toHaveCount(0);
    for (const s of shas) expect((await blob(s)).body.status).toBe("approved");

    await page.getByText("Select all (3/3)").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alertdialog").getByText("Delete 3 blob(s)?")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No media")).toBeVisible();
    for (const s of shas) expect((await blob(s)).status).toBe(404);
  });

  test("while selecting, clicking a tile toggles it instead of opening the lightbox", async ({ page }) => {
    const { u, shas } = await seed(2);
    await page.goto(mediaUrl(u.pubkey));
    await tile(page, shas[0]).getByRole("checkbox", { name: "Select", exact: true }).check();
    await expect(page.getByText("1 selected")).toBeVisible();
    await openBtn(page, shas[1]).click();
    await expect(page.getByText("2 selected")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openBtn(page, shas[0]).click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await page.getByRole("button", { name: "Clear selection" }).click();
    await openBtn(page, shas[0]).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
