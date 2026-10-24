/** NIP-29 groups: list, search, detail (admins, members, roles, flags), delete with confirm, permissions. */
import type { Page } from "@playwright/test";
import { newUser, sign } from "../harness/client";
import { test, expect, owner } from "./fixtures";
import { freshPage, makeAdmin, ownerApi, ownerSk, signInWithKey, toast, uniq } from "./auth-support";
import { publish, queryWs } from "./seed-content";

interface Seeded { id: string; name: string; about: string; members: { pubkey: string; roles: string[] }[] }

/** The owner (relay staff) creates a group over ws and puts two members in it, one as moderator. */
async function seedGroup(opts: { private?: boolean; closed?: boolean } = {}): Promise<Seeded> {
  const id = uniq("grp").replace(/[^a-zA-Z0-9_-]/g, "");
  const name = `Group ${id}`;
  const about = `about ${id}`;
  const tags = [["h", id], ["name", name], ["about", about]];
  if (opts.private) tags.push(["private"]);
  if (opts.closed) tags.push(["closed"]);
  const sk = ownerSk();
  const mod = newUser().pubkey;
  const plain = newUser().pubkey;
  await publish(sign(sk, { kind: 9007, tags }));
  await publish(sign(sk, { kind: 9000, tags: [["h", id], ["p", mod, "moderator"]] }), sign(sk, { kind: 9000, tags: [["h", id], ["p", plain]] }));
  return { id, name, about, members: [{ pubkey: owner().pubkey, roles: ["admin"] }, { pubkey: mod, roles: ["moderator"] }, { pubkey: plain, roles: [] }] };
}

const groupCard = (page: Page, id: string) => page.getByRole("link").filter({ hasText: id });

test.describe("groups", () => {
  test("the list shows a seeded group with its flags and member count; search narrows it", async ({ page }) => {
    const g = await seedGroup({ private: true, closed: true });
    const other = await seedGroup();
    await page.goto("groups");
    await expect(page.getByRole("heading", { level: 1, name: "Groups" })).toBeVisible();
    const card = groupCard(page, g.id);
    await expect(card).toContainText(g.name);
    await expect(card).toContainText(g.about);
    await expect(card).toContainText("private");
    await expect(card).toContainText("closed");
    await expect(card).toContainText("3 members");
    await expect(groupCard(page, other.id)).not.toContainText("private");

    const search = page.getByPlaceholder("Search groups…");
    await search.fill(g.id);
    await expect(groupCard(page, g.id)).toBeVisible();
    await expect(groupCard(page, other.id)).toHaveCount(0);
    await search.fill(`about ${other.id}`); // matches the description too
    await expect(groupCard(page, other.id)).toBeVisible();
    await expect(groupCard(page, g.id)).toHaveCount(0);
    await search.fill(uniq("nothing"));
    await expect(page.getByText("No group matches your search.")).toBeVisible();
  });

  test("the detail page lists admins and members with their roles", async ({ page }) => {
    const g = await seedGroup({ private: true });
    await page.goto("groups");
    await groupCard(page, g.id).click();
    await expect(page).toHaveURL(new RegExp(`/groups/${g.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: g.name })).toBeVisible();
    await expect(page.locator("code", { hasText: g.id })).toBeVisible();
    await expect(page.getByText(g.about)).toBeVisible();
    await expect(page.getByText("private", { exact: true })).toBeVisible();
    await expect(page.getByText(/^3 members · created/)).toBeVisible();
    // admins = members holding any role (NIP-29 39001)
    await expect(page.getByText("Admins (2)")).toBeVisible();
    const members = page.locator('[data-slot="card"]').filter({ hasText: "Members (3)" });
    await expect(members).toBeVisible();
    await expect(members.getByText("moderator", { exact: true })).toHaveCount(1);
    await expect(members.getByText("admin", { exact: true })).toHaveCount(1);

    await page.getByRole("link", { name: "Groups" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Groups" })).toBeVisible();
  });

  test("an unknown group id shows the not-found error", async ({ page }) => {
    await page.goto(`groups/${uniq("nope")}`);
    await expect(page.getByText(/group not found/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete group" })).toHaveCount(0);
  });

  test("delete asks for confirmation; Cancel keeps it, Delete removes the group and its events", async ({ page }) => {
    const g = await seedGroup();
    const content = sign(newUser().sk, { kind: 9, content: `hello ${g.id}`, tags: [["h", g.id]] });
    await publish(content);
    expect(await queryWs([{ ids: [content.id] }])).toHaveLength(1);
    await page.goto(`groups/${g.id}`);
    await page.getByRole("button", { name: "Delete group" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`Delete group “${g.name}”?`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await ownerApi("GET", `/groups/${g.id}`)).status).toBe(200);

    await page.getByRole("button", { name: "Delete group" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete group" }).click();
    await expect(toast(page, "Group deleted")).toBeVisible();
    await expect(page).toHaveURL(/\/groups$/);
    await expect(groupCard(page, g.id)).toHaveCount(0);
    expect((await ownerApi("GET", `/groups/${g.id}`)).status).toBe(404);
    await expect.poll(async () => (await queryWs([{ ids: [content.id] }])).length).toBe(0);
    const audit = await ownerApi<{ items: { action: string; target: string }[] }>("GET", `/audit?action=group.delete&target=${g.id}`);
    expect(audit.body.items).toHaveLength(1);
  });

  test("a viewer sees groups but no Delete button", async ({ browser, baseURL }) => {
    const g = await seedGroup();
    const viewer = await makeAdmin("viewer");
    const { context, page } = await freshPage(browser, baseURL!);
    try {
      await page.goto("login");
      await signInWithKey(page, viewer.nsec);
      await expect(page).not.toHaveURL(/\/login/);
      await page.goto(`groups/${g.id}`);
      await expect(page.getByRole("heading", { level: 1, name: g.name })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete group" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
