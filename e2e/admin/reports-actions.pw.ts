import type { Page } from "@playwright/test";
import { test, expect, ALLOW_500 } from "./seed-content";
import { newUser, note, ownerApi, publish, queryWs, report, uid, upload, withWs } from "./seed-content";

/** the innermost report card containing `text` */
const card = (page: Page, text: string) =>
  page.locator("div.rounded-xl").filter({ hasText: text }).filter({ has: page.getByRole("button", { name: "Dismiss" }) }).last();

async function eventReport(type = "spam") {
  const id = uid();
  const author = newUser();
  const target = note(`reported note ${id}`, { sk: author.sk });
  const r = report({ e: target.id, p: author.pubkey }, type, `event report ${id}`);
  await publish(target, r);
  return { id, author, target, report: r, text: `event report ${id}` };
}

async function profileReport(type = "impersonation") {
  const id = uid();
  const author = newUser();
  // the user exists on the relay, but the report names only the pubkey
  await publish(note(`profile owner ${id}`, { sk: author.sk }));
  const r = report({ p: author.pubkey }, type, `profile report ${id}`);
  await publish(r);
  return { id, author, report: r, text: `profile report ${id}` };
}

const userStatus = async (pk: string) => (await ownerApi<{ status: string }>("GET", `/users/${pk}`)).body.status;

test.describe("reports: actions per report type", () => {
  test("an event report offers Delete and Delete & ban", async ({ page }) => {
    const r = await eventReport();
    await page.goto("reports");
    const c = card(page, r.text);
    await expect(c).toBeVisible();
    await expect(c.getByText(`reported note ${r.id}`)).toBeVisible();
    await expect(c.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
    await expect(c.getByRole("button", { name: "Delete & ban" })).toBeVisible();
    await expect(c.getByRole("button", { name: "Ban user" })).toHaveCount(0);
    await c.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: "Ban user only" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("a profile-only report offers Ban user and no Delete & ban", async ({ page }) => {
    const r = await profileReport();
    await page.goto("reports");
    const c = card(page, r.text);
    await expect(c).toBeVisible();
    await expect(c.getByText("impersonation")).toBeVisible();
    await expect(c.getByRole("button", { name: "Ban user" })).toBeVisible();
    await expect(c.getByRole("button", { name: "Delete & ban" })).toHaveCount(0);
    await expect(c.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  });

  test("Delete & ban removes the event over ws and bans its author", async ({ page }) => {
    const r = await eventReport();
    await page.goto("reports");
    const c = card(page, r.text);
    await c.getByRole("button", { name: "Delete & ban" }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByText("will be banned and the reported content deleted")).toBeVisible();
    await dlg.getByLabel("Resolution note (optional)").fill(`note ${r.id}`);
    await dlg.getByRole("button", { name: "Delete & ban" }).click();
    await expect(page.getByText("Report resolved")).toBeVisible();
    await expect(page.getByText(r.text)).toHaveCount(0);
    expect(await queryWs([{ ids: [r.target.id] }])).toHaveLength(0);
    expect(await userStatus(r.author.pubkey)).toBe("banned");
    // banned author's new events are refused
    const refused = await withWs((ws) => ws.publish(note("after ban", { sk: r.author.sk })));
    expect(refused.ok).toBe(false);

    await page.getByRole("tab", { name: "resolved" }).click();
    const done = page.locator("div.rounded-xl").filter({ hasText: r.text }).last();
    await expect(done.getByText("resolved", { exact: true })).toBeVisible();
    await expect(done.getByText(`note ${r.id}`)).toBeVisible();
  });

  test("Delete removes only the event; the author is not banned", async ({ page }) => {
    const r = await eventReport();
    await page.goto("reports");
    await card(page, r.text).getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete content" }).click();
    await expect(page.getByText(r.text)).toHaveCount(0);
    expect(await queryWs([{ ids: [r.target.id] }])).toHaveLength(0);
    expect(await userStatus(r.author.pubkey)).not.toBe("banned");
  });

  test("Ban user on a profile report bans the named user", async ({ page }) => {
    const r = await profileReport();
    await page.goto("reports");
    await card(page, r.text).getByRole("button", { name: "Ban user" }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByText("will be banned.")).toBeVisible();
    await dlg.getByRole("button", { name: "Ban user" }).click();
    await expect(page.getByText(r.text)).toHaveCount(0);
    await expect.poll(() => userStatus(r.author.pubkey)).toBe("banned");
  });

  // reports.tsx:315 disables the actions with <fieldset disabled={busy}>, but `busy` (mutation isPending) only
  // re-renders after TanStack's batched notify, so the second click of a fast double-click still gets through
  test("regression: double-clicking Dismiss sends one resolve request", async ({ page }) => {
    const r = await eventReport();
    let calls = 0;
    page.on("request", (q) => q.method() === "POST" && q.url().includes(`/admin/api/reports/${r.report.id}/resolve`) && calls++);
    await page.goto("reports");
    await card(page, r.text).getByRole("button", { name: "Dismiss" }).dblclick();
    await expect(page.getByText("Report dismissed").first()).toBeVisible();
    await expect(page.getByText(r.text)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(calls).toBe(1);
  });

  test("Dismiss is disabled while its request is pending, and dismisses once", async ({ page }) => {
    const r = await eventReport();
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    await page.route(`**/admin/api/reports/${r.report.id}/resolve`, async (route) => {
      calls++;
      await held;
      await route.continue();
    });
    await page.goto("reports");
    const c = card(page, r.text);
    await c.getByRole("button", { name: "Dismiss" }).click();
    await expect(c.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    await expect(c.getByRole("button", { name: "Delete & ban" })).toBeDisabled();
    await c.getByRole("button", { name: "Dismiss" }).click({ force: true });
    release();
    await expect(page.getByText("Report dismissed")).toBeVisible();
    await expect(page.getByText(r.text)).toHaveCount(0);
    expect(calls).toBe(1);
    // the event is untouched
    expect(await queryWs([{ ids: [r.target.id] }])).toHaveLength(1);
    await page.getByRole("tab", { name: "dismissed" }).click();
    await expect(page.locator("div.rounded-xl").filter({ hasText: r.text }).last().getByText("dismissed", { exact: true })).toBeVisible();
  });

  test.describe(() => {
    test.use({ allowConsole: ALLOW_500 });
    test("a failing resolve shows an error toast and keeps the report", async ({ page }) => {
      const r = await eventReport();
      await page.route(`**/admin/api/reports/${r.report.id}/resolve`, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "resolve exploded" }) }),
      );
      await page.goto("reports");
      const c = card(page, r.text);
      await c.getByRole("button", { name: "Dismiss" }).click();
      await expect(page.getByText("Action failed")).toBeVisible();
      await expect(page.getByText("resolve exploded")).toBeVisible();
      await expect(c).toBeVisible();
      await expect(c.getByRole("button", { name: "Dismiss" })).toBeEnabled();
      expect(await queryWs([{ ids: [r.target.id] }])).toHaveLength(1);
    });
  });
});

test.describe("reports: queue navigation", () => {
  test("type filter narrows the queue and is kept in the URL", async ({ page }) => {
    const spam = await eventReport("spam");
    const nude = await eventReport("nudity");
    await page.goto("reports");
    await expect(card(page, spam.text)).toBeVisible();
    await expect(card(page, nude.text)).toBeVisible();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "nudity" }).click();
    await expect(page).toHaveURL(/type=nudity/);
    await expect(card(page, nude.text)).toBeVisible();
    await expect(page.getByText(spam.text)).toHaveCount(0);
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "All types" }).click();
    await expect(page).not.toHaveURL(/type=/);
    await expect(card(page, spam.text)).toBeVisible();
  });

  test("status tabs switch the queue and the header count", async ({ page }) => {
    const r = await eventReport();
    await page.goto("reports");
    await expect(page.getByText(/\d+ open reports?/)).toBeVisible();
    await card(page, r.text).getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText(r.text)).toHaveCount(0);
    await page.getByRole("tab", { name: "dismissed" }).click();
    await expect(page).toHaveURL(/status=dismissed/);
    await expect(page.getByText(/\d+ dismissed reports?/)).toBeVisible();
    await expect(page.getByText(r.text)).toBeVisible();
    // resolved queue: no action buttons on closed reports
    await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
    await page.getByRole("tab", { name: "resolved" }).click();
    await expect(page.getByText(r.text)).toHaveCount(0);
    await page.getByRole("tab", { name: "open" }).click();
    await expect(page).not.toHaveURL(/status=/);
  });

  test("?id= shows the linked report above the queue; Close removes it", async ({ page }) => {
    const r = await profileReport("spam");
    await page.goto(`reports?id=${r.report.id}`);
    await expect(page.getByRole("heading", { name: "Linked report" })).toBeVisible();
    // once linked, once in the queue
    await expect(page.getByText(r.text)).toHaveCount(2);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("heading", { name: "Linked report" })).toHaveCount(0);
    await expect(page).not.toHaveURL(/id=/);
    await expect(page.getByText(r.text)).toHaveCount(1);
  });

  test("a linked report that is already dismissed shows without actions", async ({ page }) => {
    const r = await profileReport("spam");
    expect((await ownerApi("POST", `/reports/${r.report.id}/resolve`, { action: "dismiss" })).status).toBe(200);
    await page.goto(`reports?id=${r.report.id}`);
    const linked = page.getByRole("heading", { name: "Linked report" }).locator("xpath=../..");
    await expect(linked.getByText(r.text)).toBeVisible();
    await expect(linked.getByText("dismissed", { exact: true })).toBeVisible();
    await expect(linked.getByRole("button", { name: "Ban user" })).toHaveCount(0);
    await expect(linked.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
    // not in the open queue any more
    await expect(page.getByText(r.text)).toHaveCount(1);
  });

  test("reported media is shown blurred", async ({ page }) => {
    const id = uid();
    const uploader = newUser();
    const sha = await upload(uploader.sk);
    await publish(report({ x: sha, p: uploader.pubkey }, "nudity", `media report ${id}`));
    await page.goto("reports");
    const img = card(page, `media report ${id}`).getByRole("img", { name: "Reported media" });
    await expect(img).toBeVisible();
    await expect(img).toHaveClass(/blur-md/);
    await expect(img).toHaveJSProperty("naturalWidth", 1);
  });
});
