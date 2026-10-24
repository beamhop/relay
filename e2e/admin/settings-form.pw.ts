import { test, expect } from "./fixtures";
import { ownerApi, toast, uniq } from "./auth-support";
import type { Page } from "@playwright/test";

const SECTIONS = [
  { key: "info", label: "Relay info", description: "Public NIP-11 information document", field: "Name" },
  { key: "access", label: "Access", description: "Who can read from and write to the relay", field: "Require AUTH to read" },
  { key: "limits", label: "Limits", description: "Message sizes, subscription limits and rate limits", field: "Max subscriptions" },
  { key: "moderation", label: "Moderation", description: "Kind filters, word filters and automatic actions", field: "Auto-ban after N reports" },
  { key: "retention", label: "Retention", description: "Automatically prune old events", field: "Run every" },
  { key: "nip05", label: "NIP-05", description: "name@domain identifiers served by this relay", field: "Domain" },
  { key: "groups", label: "Groups", description: "NIP-29 relay-based groups", field: "Enable NIP-29 groups" },
  { key: "blossom", label: "Blossom", description: "Media uploads and storage", field: "Strip EXIF metadata" },
];

const settingsNav = (page: Page) => page.getByRole("main").locator("nav").first();
const unsaved = (page: Page) => page.getByText("Unsaved changes");
const getSettings = async () => {
  const r = await ownerApi("GET", "/settings");
  expect(r.status).toBe(200);
  return r.body.settings;
};

test("/settings redirects to the first section", async ({ page }) => {
  await page.goto("settings");
  await expect(page).toHaveURL(/\/settings\/info$/);
  await expect(page.getByText("Public NIP-11 information document")).toBeVisible();
});

test("an unknown settings section is a 404", async ({ page }) => {
  await page.goto("settings/nope");
  await expect(page.getByText("Page not found")).toBeVisible();
});

test("every settings section loads with its fields and a clean form", async ({ page }) => {
  await page.goto("settings/info");
  for (const s of SECTIONS) {
    await settingsNav(page).getByRole("link", { name: s.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/${s.key}$`));
    await expect(page.getByText(s.description, { exact: true })).toBeVisible();
    await expect(page.getByLabel(s.field, { exact: true }).first()).toBeVisible();
    await expect(settingsNav(page).getByRole("link", { name: s.label, exact: true })).toHaveClass(/font-medium/);
    // nothing to save on a freshly loaded section
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByText(/failed to render|Please fix/)).toHaveCount(0);
  }
});

test.describe("info section", () => {
  test("editing shows the save bar; Discard restores the original value", async ({ page }) => {
    await page.goto("settings/info");
    const name = page.getByLabel("Name", { exact: true });
    const original = (await getSettings()).info.name;
    await expect(name).toHaveValue(original);
    await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);

    await name.fill(uniq("edited"));
    await expect(unsaved(page)).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(name).toHaveValue(original);
    await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
    expect((await getSettings()).info.name).toBe(original);
  });

  test("typing the original value back makes the form clean again", async ({ page }) => {
    await page.goto("settings/info");
    const contact = page.getByLabel("Contact", { exact: true });
    const original = await contact.inputValue();
    await contact.fill(`${original}x`);
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await contact.fill(original);
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("Save persists across reloads and through the API", async ({ page }) => {
    await page.goto("settings/info");
    const name = uniq("relay");
    const description = `described ${uniq()}`;
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description", { exact: true }).fill(description);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Settings saved")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

    const s = await getSettings();
    expect(s.info.name).toBe(name);
    expect(s.info.description).toBe(description);
    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(description);
    // NIP-11 serves it too
    const nip11 = await (await page.request.get("/", { headers: { Accept: "application/nostr+json" } })).json();
    expect(nip11.name).toBe(name);
  });

  test("an invalid URL is flagged and nothing is saved", async ({ page }) => {
    await page.goto("settings/info");
    const before = (await getSettings()).info.icon;
    const icon = page.getByLabel("Icon URL", { exact: true });
    await icon.fill("not a url");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
    await expect(icon).toHaveAttribute("aria-invalid", "true");
    await expect(unsaved(page)).toBeVisible();
    expect((await getSettings()).info.icon).toBe(before);
  });

  test("an invalid operator pubkey is marked invalid; an npub is stored as hex", async ({ page }) => {
    await page.goto("settings/info");
    const pk = page.getByPlaceholder("npub or hex");
    await pk.fill("npub1invalid");
    await expect(pk).toHaveAttribute("aria-invalid", "true");
    await pk.fill("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6");
    await pk.blur();
    await expect(pk).toHaveValue("3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d");
    await expect(pk).toHaveAttribute("aria-invalid", "false");
  });
});

test("regression: the Operator pubkey label is associated with its input", async ({ page }) => {
  await page.goto("settings/info");
  await expect(page.getByLabel("Operator pubkey", { exact: true })).toBeVisible();
});

test("an empty required number shows a validation error", async ({ page }) => {
  await page.goto("settings/limits");
  const before = (await getSettings()).limits.maxSubscriptions;
  const f = page.getByLabel("Max subscriptions", { exact: true });
  await f.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
  await expect(f).toHaveAttribute("aria-invalid", "true");
  expect((await getSettings()).limits.maxSubscriptions).toBe(before);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(f).toHaveValue(String(before));
  await expect(page.getByText("Please fix the highlighted fields.")).toHaveCount(0);
});

test.describe("moderation word filters", () => {
  test("add, save, verify via API, then remove and save", async ({ page }) => {
    const pattern = uniq("badword");
    await page.goto("settings/moderation");
    await page.getByRole("button", { name: "Add word filter" }).click();
    await page.getByPlaceholder("word or phrase").last().fill(pattern);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Settings saved")).toBeVisible();
    expect((await getSettings()).moderation.wordFilters.map((w: { pattern: string }) => w.pattern)).toContain(pattern);

    await page.reload();
    const row = page.locator("div.rounded-lg.border").filter({ has: page.locator(`input[value="${pattern}"]`) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Remove filter" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Settings saved")).toBeVisible();
    await expect.poll(async () => (await getSettings()).moderation.wordFilters.map((w: { pattern: string }) => w.pattern)).not.toContain(pattern);
  });

  test("an empty pattern is refused before saving", async ({ page }) => {
    await page.goto("settings/moderation");
    await page.getByRole("button", { name: "Add word filter" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Word filters need a pattern")).toBeVisible();
  });

  test("an unsafe regex is flagged inline and refused on save", async ({ page }) => {
    await page.goto("settings/moderation");
    const before = (await getSettings()).moderation.wordFilters.length;
    await page.getByRole("button", { name: "Add word filter" }).click();
    const row = page.locator("div.rounded-lg.border").filter({ has: page.getByRole("button", { name: "Remove filter" }) }).last();
    await row.getByRole("switch").nth(1).click(); // Regex
    await row.getByPlaceholder("regular expression").fill("(a+)+$");
    await expect(row.getByPlaceholder("regular expression")).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Regex refused/)).toBeVisible();
    expect((await getSettings()).moderation.wordFilters.length).toBe(before);
  });
});

test("the hidden save bar is not keyboard-focusable while the form is clean", async ({ page }) => {
  await page.goto("settings/info");
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  const bar = page.locator("[inert]").filter({ hasText: "Unsaved changes" });
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAttribute("aria-hidden", "true");
  // tab forward from the last field: focus must skip the invisible Discard/Save buttons
  await page.getByLabel("Posting policy URL", { exact: true }).focus();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  }
  // programmatic focus is refused too
  await bar.locator("button").last().evaluate((b: HTMLButtonElement) => b.focus());
  expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(false);

  // once dirty the bar is reachable
  await page.getByLabel("Posting policy URL", { exact: true }).fill("https://example.com/policy");
  await expect(page.locator("[inert]").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Discard" })).toBeFocused();
});

test("switching sections discards unsaved edits of the previous one", async ({ page }) => {
  await page.goto("settings/info");
  const original = await page.getByLabel("Name", { exact: true }).inputValue();
  await page.getByLabel("Name", { exact: true }).fill(uniq("unsaved"));
  await expect(unsaved(page)).toBeVisible();
  await settingsNav(page).getByRole("link", { name: "Access", exact: true }).click();
  await expect(page.getByText("Who can read from and write to the relay")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await settingsNav(page).getByRole("link", { name: "Relay info", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(original);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("a switch toggle is saved and can be toggled back", async ({ page }) => {
  await page.goto("settings/blossom");
  const before = (await getSettings()).blossom.thumbnails;
  const sw = page.getByRole("switch", { name: "Generate thumbnails" });
  await expect(sw).toHaveAttribute("data-state", before ? "checked" : "unchecked");
  await sw.click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Settings saved")).toBeVisible();
  await expect.poll(async () => (await getSettings()).blossom.thumbnails).toBe(!before);
  await sw.click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await getSettings()).blossom.thumbnails).toBe(before);
});

test("changes made elsewhere show up without clobbering a clean form", async ({ page }) => {
  await page.goto("settings/info");
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  const contact = `mailto:${uniq("ops")}@example.com`;
  expect((await ownerApi("PATCH", "/settings", { info: { contact } })).status).toBe(200);
  await page.reload();
  await expect(page.getByLabel("Contact", { exact: true })).toHaveValue(contact);
});

test("Discard after a save goes back to the saved value, not the original", async ({ page }) => {
  await page.goto("settings/info");
  const name = page.getByLabel("Name", { exact: true });
  const saved = uniq("saved");
  await name.fill(saved);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Settings saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await name.fill(uniq("draft"));
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(name).toHaveValue(saved);
  await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
});

test("a save the server refuses is reported and the edit is kept", async ({ page }) => {
  await page.goto("settings/info");
  await page.route("**/admin/api/settings", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "refused by test", code: "validation" }) })
      : route.fallback(),
  );
  const draft = uniq("refused");
  await page.getByLabel("Name", { exact: true }).fill(draft);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Could not save settings")).toBeVisible();
  await expect(toast(page, "refused by test")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(draft);
  await expect(unsaved(page)).toBeVisible();
  expect((await getSettings()).info.name).not.toBe(draft);
});
