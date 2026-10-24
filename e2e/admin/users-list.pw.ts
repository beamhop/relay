import type { Page } from "@playwright/test";
import { addTaggedUsers, apiOk, countRequests, expect, fail500, getUser, publish, seedUser, setRole, sign, test, uid } from "./seed-users";

const rows = (page: Page) => page.locator("tbody tr");
const row = (page: Page, text: string) => page.locator("tbody tr").filter({ hasText: text });
const selectionBar = (page: Page) => page.getByText(/^\d+ selected$/);

async function pick(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function openTag(page: Page, tag: string) {
  await page.goto(`users?tag=${tag}`);
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
}

/** Users with `tag`, each having published a profile (so their name shows) and `notes[i]` kind-1 notes. */
async function taggedNamedUsers(tag: string, noteCounts: number[]) {
  return Promise.all(
    noteCounts.map(async (n) => {
      const u = await seedUser({ notes: Array.from({ length: n }, (_, i) => `note ${i} ${uid()}`) });
      await apiOk("PATCH", `/users/${u.pubkey}`, { tags: [tag] });
      return u;
    }),
  );
}

test.describe("users list: search and filters", () => {
  test("search by profile name narrows the list", async ({ page }) => {
    const u = await seedUser();
    const other = await seedUser();
    await page.goto("users");
    await page.getByPlaceholder("Search npub, hex, name, nip05, notes…").fill(u.name);
    await expect(page).toHaveURL(new RegExp(`search=${u.name}`));
    await expect(row(page, u.name)).toBeVisible();
    await expect(row(page, other.name)).toHaveCount(0);
    await expect(page.getByText(/^1 user$/)).toBeVisible();
  });

  test("search by npub finds exactly that user; nonsense search shows the empty state", async ({ page }) => {
    const u = await seedUser();
    await page.goto("users");
    const box = page.getByPlaceholder("Search npub, hex, name, nip05, notes…");
    await box.fill(u.npub);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, u.name)).toBeVisible();
    await box.fill(uid("nobody"));
    await expect(page.getByText("No users found")).toBeVisible();
  });

  test("status filter shows only banned / muted users", async ({ page }) => {
    const tag = uid("st");
    const [active, banned, muted] = await taggedNamedUsers(tag, [0, 0, 0]);
    await apiOk("POST", `/users/${banned.pubkey}/ban`, {});
    await apiOk("POST", `/users/${muted.pubkey}/mute`);
    await openTag(page, tag);
    await expect(rows(page)).toHaveCount(3);
    await pick(page, "Status", "banned");
    await expect(page).toHaveURL(/status=banned/);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, banned.name)).toBeVisible();
    await pick(page, "Status", "muted");
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, muted.name)).toBeVisible();
    await pick(page, "Status", "active");
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, active.name)).toBeVisible();
  });

  test("role filter shows only users with that admin role", async ({ page }) => {
    const tag = uid("rl");
    const [mod, plain] = await taggedNamedUsers(tag, [0, 0]);
    await setRole(mod.pubkey, "moderator");
    await openTag(page, tag);
    await expect(rows(page)).toHaveCount(2);
    await pick(page, "Role", "moderator");
    await expect(page).toHaveURL(/role=moderator/);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, mod.name)).toBeVisible();
    await expect(row(page, plain.name)).toHaveCount(0);
    await pick(page, "Role", "viewer");
    await expect(page.getByText("No users found")).toBeVisible();
  });

  test("allow-list filter splits allowed and not allowed users", async ({ page }) => {
    const tag = uid("al");
    const [allowed, notAllowed] = await taggedNamedUsers(tag, [0, 0]);
    await apiOk("PATCH", `/users/${allowed.pubkey}`, { allowed: true });
    await openTag(page, tag);
    await pick(page, "Allow-list", "Allowed");
    await expect(page).toHaveURL(/allowed=true/);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, allowed.name)).toBeVisible();
    await pick(page, "Allow-list", "Not allowed");
    await expect(page).toHaveURL(/allowed=false/);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, notAllowed.name)).toBeVisible();
  });

  test("tag filter: typing a tag and clicking a tag badge both filter", async ({ page }) => {
    const tag = uid("tg");
    const tag2 = uid("tg");
    const [a, b] = await taggedNamedUsers(tag, [0, 0]);
    await apiOk("PATCH", `/users/${b.pubkey}`, { tags: [tag, tag2] });
    await page.goto("users");
    const input = page.getByPlaceholder("Tag", { exact: true });
    await input.fill(tag);
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
    await expect(rows(page)).toHaveCount(2);
    await row(page, b.name).getByText(tag2, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`tag=${tag2}`));
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, b.name)).toBeVisible();
    await expect(row(page, a.name)).toHaveCount(0);
  });

  test("sort by event count orders the most active user first", async ({ page }) => {
    const tag = uid("so");
    const [one, three, two] = await taggedNamedUsers(tag, [1, 3, 2]);
    await openTag(page, tag);
    await pick(page, "Sort", "Event count");
    await expect(page).toHaveURL(/sort=eventCount/);
    await expect(rows(page).nth(0)).toContainText(three.name);
    await expect(rows(page).nth(1)).toContainText(two.name);
    await expect(rows(page).nth(2)).toContainText(one.name);
    // profile + notes
    await expect(rows(page).nth(0).locator("td").nth(4)).toHaveText("4");
    await expect(rows(page).nth(2).locator("td").nth(4)).toHaveText("2");
  });

  test("Clear removes every filter", async ({ page }) => {
    const tag = uid("cl");
    await taggedNamedUsers(tag, [0]);
    await page.goto(`users?tag=${tag}&status=banned&role=viewer&allowed=true`);
    await expect(page.getByText("No users found")).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page).not.toHaveURL(/status=|role=|tag=|allowed=/);
    await expect(page.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Status" })).toHaveText("Any status");
    await expect(page.getByPlaceholder("Tag", { exact: true })).toHaveValue("");
    await expect(rows(page).first()).toBeVisible();
  });

  test("more than one page: infinite scroll loads the rest", async ({ page }) => {
    const tag = uid("pg");
    await addTaggedUsers(57, tag);
    await openTag(page, tag);
    await expect(page.getByText("57 users")).toBeVisible();
    await expect(rows(page)).toHaveCount(50);
    await page.locator("tbody tr").last().scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 5000);
    await expect(rows(page)).toHaveCount(57);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("more than one page: Load more button fetches the next page", async ({ page }) => {
    const tag = uid("lm");
    await addTaggedUsers(52, tag);
    // keep the sentinel out of view so only the button can load the next page
    await page.setViewportSize({ width: 1280, height: 400 });
    await openTag(page, tag);
    await expect(rows(page)).toHaveCount(50);
    const more = countRequests(page, (u) => /\/admin\/api\/users\?/.test(u) && /offset=50/.test(u));
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rows(page)).toHaveCount(52);
    expect(more.n).toBe(1);
  });
});

test.describe("users list: bulk actions", () => {
  // routes mock API calls: keep the PWA service worker out, or requests it has claimed bypass page.route (seed-users fail500)
  test.use({ serviceWorkers: "block" });
  test("select all + bulk ban with reason bans every selected user", async ({ page }) => {
    const tag = uid("bb");
    const users = await taggedNamedUsers(tag, [0, 0, 0]);
    await openTag(page, tag);
    await expect(rows(page)).toHaveCount(3);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(selectionBar(page)).toHaveText("3 selected");
    await page.getByRole("button", { name: "Ban", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Ban 3 user(s)?")).toBeVisible();
    await dialog.getByLabel("Reason (optional)").fill("bulk spam");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("3 updated")).toBeVisible();
    await expect(selectionBar(page)).toHaveCount(0);
    for (const u of users) await expect(row(page, u.name).getByText("banned", { exact: true })).toBeVisible();
    for (const u of users) expect((await getUser(u.pubkey)).banReason).toBe("bulk spam");
  });

  test("bulk ban dialog Cancel changes nothing and keeps the selection", async ({ page }) => {
    const tag = uid("bc");
    const [u] = await taggedNamedUsers(tag, [0]);
    await openTag(page, tag);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await page.getByRole("button", { name: "Ban", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(selectionBar(page)).toHaveText("1 selected");
    expect((await getUser(u.pubkey)).status).toBe("active");
  });

  test("bulk unban and bulk mute", async ({ page }) => {
    const tag = uid("bu");
    const [a, b] = await taggedNamedUsers(tag, [0, 0]);
    await apiOk("POST", "/users/bulk", { pubkeys: [a.pubkey, b.pubkey], action: "ban" });
    await openTag(page, tag);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    // only banned users selected: no Ban/Mute, only Unban
    await expect(page.getByRole("button", { name: "Mute", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Unban", exact: true }).click();
    await expect(page.getByText("2 updated")).toBeVisible();
    await expect(row(page, a.name).getByText("active", { exact: true })).toBeVisible();
    await expect(row(page, b.name).getByText("active", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(row(page, a.name).getByText("muted", { exact: true })).toBeVisible();
    await expect(row(page, b.name).getByText("muted", { exact: true })).toBeVisible();
  });

  test("bulk add tag and remove tag", async ({ page }) => {
    const tag = uid("bt");
    const extra = uid("vip");
    const [a, b] = await taggedNamedUsers(tag, [0, 0]);
    await openTag(page, tag);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Add tag…" }).click();
    let dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Add tag")).toBeVisible();
    await dialog.getByLabel("Tag").fill(extra);
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(row(page, a.name).getByText(extra)).toBeVisible();
    await expect(row(page, b.name).getByText(extra)).toBeVisible();

    await page.getByRole("checkbox", { name: "Select all" }).click();
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Remove tag…" }).click();
    dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Tag").fill(extra);
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(extra)).toHaveCount(0);
    expect((await getUser(a.pubkey)).tags).toEqual([tag]);
  });

  test("bulk delete events zeroes the selected users' event counts", async ({ page }) => {
    const tag = uid("de");
    const [a, b] = await taggedNamedUsers(tag, [2, 3]);
    await openTag(page, tag);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete events" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Delete all events of 2 user(s)?")).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("2 updated")).toBeVisible();
    await expect.poll(async () => (await getUser(a.pubkey)).stats.eventCount).toBe(0);
    await expect.poll(async () => (await getUser(b.pubkey)).stats.eventCount).toBe(0);
  });

  test("bulk delete: list, header count and selection count match what is left", async ({ page }) => {
    const tag = uid("dl");
    const users = await taggedNamedUsers(tag, [0, 0, 0, 0]);
    await openTag(page, tag);
    await expect(page.getByText("4 users")).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await row(page, users[3].name).getByRole("checkbox", { name: "Select", exact: true }).click();
    await expect(selectionBar(page)).toHaveText("3 selected");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete users" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Delete 3 user(s)?")).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("3 updated")).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, users[3].name)).toBeVisible();
    await expect(page.getByText(/^1 user$/)).toBeVisible();
    await expect(selectionBar(page)).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(selectionBar(page)).toHaveText("1 selected");
  });

  test("selection drops users that leave the filtered list", async ({ page }) => {
    const tag = uid("sd");
    const [a, b] = await taggedNamedUsers(tag, [0, 0]);
    await page.goto(`users?tag=${tag}&status=active`);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(selectionBar(page)).toHaveText("2 selected");
    // a is banned by someone else; the list refetches (window focus / invalidation) and a leaves the active filter
    await apiOk("POST", `/users/${a.pubkey}/ban`, {});
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Allow", exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, b.name)).toBeVisible();
    await expect(selectionBar(page)).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(selectionBar(page)).toHaveText("1 selected");
  });

  test("regression: double-clicking a bulk action (Mute) sends one /users/bulk request", async ({ page }) => {
    const tag = uid("dc");
    const [a] = await taggedNamedUsers(tag, [0, 0]);
    await openTag(page, tag);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    const bulk = countRequests(page, (u, m) => m === "POST" && u.endsWith("/admin/api/users/bulk"));
    await page.getByRole("button", { name: "Mute", exact: true }).dblclick();
    await expect(row(page, a.name).getByText("muted", { exact: true })).toBeVisible();
    await expect(page.getByText("2 updated").first()).toBeVisible();
    expect(bulk.n).toBe(1);
    await expect(page.getByText("2 updated")).toHaveCount(1);
  });

  test("double-clicking Confirm in a bulk dialog sends a single request", async ({ page }) => {
    const tag = uid("dd");
    const [a] = await taggedNamedUsers(tag, [0, 0]);
    await openTag(page, tag);
    await page.getByRole("checkbox", { name: "Select all" }).click();
    const bulk = countRequests(page, (u, m) => m === "POST" && u.endsWith("/admin/api/users/bulk"));
    await page.getByRole("button", { name: "Ban", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).dblclick();
    await expect(row(page, a.name).getByText("banned", { exact: true })).toBeVisible();
    expect(bulk.n).toBe(1);
  });

  test("a failing bulk request shows a toast and keeps the selection", async ({ page, allowServerErrors }) => {
    allowServerErrors();
    const tag = uid("bf");
    const [a, b] = await taggedNamedUsers(tag, [0, 0]);
    await openTag(page, tag);
    await fail500(page, "**/admin/api/users/bulk", "POST");
    await page.getByRole("checkbox", { name: "Select all" }).click();
    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(page.getByText("Action failed")).toBeVisible();
    await expect(page.getByText("boom from test")).toBeVisible();
    await expect(selectionBar(page)).toHaveText("2 selected");
    await expect(row(page, a.name).getByText("active", { exact: true })).toBeVisible();
    // the bar is usable again after the failure
    await expect(page.getByRole("button", { name: "Mute", exact: true })).toBeEnabled();
    expect((await getUser(b.pubkey)).status).toBe("active");
  });
});
