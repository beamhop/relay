import { nip19 } from "nostr-tools";
import type { Page } from "@playwright/test";
import { test, expect } from "./seed-content";
import { newUser, note, publish, sign, uid } from "./seed-content";

const JSON_BOX = '{"kinds":[1],"#t":["nostr"]}';
// TanStack Router JSON-encodes search values, so the app's own ?f= links carry the filter as a JSON string
const contentUrl = (f: unknown) => `content?f=${encodeURIComponent(JSON.stringify(JSON.stringify(f)))}`;
const urlFilters = (page: Page) => {
  const f = new URL(page.url()).searchParams.get("f");
  return f ? JSON.parse(JSON.parse(f)) : undefined;
};

test.describe("content filter editor", () => {
  test("builder fields (author, kind, tag) become the ?f= filter and narrow the list", async ({ page }) => {
    const id = uid();
    const u = newUser();
    const n = note(`builder note ${id}`, { sk: u.sk, tags: [["t", id]] });
    // same author and tag, other kind: only the kind field can exclude it
    const art = sign(u.sk, { kind: 30023, content: `builder article ${id}`, tags: [["t", id], ["d", id], ["title", `Article ${id}`]] });
    const other = note(`builder other ${id}`, { sk: u.sk });
    await publish(n, art, other);

    await page.goto("content");
    await page.getByPlaceholder("npub or hex").fill(nip19.npubEncode(u.pubkey));
    await page.getByPlaceholder("npub or hex").press("Enter");
    await page.getByPlaceholder("1, 7, 30023…").fill("1");
    await page.getByPlaceholder("1, 7, 30023…").press("Enter");
    await page.getByRole("button", { name: "Add tag" }).click();
    await expect(page.getByLabel("Tag name")).toHaveValue("t");
    await page.getByPlaceholder("values").fill(id);
    await page.getByPlaceholder("values").press("Enter");
    await page.getByRole("button", { name: "Apply filter" }).click();

    await expect.poll(() => urlFilters(page)).toEqual({ authors: [u.pubkey], kinds: [1], [`#t`]: [id] });
    await expect(page.getByText(`builder note ${id}`)).toBeVisible();
    await expect(page.getByText(`Article ${id}`)).toHaveCount(0);
    await expect(page.getByText(`builder other ${id}`)).toHaveCount(0);
    await expect(page.getByText(`#t: ${id}`)).toBeVisible();
  });

  test("invalid builder input is refused and not added", async ({ page }) => {
    await page.goto("content");
    const kinds = page.getByPlaceholder("1, 7, 30023…");
    await kinds.fill("abc");
    await kinds.press("Enter");
    await expect(page.getByText("abc: Must be an integer")).toBeVisible();
    const authors = page.getByPlaceholder("npub or hex");
    await authors.fill("npub1notakey");
    await authors.press("Enter");
    await expect(page.getByText("npub1notakey: Invalid pubkey")).toBeVisible();
  });

  test("since in the future shows the empty state; Reset clears the URL", async ({ page }) => {
    const u = newUser();
    await publish(note(`since ${uid()}`, { sk: u.sk }));
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(1);
    await page.getByLabel("Since").fill("2099-01-01T00:00");
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page.getByText("No events match")).toBeVisible();
    expect(urlFilters(page).since).toBe(Math.floor(new Date("2099-01-01T00:00").getTime() / 1000));
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("All events, newest first")).toBeVisible();
    expect(urlFilters(page)).toBeUndefined();
  });

  test("switching to Raw JSON shows the builder's filter; editing JSON applies it", async ({ page }) => {
    const id = uid();
    const u = newUser();
    const n = note(`json note ${id}`, { sk: u.sk });
    const r = sign(u.sk, { kind: 7, content: "🔥", tags: [["e", n.id], ["p", u.pubkey]] });
    await publish(n, r);
    await page.goto(contentUrl({ authors: [u.pubkey] }));
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(2);

    await page.getByRole("tab", { name: "Raw JSON" }).click();
    const box = page.getByPlaceholder(JSON_BOX);
    await expect(box).toHaveValue(JSON.stringify({ authors: [u.pubkey] }, null, 2));
    await box.fill(JSON.stringify({ authors: [u.pubkey], kinds: [7] }));
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect.poll(() => urlFilters(page)).toEqual({ authors: [u.pubkey], kinds: [7] });
    await expect(page.getByRole("checkbox", { name: "Select event" })).toHaveCount(1);
    await expect(page.getByText(`json note ${id}`)).toHaveCount(0);
    await expect(page.getByText("reacted to")).toBeVisible();

    // invalid JSON: error shown, URL untouched
    await box.fill("{nope");
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(box).toHaveAttribute("aria-invalid", "true");
    expect(urlFilters(page)).toEqual({ authors: [u.pubkey], kinds: [7] });
  });

  test("a multi-filter ?f= opens in JSON mode, Builder is refused with a toast, Apply keeps both filters", async ({ page }) => {
    const id = uid();
    const a = newUser();
    const b = newUser();
    await publish(note(`multi A ${id}`, { sk: a.sk }), note(`multi B ${id}`, { sk: b.sk }));
    const filters = [{ authors: [a.pubkey] }, { authors: [b.pubkey] }];
    await page.goto(contentUrl(filters));

    await expect(page.getByText(`multi A ${id}`)).toBeVisible();
    await expect(page.getByText(`multi B ${id}`)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Raw JSON" })).toHaveAttribute("aria-selected", "true");
    const box = page.getByPlaceholder(JSON_BOX);
    expect(JSON.parse(await box.inputValue())).toEqual(filters);

    await page.getByRole("tab", { name: "Builder" }).click();
    await expect(page.getByText("The builder edits a single filter").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Raw JSON" })).toHaveAttribute("aria-selected", "true");
    await expect(box).toBeVisible();

    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect.poll(() => urlFilters(page)).toEqual(filters);
    await expect(page.getByText(`multi A ${id}`)).toBeVisible();
    await expect(page.getByText(`multi B ${id}`)).toBeVisible();
  });

  // Radix Tabs calls onValueChange on mousedown and again on focus (automatic activation): the refused switch runs twice
  test("regression: one click on Builder with a multi-filter shows the refusal toast once", async ({ page }) => {
    const a = newUser();
    const b = newUser();
    await page.goto(contentUrl([{ authors: [a.pubkey] }, { authors: [b.pubkey] }]));
    await expect(page.getByRole("tab", { name: "Raw JSON" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Builder" }).click();
    await expect(page.getByText("The builder edits a single filter").first()).toBeVisible();
    await expect(page.getByText("The builder edits a single filter")).toHaveCount(1);
  });

  test("back/forward between a single- and a multi-filter URL keeps editor and list in sync", async ({ page }) => {
    const id = uid();
    const a = newUser();
    const b = newUser();
    await publish(note(`hist A ${id}`, { sk: a.sk }), note(`hist B ${id}`, { sk: b.sk }));
    const single = { authors: [a.pubkey] };
    const multi = [{ authors: [a.pubkey] }, { authors: [b.pubkey] }];
    await page.goto(contentUrl(single));
    await expect(page.getByText(`hist A ${id}`)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Builder" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "Raw JSON" }).click();
    await page.getByPlaceholder(JSON_BOX).fill(JSON.stringify(multi));
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page.getByText(`hist B ${id}`)).toBeVisible();

    await page.goBack();
    await expect.poll(() => urlFilters(page)).toEqual(single);
    await expect(page.getByText(`hist B ${id}`)).toHaveCount(0);
    await expect(page.getByText(`hist A ${id}`)).toBeVisible();
    const box = page.getByPlaceholder(JSON_BOX);
    await expect.poll(async () => JSON.parse(await box.inputValue())).toEqual(single);
    // single filter again: the builder accepts it and shows the author
    await page.getByRole("tab", { name: "Builder" }).click();
    await expect(page.getByRole("tab", { name: "Builder" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: `Remove ${a.pubkey}` })).toBeVisible();

    await page.goForward();
    await expect.poll(() => urlFilters(page)).toEqual(multi);
    await expect(page.getByText(`hist B ${id}`)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Raw JSON" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => JSON.parse(await page.getByPlaceholder(JSON_BOX).inputValue())).toEqual(multi);
  });
});
