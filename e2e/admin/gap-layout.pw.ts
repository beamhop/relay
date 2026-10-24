/**
 * Layout on every route: no horizontal page overflow at 375 px and 1440 px (with long unbroken content seeded),
 * and dark mode renders the key pages with a dark background and light text, without console errors.
 */
import type { Page } from "@playwright/test";
import { newUser, sign } from "../harness/client";
import { test, expect } from "./fixtures";
import { SIGNED_OUT, ownerSk, uniq } from "./auth-support";
import { publish, report } from "./seed-content";

let groupId = "";
let userPk = "";

test.beforeAll(async () => {
  // long unbroken strings are the usual cause of sideways scrolling
  const long = "x".repeat(400);
  const u = newUser();
  userPk = u.pubkey;
  const name = `name${"W".repeat(120)}`;
  const ev = sign(u.sk, { kind: 1, content: `${long} https://example.com/${"a".repeat(300)}?q=${"b".repeat(80)}` });
  await publish(sign(u.sk, { kind: 0, content: JSON.stringify({ name, about: long, nip05: `${"n".repeat(80)}@example.com` }) }), ev);
  await publish(report({ e: ev.id, p: u.pubkey }, "spam", long));
  groupId = uniq("wide").replace(/[^a-zA-Z0-9_-]/g, "") + "_".repeat(20);
  await publish(sign(ownerSk(), { kind: 9007, tags: [["h", groupId], ["name", `G${"M".repeat(150)}`], ["about", long]] }));
});

const ROUTES: [string, () => string][] = [
  ...["dashboard", "live", "users", "admins", "invites", "ip-rules", "content", "reports", "media", "groups", "settings", "plugins", "audit", "system", "account"].map(
    (r) => [r, () => (r === "dashboard" ? "./" : r)] as [string, () => string],
  ),
  ["users/:pubkey", () => `users/${userPk}`],
  ["groups/:id", () => `groups/${groupId}`],
  ["404", () => `no-such-page-${uniq()}`],
];

async function settle(page: Page) {
  await expect(page.locator("h1, p.text-5xl").first()).toBeVisible();
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 10_000 });
}
/** document scroll width vs viewport, plus the elements/text that stick out (text overflow has no element box) */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const el = document.scrollingElement!;
    const wide: string[] = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && wide.length < 3; n = w.nextNode()) {
      const r = document.createRange();
      r.selectNodeContents(n);
      if (r.getBoundingClientRect().right > window.innerWidth + 1) wide.push(`${n.parentElement!.tagName.toLowerCase()}.${String(n.parentElement!.className).slice(0, 50)}`);
    }
    return { scroll: el.scrollWidth, inner: window.innerWidth, wide };
  });

/** routes that overflow because of a product bug (seeded long unbroken strings), per width */
// routes with a known overflow bug (run as test.fixme). Empty: the long group name/about, group event card titles
// and report reasons used to overflow; they now wrap (regression-covered by the tests below)
const KNOWN: Record<string, { widths: number[]; bug: string }> = {};

for (const width of [375, 1440]) {
  test.describe(`no horizontal overflow at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 812 : 900 } });
    for (const [label, path] of ROUTES) {
      const known = KNOWN[label]?.widths.includes(width) ? KNOWN[label].bug : undefined;
      (known ? test.fixme : test)(known ? `${label}: ${known}` : label, async ({ page }) => {
        await page.goto(path());
        await settle(page);
        // re-measure until data and fonts have settled
        await expect
          .poll(async () => {
            const o = await overflow(page);
            return o.scroll <= o.inner ? "ok" : `scrollWidth ${o.scroll} > ${o.inner}: ${o.wide.join(", ")}`;
          }, { timeout: 3_000 })
          .toBe("ok");
      });
    }

    test("the login page, every tab", async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT, viewport: { width, height: 800 } });
      const page = await context.newPage();
      try {
        await page.goto("login");
        for (const tab of ["Signer", "Key", "Password", "Passkey"]) {
          await page.getByRole("tab", { name: tab, exact: true }).click();
          const o = await overflow(page);
          expect(o.scroll, `${tab}: ${o.wide.join(", ")}`).toBeLessThanOrEqual(o.inner);
        }
      } finally {
        await context.close();
      }
    });
  });
}

test.describe("dark mode", () => {
  test.use({ colorScheme: "dark" });
  /** relative luminance 0..1 of any CSS color (oklch included), resolved by the browser through a canvas */
  const lum = (page: Page, color: string) =>
    page.evaluate((c) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }, color);
  for (const r of ["./", "users", "content", "reports", "media", "settings", "audit", "system", "account"]) {
    test(`${r} renders dark with readable text`, async ({ page }) => {
      await page.goto(r);
      await settle(page);
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      const colors = await page.evaluate(() => {
        const main = document.querySelector('[data-slot="sidebar-inset"]') ?? document.body;
        const h1 = document.querySelector("h1")!;
        return { body: getComputedStyle(document.body).backgroundColor, main: getComputedStyle(main).backgroundColor, h1: getComputedStyle(h1).color };
      });
      expect(await lum(page, colors.body), colors.body).toBeLessThan(0.2);
      if (!/rgba\(0, 0, 0, 0\)/.test(colors.main)) expect(await lum(page, colors.main), colors.main).toBeLessThan(0.2);
      expect(await lum(page, colors.h1), colors.h1).toBeGreaterThan(0.7);
      const meta = await page.locator('meta[name="theme-color"]').getAttribute("content");
      expect(meta).toBe("#18181b");
    });
  }

  test("the login page renders dark", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT, colorScheme: "dark" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    try {
      await page.goto("login");
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(await lum(page, bg), bg).toBeLessThan(0.2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
