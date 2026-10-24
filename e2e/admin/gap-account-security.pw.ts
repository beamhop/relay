/**
 * Account page sign-in methods: password set/change (with validation), TOTP setup → password+code sign-in →
 * disable (codes computed here with RFC 6238), the re-auth dialog, and the passkey list. Each test signs in a fresh
 * admin in its own context so passwords/2FA never touch the shared owner session.
 */
import { createHmac } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { freshPage, makeAdmin, ownerApi, signInWithKey, toast, uniq, type TestAdmin } from "./auth-support";

// ---------------------------------------------------------------- RFC 6238 (SHA-1, 30 s, 6 digits)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(s: string): Buffer {
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]/g, "").toUpperCase()) {
    v = (v << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, "0");
}
const step = () => Math.floor(Date.now() / 1000 / 30);
/** the code `offset` steps from now (the server accepts -1, 0, +1, each step once and in increasing order) */
const totp = (secret: string, offset = 0) => hotp(secret, step() + offset);
/** a 6-digit code the server won't accept right now */
function wrongCode(secret: string) {
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => totp(secret, d)));
  for (let i = 10; ; i++) if (!valid.has(totp(secret, i))) return totp(secret, i);
}

test("RFC 6238 helper matches the published SHA-1 test vector", () => {
  // RFC 6238 appendix B: secret "12345678901234567890", T = 59 s → 94287082 (8 digits) → 287082 (6 digits)
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  expect(hotp(secret, Math.floor(59 / 30))).toBe("287082");
});

// ---------------------------------------------------------------- helpers
/** A fresh context signed in (with the Key tab) as `admin`, with its own console guard. */
async function signedIn(browser: Browser, baseURL: string, admin: TestAdmin) {
  const { context, page } = await freshPage(browser, baseURL);
  const errors = guard(page);
  await page.goto("login");
  await signInWithKey(page, admin.nsec);
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("account");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  return { context, page, errors };
}
function guard(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text());
  });
  return errors;
}
async function passwordLogin(context: BrowserContext, admin: TestAdmin, password: string) {
  const page = await context.newPage();
  await page.goto("login");
  await page.getByRole("tab", { name: "Password", exact: true }).click();
  await page.getByLabel("npub, hex pubkey or NIP-05 name").fill(admin.npub);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return page;
}
const card = (page: Page, title: string) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: title }) });
const me = async (page: Page) => (await page.request.get("api/auth/me")).json();

// ---------------------------------------------------------------- password
test("set a password: length and match validation, then it signs in and the card switches to Change", async ({ browser, baseURL }) => {
  const admin = await makeAdmin("admin");
  const { context, page, errors } = await signedIn(browser, baseURL!, admin);
  try {
    const pw = card(page, "Password");
    const totpCard = card(page, "Two-factor authentication");
    await expect(pw).toContainText("Set a password to sign in without a Nostr signer.");
    await expect(pw.getByLabel("Current password")).toHaveCount(0);
    await expect(totpCard).toContainText("Set a password first");
    await expect(totpCard.getByRole("button", { name: "Set up" })).toBeDisabled();
    const submit = pw.getByRole("button", { name: "Set password" });
    await expect(submit).toBeDisabled();

    await pw.getByLabel("New password", { exact: true }).fill("short");
    await expect(pw.getByText("Use at least 8 characters")).toBeVisible();
    await expect(submit).toBeDisabled();
    const password = uniq("pw-ui");
    await pw.getByLabel("New password", { exact: true }).fill(password);
    await expect(pw.getByText("Use at least 8 characters")).toHaveCount(0);
    await pw.getByLabel("Confirm new password").fill(`${password}x`);
    await expect(pw.getByText("Passwords don't match")).toBeVisible();
    await expect(submit).toBeDisabled();
    await pw.getByLabel("Confirm new password").fill(password);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(toast(page, "Password set")).toBeVisible();
    await expect(pw.getByRole("button", { name: "Change password" })).toBeVisible();
    await expect(pw.getByLabel("Current password")).toBeVisible();
    await expect(pw.getByLabel("New password", { exact: true })).toHaveValue("");
    await expect(totpCard).toContainText("Not enabled.");
    await expect(totpCard.getByRole("button", { name: "Set up" })).toBeEnabled();
    expect((await me(page)).hasPassword).toBe(true);

    // change it (a fresh Nostr sign-in doesn't need the current one)
    const next = uniq("pw-next");
    await pw.getByLabel("New password", { exact: true }).fill(next);
    await pw.getByLabel("Confirm new password").fill(next);
    await pw.getByRole("button", { name: "Change password" }).click();
    await expect(toast(page, "Password changed")).toBeVisible();

    const other = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const old = await passwordLogin(other, admin, password);
      await expect(old.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible();
      await expect(old).toHaveURL(/\/login/);
      const ok = await passwordLogin(other, admin, next);
      await expect(ok.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    } finally {
      await other.close();
    }
    const audit = await ownerApi<{ items: unknown[] }>("GET", `/audit?action=auth.password.set&actor=${admin.pubkey}`);
    expect(audit.body.items).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------- TOTP
test("TOTP: set up with a computed code, password sign-in then asks for a code, and disable", async ({ browser, baseURL }) => {
  test.setTimeout(45_000);
  const admin = await makeAdmin("admin");
  const password = uniq("pw-totp");
  expect((await admin.api("POST", "/auth/password/set", { password })).status).toBe(200);
  const { context, page, errors } = await signedIn(browser, baseURL!, admin);
  try {
    const c = card(page, "Two-factor authentication");
    await expect(c).toContainText("Not enabled.");
    await c.getByRole("button", { name: "Set up" }).click();
    const dialog = page.getByRole("dialog", { name: "Set up authenticator app" });
    await expect(dialog).toBeVisible();
    const secret = (await dialog.locator("code").textContent())!.replace(/\s+/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    const uri = await dialog.getByRole("link", { name: "Open in authenticator app" }).getAttribute("href");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(new URL(uri!).searchParams.get("secret")).toBe(secret);

    const verify = dialog.getByRole("button", { name: "Verify and enable" });
    const code = dialog.getByLabel("Code");
    await expect(code).toBeFocused();
    await code.fill("12345");
    await expect(verify).toBeDisabled();
    await code.fill(wrongCode(secret));
    await verify.click();
    await expect(toast(page, /invalid TOTP code/i)).toBeVisible();
    await expect(dialog).toBeVisible();
    expect((await me(page)).hasTotp).toBe(false);

    // "123 456" with a space is accepted too
    const good = totp(secret, -1);
    await code.fill(`${good.slice(0, 3)} ${good.slice(3)}`);
    await verify.click();
    await expect(toast(page, "Two-factor authentication enabled")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(c).toContainText("Enabled — password sign-ins ask for a 6-digit code.");
    expect((await me(page)).hasTotp).toBe(true);

    // password sign-in: the code field appears, a wrong code is refused, the right one signs in
    const other = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const login = await passwordLogin(other, admin, password);
      const codeField = login.getByLabel("Authenticator code");
      await expect(codeField).toBeVisible();
      await expect(login).toHaveURL(/\/login/);
      await codeField.fill(wrongCode(secret));
      await login.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(login.getByText(/invalid TOTP code/i).first()).toBeVisible();
      await expect(login).toHaveURL(/\/login/);
      await codeField.fill(totp(secret, 0));
      await login.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(login.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    } finally {
      await other.close();
    }

    await c.getByRole("button", { name: "Disable" }).click();
    const off = page.getByRole("dialog", { name: "Disable two-factor authentication" });
    await off.getByLabel("Code").fill(totp(secret, 1));
    await off.getByRole("button", { name: "Disable" }).click();
    await expect(toast(page, "Two-factor authentication disabled")).toBeVisible();
    await expect(c).toContainText("Not enabled.");
    expect((await me(page)).hasTotp).toBe(false);

    const actions = (await ownerApi<{ items: { action: string }[] }>("GET", `/audit?actor=${admin.pubkey}`)).body.items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.totp.enable", "auth.totp.disable"]));
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a session the server calls stale is asked for the current password before TOTP setup", async ({ browser, baseURL }) => {
  const admin = await makeAdmin("admin");
  const password = uniq("pw-reauth");
  expect((await admin.api("POST", "/auth/password/set", { password })).status).toBe(200);
  const { context, page, errors } = await signedIn(browser, baseURL!, admin);
  try {
    const bodies: unknown[] = [];
    await page.route("**/api/auth/totp/setup", async (route) => {
      const body = route.request().postDataJSON();
      bodies.push(body);
      if (!body?.currentPassword) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "please sign in again", code: "reauth_required" }) });
      return route.fallback();
    });
    await card(page, "Two-factor authentication").getByRole("button", { name: "Set up" }).click();
    const reauth = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(reauth).toBeVisible();
    const cont = reauth.getByRole("button", { name: "Continue" });
    await expect(cont).toBeDisabled();
    await reauth.getByLabel("Current password").fill(password);
    await cont.click();
    await expect(page.getByRole("dialog", { name: "Set up authenticator app" })).toBeVisible();
    await expect(reauth).toHaveCount(0);
    expect(bodies).toEqual([{}, { currentPassword: password }]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------- passkeys
test("passkeys: empty state, add dialog, and removing a listed passkey after confirming", async ({ browser, baseURL }) => {
  const admin = await makeAdmin("admin");
  const { context, page, errors } = await signedIn(browser, baseURL!, admin);
  try {
    const pk = card(page, "Passkeys");
    await expect(pk).toContainText("No passkeys registered.");
    await pk.getByRole("button", { name: "Add passkey" }).click();
    const dialog = page.getByRole("dialog", { name: "Add passkey" });
    await expect(dialog.getByLabel("Name")).toHaveAttribute("placeholder", /passkey$/);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // WebAuthn can't run on an IP origin, so the list is fed one passkey and the DELETE is answered here
    const id = uniq("cred");
    let deleted = "";
    let removed = false;
    await page.route("**/api/auth/me", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.passkeys = removed ? [] : [{ id, name: "Test key", createdAt: Math.floor(Date.now() / 1000) - 3600, lastUsedAt: null }];
      return route.fulfill({ response: res, json });
    });
    await page.route(`**/api/auth/passkey/**`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deleted = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
      removed = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.reload();
    const row = pk.locator("div.border").filter({ hasText: "Test key" });
    await expect(row).toContainText("never used");
    await row.getByRole("button", { name: "Remove passkey" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Remove passkey “Test key”?");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(deleted).toBe("");
    await row.getByRole("button", { name: "Remove passkey" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(toast(page, "Passkey removed")).toBeVisible();
    expect(deleted).toBe(id);
    await expect(pk).toContainText("No passkeys registered.");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
