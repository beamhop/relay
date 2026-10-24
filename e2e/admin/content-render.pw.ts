import { test, expect, ALLOW_500 } from "./seed-content";
import { importEvents, newUser, note, publish, uid } from "./seed-content";

const contentUrl = (f: unknown) => `content?f=${encodeURIComponent(JSON.stringify(JSON.stringify(f)))}`;

test.describe("event content rendering", () => {
  test("links followed by sentence punctuation get exact hrefs", async ({ page }) => {
    const id = uid();
    const u = newUser();
    const urls = [`https://example.com/${id}/a`, `https://example.org/${id}?y=1`, `https://example.net/${id}/z`, `https://example.io/${id}/q`, `https://example.dev/${id}`];
    const text = `Visit ${urls[0]}. Then (${urls[1]}), or ${urls[2]}! and '${urls[3]}'; finally ${urls[4]}:`;
    // imported, not published: five links from a brand-new account is exactly what the spam-filter plugin rejects
    await importEvents([note(text, { sk: u.sk })]);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    const links = page.getByRole("link").filter({ hasText: id });
    await expect(links).toHaveCount(urls.length);
    for (let i = 0; i < urls.length; i++) {
      await expect(links.nth(i)).toHaveAttribute("href", urls[i]);
      await expect(links.nth(i)).toHaveAttribute("rel", /noopener/);
    }
    // the punctuation stays as text
    await expect(page.getByText(/finally/)).toContainText(`${urls[4]}:`);
  });

  function longText(id: string) {
    const long = `https://example.com/${id}/${"x".repeat(70)}`;
    const after = `https://example.org/${id}/after`;
    // the long URL straddles the 900-char limit
    const text = `${"lorem ".repeat(146)}${long} middle ${after} tail-${id}`;
    expect(text.indexOf(long)).toBeLessThan(900);
    expect(text.indexOf(long) + long.length).toBeGreaterThan(900);
    return { long, after, text };
  }

  test("truncation never cuts a URL in half; Show more reveals the rest", async ({ page }) => {
    const id = uid();
    const u = newUser();
    const { long, after, text } = longText(id);
    await publish(note(text, { sk: u.sk }));
    await page.goto(contentUrl({ authors: [u.pubkey] }));

    // the cut moves to the end of the straddling URL: one link carrying the whole address
    const first = page.locator(`a[href^="${long}"]`);
    await expect(first).toHaveCount(1);
    await expect(first).toHaveText(`${long.slice(0, 57)}…`);
    await expect(page.locator(`a[href="${after}"]`)).toHaveCount(0);
    await expect(page.getByText(`tail-${id}`)).toHaveCount(0);

    await page.getByRole("button", { name: "Show more" }).click();
    await expect(page.locator(`a[href="${long}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href="${after}"]`)).toHaveCount(1);
    await expect(page.getByText(`tail-${id}`)).toBeVisible();
    await page.getByRole("button", { name: "Show less" }).click();
    await expect(page.getByText(`tail-${id}`)).toHaveCount(0);
  });

  // event-card.tsx:163 appends "…" right after the URL, and URL_RE then swallows it into the link
  test("regression: a URL ending at the truncation point keeps a clean href (ellipsis outside the link)", async ({ page }) => {
    const id = uid();
    const u = newUser();
    const { long, text } = longText(id);
    await publish(note(text, { sk: u.sk }));
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
    await expect(page.locator(`a[href^="${long}"]`)).toHaveAttribute("href", long);
  });

  test("nostr: references are shortened, not linked", async ({ page }) => {
    const u = newUser();
    const ref = "nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxq3jx5";
    await publish(note(`mention ${ref} here`, { sk: u.sk }));
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByText(`mention ${ref.slice(0, 18)}… here`)).toBeVisible();
  });
});

test.describe("content infinite scroll", () => {
  async function seedMany(n: number) {
    const u = newUser();
    const base = Math.floor(Date.now() / 1000) - 10_000;
    const events = Array.from({ length: n }, (_, i) => note(`scroll ${i}`, { sk: u.sk, created_at: base + i * 10 }));
    await importEvents(events);
    return u;
  }

  test("a tall viewport keeps loading pages without any click", async ({ page }) => {
    const u = await seedMany(130);
    await page.setViewportSize({ width: 1280, height: 9000 });
    let pages = 0;
    page.on("request", (r) => r.url().endsWith("/admin/api/events/query") && pages++);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(130, { timeout: 15_000 });
    expect(pages).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    // oldest is last, no duplicates across page boundaries
    await expect(page.getByText("scroll 0", { exact: true })).toBeVisible();
    await expect(page.getByText("scroll 129", { exact: true })).toHaveCount(1);
  });

  test.describe(() => {
    test.use({ allowConsole: ALLOW_500 });

    async function failNextPages(page: import("@playwright/test").Page) {
      const state = { failed: 0, fail: true };
      await page.route("**/admin/api/events/query", async (route) => {
        const body = route.request().postDataJSON() as { filters: { until?: number }[] };
        if (state.fail && body.filters.some((f) => f.until !== undefined)) {
          state.failed++;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "next page boom" }) });
        }
        return route.continue();
      });
      return state;
    }

    test("a failing next page pauses auto-loading; Load more still works", async ({ page }) => {
      const u = await seedMany(120);
      await page.setViewportSize({ width: 1280, height: 9000 });
      const state = await failNextPages(page);
      await page.goto(contentUrl({ authors: [u.pubkey] }));
      const more = page.getByRole("button", { name: "Load more" });
      await expect(more).toBeVisible({ timeout: 10_000 });
      // one fetchNextPage = the request + 2 retries (queries/client.ts retry policy for 5xx)
      await expect.poll(() => state.failed, { timeout: 10_000 }).toBe(3);
      const afterFail = state.failed;
      // paused: the sentinel, still in view, does not retry in a loop
      await page.waitForTimeout(700);
      expect(state.failed).toBe(afterFail);
      await expect(more).toBeEnabled();

      state.fail = false;
      await more.click();
      await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(120, { timeout: 15_000 });
      expect(state.failed).toBe(afterFail);
    });

    // content.tsx:213 renders ErrorState whenever q.isError, which TanStack also sets when only fetchNextPage failed
    test("regression: a failed next page keeps the already loaded events", async ({ page }) => {
      const u = await seedMany(120);
      await page.setViewportSize({ width: 1280, height: 9000 });
      await failNextPages(page);
      await page.goto(contentUrl({ authors: [u.pubkey] }));
      await expect(page.getByRole("button", { name: "Load more" })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(50);
      await expect(page.getByText("Something went wrong")).toHaveCount(0);
    });
  });
});
