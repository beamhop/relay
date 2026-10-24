import { nip19 } from "nostr-tools";
import { test, expect, owner } from "./fixtures";
import { newUser, note, pngBytes, publish, uid } from "./seed-content";

// these specs exercise the PWA service worker (blocked by default in playwright.config.ts)
test.use({ serviceWorkers: "allow" });

const pushCard = (page: import("@playwright/test").Page) => page.locator('[data-slot="card"]').filter({ hasText: "Get push notifications on this device" });

test("account page shows the identity and every card", async ({ page }) => {
  await page.goto("account");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(page.getByText(nip19.npubEncode(owner().pubkey))).toBeVisible();
  for (const title of ["Notifications", "Privacy", "Appearance"]) await expect(page.getByText(title, { exact: true })).toBeVisible();

  const me = await (await page.request.get("api/auth/me")).json();
  const card = (title: string) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^\\s*${title}\\s*$`) }) });

  const pw = card("Password");
  await expect(pw).toHaveCount(1);
  await expect(pw.getByLabel("New password", { exact: true })).toBeEditable();
  await expect(pw.getByLabel("Confirm new password", { exact: true })).toBeEditable();
  await expect(pw.getByLabel("Current password", { exact: true })).toHaveCount(me.hasPassword ? 1 : 0);
  const pwButton = pw.getByRole("button", { name: me.hasPassword ? "Change password" : "Set password" });
  await expect(pwButton).toBeDisabled();
  // the button follows the form: too short / mismatched stays disabled, a matching pair enables it (nothing submitted)
  await pw.getByLabel("New password", { exact: true }).fill("short");
  await expect(pw.getByText("Use at least 8 characters")).toBeVisible();
  await pw.getByLabel("New password", { exact: true }).fill("long-enough-1");
  await pw.getByLabel("Confirm new password", { exact: true }).fill("long-enough-2");
  await expect(pw.getByText("Passwords don't match")).toBeVisible();
  await expect(pwButton).toBeDisabled();
  await pw.getByLabel("Confirm new password", { exact: true }).fill("long-enough-1");
  await expect(pwButton).toBeEnabled();

  const totp = card("Two-factor authentication");
  await expect(totp).toHaveCount(1);
  await expect(totp.getByText(!me.hasPassword ? "Set a password first to enable two-factor authentication." : me.hasTotp ? "Enabled — password sign-ins ask for a 6-digit code." : "Not enabled.")).toBeVisible();
  if (me.hasTotp) await expect(totp.getByRole("button", { name: "Disable" })).toBeEnabled();
  else if (me.hasPassword) await expect(totp.getByRole("button", { name: "Set up" })).toBeEnabled();
  else await expect(totp.getByRole("button", { name: "Set up" })).toBeDisabled();

  const pk = card("Passkeys");
  await expect(pk).toHaveCount(1);
  await expect(pk.getByText("Sign in with Face ID, Touch ID, Windows Hello or a security key.")).toBeVisible();
  await expect(pk.getByRole("button", { name: "Add passkey" })).toBeVisible();
  await expect(pk.getByRole("button", { name: "Remove passkey" })).toHaveCount(me.passkeys.length);
  if (!me.passkeys.length) await expect(pk.getByText("No passkeys registered.")).toBeVisible();
});

test("push card: configured server, notification permission denied → clear error, nothing enabled", async ({ page }) => {
  const sys = await (await page.request.get("api/system")).json();
  await page.goto("account");
  const card = pushCard(page);
  if (!sys.pushEnabled) {
    await expect(card.getByText("Push notifications are not configured on this server.")).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
    return;
  }
  // both topics offered and checked by default
  await expect(card.getByRole("checkbox")).toHaveCount(2);
  for (const cb of await card.getByRole("checkbox").all()) await expect(cb).toHaveAttribute("data-state", "checked");
  const enable = card.getByRole("button", { name: /Enable notifications/ });
  await expect(enable).toBeEnabled();
  // unchecking every topic disables the button
  await card.getByRole("checkbox").nth(0).click();
  await card.getByRole("checkbox").nth(1).click();
  await expect(enable).toBeDisabled();
  await card.getByRole("checkbox").nth(0).click();
  await expect(enable).toBeEnabled();
  // headless Chromium denies the notification prompt
  await enable.click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /Could not enable notifications/ })).toBeVisible();
  await expect(card.getByRole("button", { name: /Disable on this device/ })).toHaveCount(0);
});

test("push card: a browser without the Push API says it is unsupported", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { PushManager?: unknown }).PushManager;
  });
  await page.goto("account");
  const card = pushCard(page);
  await expect(card.getByText(/This browser doesn't support web push/)).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("push card: without a service worker API it still renders the unsupported state", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get: () => undefined });
    delete (Navigator.prototype as { serviceWorker?: unknown }).serviceWorker;
  });
  await page.goto("account");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(pushCard(page).getByText(/doesn't support web push/)).toBeVisible();
});

test("privacy switches persist on this device", async ({ page }) => {
  await page.goto("account");
  const sw = page.getByRole("switch", { name: /Load world map tiles/ });
  const before = await sw.getAttribute("data-state");
  await sw.click();
  const after = before === "checked" ? "unchecked" : "checked";
  await expect(sw).toHaveAttribute("data-state", after);
  await page.reload();
  await expect(page.getByRole("switch", { name: /Load world map tiles/ })).toHaveAttribute("data-state", after);
});

test("remote media switch: off shows a click-to-load placeholder and fetches nothing; on loads the image", async ({ page }) => {
  const id = uid();
  const host = `media-${id}.e2e-remote.test`;
  const src = `https://${host}/pic.png`;
  const u = newUser();
  await publish(note(`remote pic ${id} ${src}`, { sk: u.sk }));
  // the remote host is answered locally; every request to it is counted
  const hits: string[] = [];
  page.on("request", (r) => new URL(r.url()).host === host && hits.push(r.url()));
  await page.route((url) => url.host === host, (r) => r.fulfill({ contentType: "image/png", body: Buffer.from(pngBytes()) }));
  const contentUrl = `content?f=${encodeURIComponent(JSON.stringify(JSON.stringify({ authors: [u.pubkey] })))}`;
  // the host is unique to this test, so page-wide locators only ever see this event's media
  const placeholder = () => page.getByRole("button", { name: `Load image from ${host}`, exact: true });
  const img = () => page.locator(`img[src="${src}"]`);

  // off (the default)
  await page.goto("account");
  const remote = page.getByRole("switch", { name: /Load remote images and video/ });
  await expect(remote).toHaveAttribute("data-state", "unchecked");
  await page.goto(contentUrl);
  await expect(placeholder()).toBeVisible();
  await expect(img()).toHaveCount(0);
  expect(hits).toEqual([]);
  // a click loads that one image
  await placeholder().click();
  await expect(img()).toBeVisible();
  await expect.poll(() => hits.length).toBeGreaterThan(0);

  // on: persists across a reload and loads remote media without a click
  await page.goto("account");
  await remote.click();
  await expect(remote).toHaveAttribute("data-state", "checked");
  await page.reload();
  await expect(page.getByRole("switch", { name: /Load remote images and video/ })).toHaveAttribute("data-state", "checked");
  hits.length = 0;
  await page.goto(contentUrl);
  await expect(img()).toBeVisible();
  await expect(placeholder()).toHaveCount(0);
  await expect.poll(() => hits.length).toBeGreaterThan(0);
  expect(await img().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);

  // off again: back to the placeholder, no request
  await page.goto("account");
  await page.getByRole("switch", { name: /Load remote images and video/ }).click();
  await expect(page.getByRole("switch", { name: /Load remote images and video/ })).toHaveAttribute("data-state", "unchecked");
  hits.length = 0;
  await page.goto(contentUrl);
  await expect(placeholder()).toBeVisible();
  await expect(img()).toHaveCount(0);
  expect(hits).toEqual([]);
});
