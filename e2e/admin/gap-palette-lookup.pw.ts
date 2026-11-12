/** Command palette lookups: pasted npub / nprofile / note / nevent / hex navigate to the right page. */
import { nip19 } from "nostr-tools";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { appHref, freshPage, makeAdmin, openPalette, signInWithKey } from "./auth-support";
import { seedUser, sign, publish, uid } from "./seed-users";

const filterOf = (url: string) => {
  const raw = new URL(url).searchParams.get("f")!;
  const once = JSON.parse(raw);
  return typeof once === "string" ? JSON.parse(once) : once;
};
const lookup = (page: Page) => page.getByRole("group", { name: "Lookup" });

async function seeded() {
  const text = `palette ${uid()}`;
  const u = await seedUser({ notes: [text] });
  const ev = sign(u.sk, { kind: 1, content: `${text} second` });
  await publish([ev]);
  return { u, ev, text };
}

test.describe("command palette lookups", () => {
  for (const kind of ["npub", "nostr:npub", "nprofile"] as const) {
    test(`a pasted ${kind} opens that user's page`, async ({ page }) => {
      const { u } = await seeded();
      const value = kind === "nprofile" ? nip19.nprofileEncode({ pubkey: u.pubkey }) : `${kind === "nostr:npub" ? "nostr:" : ""}${u.npub}`;
      await page.goto("./");
      await (await openPalette(page)).fill(value);
      await expect(lookup(page).getByRole("option")).toHaveCount(2); // Open user + Events by
      await expect(lookup(page).getByRole("option", { name: /Find event/ })).toHaveCount(0);
      await page.getByRole("option", { name: new RegExp(`Open user ${u.pubkey.slice(0, 8)}`) }).click();
      await expect.poll(() => appHref(page)).toBe(`/users/${u.pubkey}`);
      await expect(page.getByRole("heading", { level: 1, name: u.name })).toBeVisible();
      await expect(page.getByPlaceholder(/Search pages/)).toHaveCount(0);
    });
  }

  test("Events by <npub> lists that author's events", async ({ page }) => {
    const { u, text } = await seeded();
    await page.goto("./");
    await (await openPalette(page)).fill(u.npub);
    await page.getByRole("option", { name: /Events by/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
    expect(filterOf(page.url())).toEqual({ authors: [u.pubkey] });
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByText(`${text} second`)).toBeVisible();
  });

  for (const kind of ["note", "nevent"] as const) {
    test(`a pasted ${kind} finds exactly that event`, async ({ page }) => {
      const { ev, text } = await seeded();
      const value = kind === "note" ? nip19.noteEncode(ev.id) : nip19.neventEncode({ id: ev.id, author: ev.pubkey });
      await page.goto("./");
      await (await openPalette(page)).fill(value);
      await expect(lookup(page).getByRole("option")).toHaveCount(1);
      await page.getByRole("option", { name: new RegExp(`Find event ${ev.id.slice(0, 8)}`) }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
      expect(filterOf(page.url())).toEqual({ ids: [ev.id] });
      await expect(page.getByText(`${text} second`)).toBeVisible();
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    });
  }

  test("a 64-char hex offers user, event and author lookups (uppercase is normalised)", async ({ page }) => {
    const { u } = await seeded();
    await page.goto("./");
    await (await openPalette(page)).fill(u.pubkey.toUpperCase());
    await expect(lookup(page).getByRole("option")).toHaveCount(3);
    await page.getByRole("option", { name: /Open user/ }).click();
    await expect.poll(() => appHref(page)).toBe(`/users/${u.pubkey}`);
  });

  test("an npub with a broken checksum is not a lookup; the search entries show instead", async ({ page }) => {
    const { u } = await seeded();
    const broken = u.npub.slice(0, -1) + (u.npub.endsWith("q") ? "p" : "q");
    await page.goto("./");
    await (await openPalette(page)).fill(broken);
    await expect(lookup(page)).toHaveCount(0);
    await expect(page.getByRole("option", { name: /Search users for/ })).toBeVisible();
  });

  test("without content.view only the user lookup is offered", async ({ browser, baseURL }) => {
    // every built-in role has content.view, so the gate is checked with a `me` stripped of it
    const admin = await makeAdmin("viewer");
    const { context, page } = await freshPage(browser, baseURL!);
    try {
      await page.goto("login");
      await signInWithKey(page, admin.nsec);
      await expect(page).not.toHaveURL(/\/login/);
      await page.route("**/api/auth/me", async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        json.permissions = json.permissions.filter((p: string) => p !== "content.view");
        return route.fulfill({ response: res, json });
      });
      await page.goto("./");
      const { u, ev } = await seeded();
      await (await openPalette(page)).fill(u.npub);
      await expect(lookup(page).getByRole("option")).toHaveCount(1);
      await expect(lookup(page).getByRole("option", { name: /Open user/ })).toBeVisible();
      await page.getByPlaceholder(/Search pages/).fill(nip19.noteEncode(ev.id));
      await expect(page.getByRole("option", { name: /Find event/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("command palette commands", () => {
  test("regression: typing a command's name and pressing Enter runs it, not a user search", async ({ page }) => {
    await page.goto("./");
    await (await openPalette(page)).fill("dark theme");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect.poll(() => appHref(page)).not.toContain("/users");
  });
});
