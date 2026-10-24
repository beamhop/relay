/** Keyboard-only use: signing in, a confirm dialog (Escape cancels and resolves, Enter confirms), the palette. */
import type { Page } from "@playwright/test";
import { test, expect, owner } from "./fixtures";
import { appHref, freshPage, ownerApi, toast, uniq } from "./auth-support";

/** Presses Tab until `pred` holds for document.activeElement (at most `max` presses). */
async function tabTo(page: Page, pred: string, max = 25) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(pred)) return;
  }
  throw new Error(`Tab never reached: ${pred}`);
}

test("sign in with the keyboard only: Tab to the tabs, arrow to Key, type, Enter", async ({ browser, baseURL }) => {
  const { context, page } = await freshPage(browser, baseURL!);
  try {
    await page.goto("login");
    await expect(page.getByRole("tab", { name: "Signer" })).toBeVisible();
    await tabTo(page, `document.activeElement?.getAttribute("role") === "tab"`);
    // roving focus: arrow keys move between the tabs and activate them
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Key", exact: true })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Key", exact: true })).toHaveAttribute("aria-selected", "true");
    await tabTo(page, `document.activeElement?.id === "nsec"`);
    await page.keyboard.type(owner().nsec);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test.describe("confirm dialog by keyboard", () => {
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
  test.beforeEach(async () => {
    await ownerApi("DELETE", `/ip-rules/${encodeURIComponent(ip)}`);
    expect((await ownerApi("POST", "/ip-rules", { cidr: ip, action: "block", reason: uniq("kbd") })).status).toBe(201);
  });
  test.afterEach(async () => {
    await ownerApi("DELETE", `/ip-rules/${encodeURIComponent(ip)}`);
  });
  const hasRule = async () => ((await ownerApi<{ items: { cidr: string }[] }>("GET", "/ip-rules")).body.items ?? []).some((r) => r.cidr === ip);

  test("Escape cancels (and frees the dialog for the next confirm); Enter on the confirm button removes", async ({ page }) => {
    await page.goto("ip-rules");
    const row = page.locator("div.bg-card.p-4").filter({ hasText: ip });
    const remove = row.getByRole("button", { name: "Remove" });
    await remove.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`Remove rule for ${ip}?`);
    // focus moves into the dialog (and is trapped there)
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await hasRule()).toBe(true);

    // the cancelled confirm resolved: a new one opens and works
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    const confirmBtn = dialog.getByRole("button", { name: "Remove" });
    for (let i = 0; i < 4 && !(await confirmBtn.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(confirmBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast(page, "Rule removed")).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect.poll(hasRule).toBe(false);
  });
});

// confirm.tsx:57 renders one shared AlertDialog with no Trigger: Radix's close auto-focus targets the (absent)
// trigger and prevents its default, so focus drops to <body> and a keyboard user loses their place
test("regression: closing a confirm dialog with Escape returns focus to the button that opened it", async ({ page }) => {
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
  expect((await ownerApi("POST", "/ip-rules", { cidr: ip, action: "block", reason: uniq("kbd") })).status).toBe(201);
  try {
    await page.goto("ip-rules");
    const remove = page.locator("div.bg-card.p-4").filter({ hasText: ip }).getByRole("button", { name: "Remove" });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(remove).toBeFocused();
  } finally {
    await ownerApi("DELETE", `/ip-rules/${encodeURIComponent(ip)}`);
  }
});

test("command palette by keyboard: type, Enter runs the selected entry; Escape closes", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/Search pages/);
  await expect(input).toBeFocused();
  await page.keyboard.type("audit");
  // the first match is pre-selected; Enter runs it
  await expect(page.getByRole("option", { name: "Audit log" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect.poll(() => appHref(page)).toBe("/audit");
  await expect(input).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(input).toBeFocused();
  await page.keyboard.type("sys");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect.poll(() => appHref(page)).toBe("/audit");
});
