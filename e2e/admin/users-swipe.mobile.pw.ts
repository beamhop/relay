import type { Page } from "@playwright/test";
import { loginWithKey } from "./fixtures";
import { apiOk, countRequests, expect, getUser, longPress, makeUser, seedUser, setRole, swipe, test, uid } from "./seed-users";

// the desktop project matches every *.pw.ts: these gestures only make sense on the phone layout
test.skip(({ isMobile }) => !isMobile, "phone layout only");

/** the tappable card (link) for a user in the mobile list */
const card = (page: Page, pubkey: string) => page.locator(`a[href$="/users/${pubkey}"]`);
const cardBox = (page: Page, pubkey: string) => card(page, pubkey).locator("..");
const selectionBar = (page: Page) => page.getByText(/^\d+ selected$/);

async function taggedUsers(tag: string, n: number) {
  const users = await Promise.all(Array.from({ length: n }, () => seedUser()));
  for (const u of users) await apiOk("PATCH", `/users/${u.pubkey}`, { tags: [tag] });
  return users;
}

async function openTag(page: Page, tag: string, count: number) {
  await page.goto(`users?tag=${tag}`);
  await expect(page.locator('a[href*="/users/"]').filter({ has: page.locator("img, span") }).first()).toBeVisible();
  await expect(page.getByText(`${count} user`)).toBeVisible();
}

test.describe("users list on a phone", () => {
  test("long-press starts selection, taps then toggle cards", async ({ page }) => {
    const tag = uid("lp");
    const [a, b] = await taggedUsers(tag, 2);
    await openTag(page, tag, 2);
    await longPress(page, card(page, a.pubkey));
    await expect(selectionBar(page)).toHaveText("1 selected");
    // still on the list: the long-press must not have opened the user
    await expect(page).toHaveURL(/\/users\?/);
    await card(page, b.pubkey).tap();
    await expect(selectionBar(page)).toHaveText("2 selected");
    await expect(page).toHaveURL(/\/users\?/);
    await card(page, a.pubkey).tap();
    await expect(selectionBar(page)).toHaveText("1 selected");
    await expect(cardBox(page, b.pubkey).getByRole("checkbox", { name: "Select" })).toBeChecked();
    await expect(cardBox(page, a.pubkey).getByRole("checkbox", { name: "Select" })).not.toBeChecked();
    // last one deselected: selection mode ends and a tap opens the user again
    await card(page, b.pubkey).tap();
    await expect(selectionBar(page)).toHaveCount(0);
    await card(page, b.pubkey).tap();
    await expect(page).toHaveURL(new RegExp(`/users/${b.pubkey}$`));
  });

  test("bulk mute from a long-press selection", async ({ page }) => {
    const tag = uid("lm");
    const [a, b] = await taggedUsers(tag, 2);
    await openTag(page, tag, 2);
    await longPress(page, card(page, a.pubkey));
    await card(page, b.pubkey).tap();
    await page.getByRole("button", { name: "Mute", exact: true }).tap();
    await expect(page.getByText("2 updated")).toBeVisible();
    await expect(selectionBar(page)).toHaveCount(0);
    await expect.poll(async () => (await getUser(a.pubkey)).status).toBe("muted");
    await expect(card(page, b.pubkey).getByText("muted", { exact: true })).toBeVisible();
  });

  test("swipe left bans (after confirming), swipe right unbans", async ({ page }) => {
    const tag = uid("sw");
    const [u] = await taggedUsers(tag, 1);
    await openTag(page, tag, 1);
    await swipe(page, card(page, u.pubkey), "left");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText(`Ban ${u.name}?`)).toBeVisible();
    await dialog.getByRole("button", { name: "Ban user" }).tap();
    await expect(card(page, u.pubkey).getByText("banned", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).status).toBe("banned");

    await swipe(page, card(page, u.pubkey), "right");
    await expect(card(page, u.pubkey).getByText("active", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).status).toBe("active");
  });

  test("swipe left then Cancel leaves the user active", async ({ page }) => {
    const tag = uid("sc");
    const [u] = await taggedUsers(tag, 1);
    await openTag(page, tag, 1);
    await swipe(page, card(page, u.pubkey), "left");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(card(page, u.pubkey).getByText("active", { exact: true })).toBeVisible();
    await expect(card(page, u.pubkey)).toBeInViewport();
    expect((await getUser(u.pubkey)).status).toBe("active");
  });

  test("swipe right on an active, not allow-listed user allows them", async ({ page }) => {
    const tag = uid("sa");
    const [u] = await taggedUsers(tag, 1);
    await openTag(page, tag, 1);
    await swipe(page, card(page, u.pubkey), "right");
    await expect(card(page, u.pubkey).getByText("allowed", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).allowed).toBe(true);
  });

  test("a short slow drag snaps back without acting", async ({ page }) => {
    const tag = uid("sh");
    const [u] = await taggedUsers(tag, 1);
    await openTag(page, tag, 1);
    const reqs = countRequests(page, (url, m) => m !== "GET" && url.includes("/admin/api/users"));
    // a slow 40px drag each way stays under the trigger distance and snaps back
    await swipe(page, card(page, u.pubkey), "left", 40);
    await swipe(page, card(page, u.pubkey), "right", 40);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(card(page, u.pubkey).getByText("active", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/users\?/);
    expect(reqs.n).toBe(0);
  });
});

test.describe("swipe permissions", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an admin with users.edit but not users.ban can still swipe Allow, but not Ban", async ({ page }) => {
    const mod = makeUser();
    await setRole(mod.pubkey, "moderator");
    const tag = uid("pe");
    const [u] = await taggedUsers(tag, 1);
    // no built-in role has users.edit without users.ban: take users.ban away from this moderator's session
    await page.route("**/admin/api/auth/me", async (route) => {
      const res = await route.fetch();
      const me = await res.json();
      me.permissions = me.permissions.filter((p: string) => p !== "users.ban");
      await route.fulfill({ response: res, json: me });
    });
    await loginWithKey(page, mod.nsec);
    await openTag(page, tag, 1);

    const writes = countRequests(page, (url, m) => m !== "GET" && url.includes("/admin/api/users"));
    await swipe(page, card(page, u.pubkey), "left");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(writes.n).toBe(0);

    await swipe(page, card(page, u.pubkey), "right");
    await expect(card(page, u.pubkey).getByText("allowed", { exact: true })).toBeVisible();
    expect((await getUser(u.pubkey)).allowed).toBe(true);
    expect((await getUser(u.pubkey)).status).toBe("active");
  });

  test("a viewer can't swipe anything", async ({ page }) => {
    const viewer = makeUser();
    await setRole(viewer.pubkey, "viewer");
    const tag = uid("pv");
    const [u] = await taggedUsers(tag, 1);
    await loginWithKey(page, viewer.nsec);
    await openTag(page, tag, 1);
    const writes = countRequests(page, (url, m) => m !== "GET" && url.includes("/admin/api/"));
    await swipe(page, card(page, u.pubkey), "left");
    await swipe(page, card(page, u.pubkey), "right");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(card(page, u.pubkey).getByText("active", { exact: true })).toBeVisible();
    expect(writes.n).toBe(0);
    expect((await getUser(u.pubkey)).allowed).toBe(false);
  });
});
