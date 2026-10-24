import { readFileSync } from "node:fs";
import { test, expect } from "./seed-content";
import { newUser, note, publish, queryWs, uid } from "./seed-content";

const contentUrl = (f: unknown) => `content?f=${encodeURIComponent(JSON.stringify(JSON.stringify(f)))}`;

async function seedAuthor(n: number) {
  const id = uid();
  const u = newUser();
  const base = Math.floor(Date.now() / 1000) - 100;
  const events = Array.from({ length: n }, (_, i) => note(`mod ${id} #${i}`, { sk: u.sk, created_at: base + i }));
  await publish(...events);
  return { id, u, events };
}

test.describe("content moderation", () => {
  test("select two events and delete them from the selection bar", async ({ page }) => {
    const { id, u, events } = await seedAuthor(3);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    const boxes = page.getByRole("checkbox", { name: "Select event" });
    await expect(boxes).toHaveCount(3);
    // newest first: #2, #1, #0
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByText("Delete 2 events?")).toBeVisible();
    await dlg.getByLabel("Reason (optional)").fill(`e2e ${id}`);
    await dlg.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Deleted 2 event(s)")).toBeVisible();
    await expect(boxes).toHaveCount(1);
    await expect(page.getByText(`mod ${id} #0`)).toBeVisible();
    await expect(page.getByText("2 selected")).toHaveCount(0);
    const left = await queryWs([{ authors: [u.pubkey] }]);
    expect(left.map((e) => e.id)).toEqual([events[0].id]);
  });

  test("Select all + cancel in the confirm dialog deletes nothing", async ({ page }) => {
    const { u } = await seedAuthor(2);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(2);
    await page.getByText("Select all").click();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(2);
    expect(await queryWs([{ authors: [u.pubkey] }])).toHaveLength(2);
    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(page.getByText("2 selected")).toHaveCount(0);
  });

  test("delete a single event from its actions menu", async ({ page }) => {
    const { id, u, events } = await seedAuthor(2);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(2);
    await page.getByRole("button", { name: "Event actions" }).first().click();
    await page.getByRole("menuitem", { name: "Delete event" }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByText("Delete 1 event?")).toBeVisible();
    await dlg.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(`mod ${id} #1`)).toHaveCount(0);
    await expect(page.getByText(`mod ${id} #0`)).toBeVisible();
    expect((await queryWs([{ ids: [events[1].id] }])).length).toBe(0);
  });

  test("delete by filter requires typing DELETE", async ({ page }) => {
    const { id, u } = await seedAuthor(3);
    const bystander = await seedAuthor(1);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(3);

    await page.getByRole("button", { name: "Delete matching" }).click();
    let dlg = page.getByRole("alertdialog");
    await expect(dlg.getByText("Delete ALL events matching this filter?")).toBeVisible();
    await expect(dlg.getByText(u.pubkey)).toBeVisible();
    await dlg.getByLabel("Type DELETE to confirm").fill("delete");
    await dlg.getByRole("button", { name: "Delete matching" }).click();
    await expect(page.getByText("Confirmation text did not match")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(3);
    expect(await queryWs([{ authors: [u.pubkey] }])).toHaveLength(3);

    await page.getByRole("button", { name: "Delete matching" }).click();
    dlg = page.getByRole("alertdialog");
    await dlg.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dlg.getByRole("button", { name: "Delete matching" }).click();
    await expect(page.getByText("Deleted 3 event(s)")).toBeVisible();
    await expect(page.getByText("No events match")).toBeVisible();
    await expect(page.getByText(`mod ${id} #0`)).toHaveCount(0);
    expect(await queryWs([{ authors: [u.pubkey] }])).toHaveLength(0);
    // other authors untouched
    expect(await queryWs([{ authors: [bystander.u.pubkey] }])).toHaveLength(1);
  });

  test("Delete matching is hidden without a filter", async ({ page }) => {
    await page.goto("content");
    await expect(page.getByText("All events, newest first")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete matching" })).toHaveCount(0);
  });

  test("export downloads the filtered events as JSONL", async ({ page }) => {
    const { u, events } = await seedAuthor(3);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(3);
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/^beamhop-events-.*\.jsonl$/);
    await expect(page.getByText(/^Exported /)).toBeVisible();
    const lines = readFileSync((await d.path())!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
    expect(lines.every((e) => e.pubkey === u.pubkey && typeof e.sig === "string")).toBe(true);
  });
});
