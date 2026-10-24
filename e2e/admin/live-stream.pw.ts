import type { Page } from "@playwright/test";
import { test, expect } from "./seed-content";
import { newUser, note, publish, sign, uid, withWs } from "./seed-content";

const stream = (page: Page) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: "Event stream" }) });

/** Opens /live and waits until an event published now shows up (the page re-opens its SSE with ?events=1 on mount). */
async function openLive(page: Page) {
  await page.goto("live");
  const u = newUser();
  await expect(async () => {
    const tag = `warmup ${uid()}`;
    await publish(note(tag, { sk: u.sk }));
    await expect(stream(page).getByText(tag)).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
}

test.describe("live event stream", () => {
  test("events published during the test appear, newest first", async ({ page }) => {
    await openLive(page);
    const id = uid();
    const u = newUser();
    await publish(note(`live one ${id}`, { sk: u.sk }));
    await expect(stream(page).getByText(`live one ${id}`)).toBeVisible();
    await publish(note(`live two ${id}`, { sk: u.sk }));
    await expect(stream(page).getByText(`live two ${id}`)).toBeVisible();
    const items = stream(page).getByRole("listitem");
    await expect(items.first()).toContainText(`live two ${id}`);
    await expect(items.filter({ hasText: `live one ${id}` }).getByText("accepted")).toBeVisible();
  });

  test("a rejected event shows its reason and the status toggle filters it", async ({ page }) => {
    await openLive(page);
    const id = uid();
    const u = newUser();
    const bad = sign(u.sk, { kind: 1, content: `live future ${id}`, created_at: Math.floor(Date.now() / 1000) + 7200 });
    const r = await withWs((ws) => ws.publish(bad));
    expect(r.ok).toBe(false);
    await publish(note(`live ok ${id}`, { sk: u.sk }));
    const row = stream(page).getByRole("listitem").filter({ hasText: `live future ${id}` });
    await expect(row.getByText("rejected", { exact: true })).toBeVisible();
    await expect(row.getByText(r.message.replace(/^\w+: /, ""), { exact: false })).toBeVisible();

    await stream(page).getByRole("radio", { name: "Rejected" }).click();
    await expect(row).toBeVisible();
    await expect(stream(page).getByText(`live ok ${id}`)).toHaveCount(0);
    await stream(page).getByRole("radio", { name: "Accepted" }).click();
    await expect(stream(page).getByText(`live ok ${id}`)).toBeVisible();
    await expect(row).toHaveCount(0);
    await stream(page).getByRole("radio", { name: "All" }).click();
    await expect(row).toBeVisible();
  });

  test("a kinds filter that excludes everything shows “No events match”", async ({ page }) => {
    await openLive(page);
    const kinds = stream(page).getByPlaceholder("Filter kinds (e.g. 1, 7)");
    await kinds.fill("39999");
    await kinds.press("Enter");
    await expect(stream(page).getByText("No events match")).toBeVisible();
    await expect(stream(page).getByText(/None of the last \d+ events match these filters/)).toBeVisible();
    // a matching event arriving now is shown
    const u = newUser();
    const id = uid();
    await publish(sign(u.sk, { kind: 39999, content: `kind match ${id}`, tags: [["d", id]] }));
    await expect(stream(page).getByText(`kind match ${id}`)).toBeVisible();
    await stream(page).getByRole("button", { name: "Remove 39999" }).click();
    await expect(stream(page).getByText("No events match")).toHaveCount(0);
  });

  test("pause holds new events back; resume shows them", async ({ page }) => {
    // record when each streamed event reaches this page, and whether a given text is ever rendered while paused
    await page.addInitScript(() => {
      const w = window as unknown as { __sse: { at: number; data: string }[] };
      w.__sse = [];
      const add = EventSource.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (this: EventSource, type: string, fn: unknown, opts?: unknown) {
        const wrapped =
          type === "event" && typeof fn === "function"
            ? function (this: EventSource, m: MessageEvent) {
                w.__sse.push({ at: performance.now(), data: String(m.data) });
                return (fn as (m: MessageEvent) => unknown).call(this, m);
              }
            : fn;
        return add.call(this, type, wrapped as EventListener, opts as AddEventListenerOptions);
      } as typeof EventSource.prototype.addEventListener;
    });
    await openLive(page);
    const id = uid();
    const u = newUser();
    const text = `while paused ${id}`;
    await stream(page).getByRole("button", { name: "Pause", exact: true }).click();
    await expect(stream(page).getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    // from now on, flag any moment the paused stream renders the event
    await page.evaluate((text) => {
      const w = window as unknown as { __shownWhilePaused: boolean; __obs: MutationObserver };
      w.__shownWhilePaused = false;
      w.__obs = new MutationObserver(() => {
        if (document.body.innerText.includes(text)) w.__shownWhilePaused = true;
      });
      w.__obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, text);
    await publish(note(text, { sk: u.sk }));
    // the event has reached this page's stream (deterministic, instead of guessing how long delivery takes) ...
    const deliveredAt = await page.waitForFunction((text) => (window as unknown as { __sse: { at: number; data: string }[] }).__sse.find((e) => e.data.includes(text))?.at, text);
    const t0 = (await deliveredAt.jsonValue()) as number;
    // ... and the page has since run at least two of its 400ms flush ticks
    await page.waitForFunction((t0) => performance.now() > t0 + 900, t0);
    await expect(stream(page).getByText(text)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __shownWhilePaused: boolean }).__shownWhilePaused)).toBe(false);
    await page.evaluate(() => (window as unknown as { __obs: MutationObserver }).__obs.disconnect());

    await stream(page).getByRole("button", { name: "Resume", exact: true }).click();
    await expect(stream(page).getByText(text)).toBeVisible();
    await expect(stream(page).getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  });

  test("clicking an event opens its JSON; Clear empties the list", async ({ page }) => {
    await openLive(page);
    const id = uid();
    const u = newUser();
    const ev = note(`inspect ${id}`, { sk: u.sk });
    await publish(ev);
    await stream(page).getByText(`inspect ${id}`).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Note event")).toBeVisible();
    await expect(dlg.getByText(ev.id)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await stream(page).getByRole("button", { name: "Clear", exact: true }).click();
    await expect(stream(page).getByText(`inspect ${id}`)).toHaveCount(0);
    await expect(stream(page).getByRole("listitem")).toHaveCount(0);
  });
});
