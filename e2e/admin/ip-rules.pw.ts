import type { Page } from "@playwright/test";
import { api, apiOk, expect, fail500, makeUser, publish, sign, test, uid } from "./seed-users";

interface IpRule { cidr: string; action: "block" | "allow"; reason: string }
const created: string[] = [];
const randIp = () => `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
async function addRule(reason: string, action: "block" | "allow" = "block", cidr = randIp()) {
  await apiOk("POST", "/ip-rules", { cidr, action, reason });
  created.push(cidr);
  return cidr;
}
const ruleRow = (page: Page, text: string) => page.locator("div.bg-card.p-4").filter({ hasText: text });
const filterBox = (page: Page) => page.getByPlaceholder("Filter by IP or reason…");

// every test leaves the rule table as it found it, so the "≤ 5 rules hides the filter" path is reachable
test.afterEach(async () => {
  for (const c of created.splice(0)) await api("DELETE", `/ip-rules/${encodeURIComponent(c)}`);
});

async function openAdd(page: Page) {
  await page.goto("ip-rules");
  await page.getByRole("button", { name: "Add rule" }).click();
  return page.getByRole("dialog");
}

test.describe("IP rules", () => {
  // routes mock API calls: keep the PWA service worker out, or requests it has claimed bypass page.route (seed-users fail500)
  test.use({ serviceWorkers: "block" });
  test("validation: invalid addresses keep Add disabled with a message", async ({ page }) => {
    const dialog = await openAdd(page);
    const cidr = dialog.getByLabel("IP or CIDR");
    const add = dialog.getByRole("button", { name: "Add rule" });
    await expect(add).toBeDisabled();
    for (const bad of ["300.1.1.1", "10.0.0.0/33", "not-an-ip", "2001:db8::/129"]) {
      await cidr.fill(bad);
      await expect(dialog.getByText("Enter a valid IPv4/IPv6 address or CIDR range.")).toBeVisible();
      await expect(add).toBeDisabled();
    }
    for (const good of ["203.0.113.7", "203.0.113.0/24", "2001:db8::/32"]) {
      await cidr.fill(good);
      await expect(dialog.getByText("Enter a valid IPv4/IPv6 address or CIDR range.")).toHaveCount(0);
      await expect(add).toBeEnabled();
    }
  });

  test("regression: after adding an allow rule, the next rule starts as a block", async ({ page }) => {
    const first = randIp();
    const second = randIp();
    created.push(first, second);
    const dialog = await openAdd(page);
    await dialog.getByLabel("IP or CIDR").fill(first);
    await dialog.getByRole("radio", { name: "Allow" }).click();
    await dialog.getByRole("button", { name: "Add rule" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(dialog.getByRole("radio", { name: "Block" })).toHaveAttribute("data-state", "on");
    await dialog.getByLabel("IP or CIDR").fill(second);
    await dialog.getByRole("button", { name: "Add rule" }).click();
    await expect(dialog).toHaveCount(0);
    const stored = (await apiOk<{ items: IpRule[] }>("GET", "/ip-rules")).items;
    expect(stored.find((r) => r.cidr === second)?.action).toBe("block");
  });

  test("adding a rule for an address that already has one warns and asks before replacing it", async ({ page }) => {
    const ip = await addRule(uid("keep"), "block");
    const dialog = await openAdd(page);
    await dialog.getByLabel("IP or CIDR").fill(`${ip}/32`);
    await expect(dialog.getByText(`${ip} already has a block rule`)).toBeVisible();
    await dialog.getByRole("radio", { name: "Allow" }).click();
    await dialog.getByRole("button", { name: "Add rule" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`Replace the rule for ${ip}?`);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect((await apiOk<{ items: IpRule[] }>("GET", "/ip-rules")).items.find((r) => r.cidr === ip)?.action).toBe("block");
    await dialog.getByRole("button", { name: "Add rule" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Replace rule" }).click();
    await expect(dialog).toHaveCount(0);
    const rules = (await apiOk<{ items: IpRule[] }>("GET", "/ip-rules")).items.filter((r) => r.cidr === ip || r.cidr === `${ip}/32`);
    expect(rules.map((r) => [r.cidr, r.action])).toEqual([[ip, "allow"]]);
  });

  test("add a block rule with a reason", async ({ page }) => {
    const ip = randIp();
    const reason = uid("bot");
    created.push(ip);
    const dialog = await openAdd(page);
    await dialog.getByLabel("IP or CIDR").fill(ip);
    await dialog.getByLabel("Reason").fill(reason);
    await expect(dialog.getByText("Matching addresses can't connect")).toBeVisible();
    await dialog.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText("Rule added")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(ruleRow(page, ip)).toContainText(reason);
    await expect(ruleRow(page, ip)).toContainText("block");
    // stored by the server as a block rule
    const stored = (await apiOk<{ items: IpRule[] }>("GET", "/ip-rules")).items.filter((r) => r.cidr === ip || r.cidr === `${ip}/32`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ action: "block", reason });
    // the relay is reached from 127.0.0.1 only (no trusted proxy to spoof another address), so enforcement is checked
    // from the side that matters for a scoped rule: it must not catch this address — a client here still connects
    // and publishes
    const u = makeUser();
    await publish([sign(u.sk, { kind: 1, content: `after block rule ${reason}` })]);
  });

  test("broad allow range: the warning can be cancelled (form kept) or confirmed", async ({ page }) => {
    const range = "10.0.0.0/8";
    created.push(range);
    const dialog = await openAdd(page);
    await dialog.getByLabel("IP or CIDR").fill(range);
    await dialog.getByRole("radio", { name: "Allow" }).click();
    await expect(dialog.getByText(/Allow rules are exemptions, not a whitelist/)).toBeVisible();
    await dialog.getByRole("button", { name: "Add rule" }).click();
    const warn = page.getByRole("alertdialog");
    await expect(warn.getByText("Allow this whole range?")).toBeVisible();
    await expect(warn).toContainText("about 16.8 million IPv4 addresses");
    await warn.getByRole("button", { name: "Cancel" }).click();
    await expect(warn).toHaveCount(0);
    await expect(dialog.getByLabel("IP or CIDR")).toHaveValue(range);
    expect((await apiOk<{ items: IpRule[] }>("GET", "/ip-rules")).items.some((r) => r.cidr === range)).toBe(false);

    await dialog.getByRole("button", { name: "Add rule" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Add allow rule anyway" }).click();
    await expect(page.getByText("Rule added")).toBeVisible();
    await expect(ruleRow(page, range)).toContainText("allow");
  });

  test("filter by IP and by reason", async ({ page }) => {
    const tok = uid("flt");
    const ips = [];
    for (let i = 0; i < 6; i++) ips.push(await addRule(`${tok} r${i}`));
    const lone = await addRule(uid("other"));
    await page.goto("ip-rules");
    await expect(filterBox(page)).toBeVisible();
    await filterBox(page).fill(tok.toUpperCase());
    await expect(page.locator("div.bg-card.p-4")).toHaveCount(6);
    await expect(ruleRow(page, lone)).toHaveCount(0);
    await filterBox(page).fill(ips[2]);
    await expect(ruleRow(page, ips[2])).toBeVisible();
    await expect(ruleRow(page, ips[3])).toHaveCount(0);
  });

  test("remove asks for confirmation; Cancel keeps the rule", async ({ page }) => {
    const ip = await addRule(uid("rm"));
    await page.goto("ip-rules");
    await ruleRow(page, ip).getByRole("button", { name: "Remove" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText(`Remove rule for ${ip}?`)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(ruleRow(page, ip)).toBeVisible();
    await ruleRow(page, ip).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Rule removed")).toBeVisible();
    await expect(ruleRow(page, ip)).toHaveCount(0);
  });

  test("filter, then delete rules down to ≤ 5: the filter stays, 'No matching rules' and Clear filter work", async ({ page }) => {
    const tok = uid("dn");
    const ips = [];
    for (let i = 0; i < 6; i++) ips.push(await addRule(`${tok} r${i}`));
    const before = (await apiOk<{ items: IpRule[] }>("GET", "/ip-rules")).items.length;
    await page.goto("ip-rules");
    await filterBox(page).fill(tok);
    await expect(page.locator("div.bg-card.p-4")).toHaveCount(6);
    for (const ip of ips) {
      await ruleRow(page, ip).getByRole("button", { name: "Remove" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
      await expect(ruleRow(page, ip)).toHaveCount(0);
      // the box never disappears while it holds a filter
      await expect(filterBox(page)).toHaveValue(tok);
    }
    await expect(page.getByText("No matching rules")).toBeVisible();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(page.getByText("No matching rules")).toHaveCount(0);
    if (before - 6 <= 5) await expect(filterBox(page)).toHaveCount(0);
    else await expect(filterBox(page)).toHaveValue("");
  });

  test("a failing remove shows a toast and keeps the rule", async ({ page, allowServerErrors }) => {
    allowServerErrors();
    const ip = await addRule(uid("rf"));
    await page.goto("ip-rules");
    await fail500(page, /\/admin\/api\/ip-rules\/.+/, "DELETE");
    await ruleRow(page, ip).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("boom from test")).toBeVisible();
    await expect(ruleRow(page, ip)).toBeVisible();
  });
});
