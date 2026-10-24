import { generateSecretKey, nip19 } from "nostr-tools";
import { test, expect, owner } from "./fixtures";
import { openPalette, SIGNED_OUT, makeAdmin, ownSession, signInWithKey, toast, uniq } from "./auth-support";

test.use({ storageState: SIGNED_OUT });

test.describe("key login", () => {
  test("valid nsec signs in and lands on the dashboard", async ({ page }) => {
    await page.goto("login");
    await expect(page.getByText("beamhop admin")).toBeVisible();
    await signInWithKey(page, owner().nsec);
    await expect(page).toHaveURL(/\/admin\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(toast(page, "Signed in")).toBeVisible();
    // the key field is cleared once the login ran
    await page.goto("login");
    await page.getByRole("tab", { name: "Key", exact: true }).click();
    await expect(page.getByLabel("Private key")).toHaveValue("");
  });

  test("64-char hex secret key works too", async ({ page }) => {
    await page.goto("login");
    await signInWithKey(page, owner().skHex);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("an invalid key shows an error and stays on the login page", async ({ page }) => {
    await page.goto("login");
    await signInWithKey(page, "nsec1notarealkey");
    await expect(toast(page, "Sign-in failed")).toBeVisible();
    await expect(toast(page, /Enter an nsec/)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // and the API agrees: no session
    expect((await page.request.get("api/auth/me")).status()).toBe(401);
  });

  test("the sign-in button is disabled until a key is entered", async ({ page }) => {
    await page.goto("login");
    await page.getByRole("tab", { name: "Key", exact: true }).click();
    const btn = page.getByRole("button", { name: /sign in with key/i });
    await expect(btn).toBeDisabled();
    await page.getByLabel("Private key").fill("   ");
    await expect(btn).toBeDisabled();
    await page.getByLabel("Private key").fill("abc");
    await expect(btn).toBeEnabled();
  });

  test("a valid key without an admin role is refused", async ({ page }) => {
    await page.goto("login");
    await signInWithKey(page, nip19.nsecEncode(generateSecretKey()));
    await expect(toast(page, "Sign-in failed")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get("api/auth/me")).status()).toBe(401);
  });
});

test.describe("password login", () => {
  test("password set via the API signs in (npub login)", async ({ page }) => {
    const admin = await makeAdmin("admin");
    const password = uniq("pw");
    const set = await admin.api("POST", "/auth/password/set", { password });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    await page.goto("login");
    await page.getByRole("tab", { name: "Password", exact: true }).click();
    await page.getByLabel("npub, hex pubkey or NIP-05 name").fill(admin.npub);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const me = await (await page.request.get("api/auth/me")).json();
    expect(me.pubkey).toBe(admin.pubkey);
    expect(me.hasPassword).toBe(true);
  });

  test("hex pubkey works as the login name", async ({ page }) => {
    const admin = await makeAdmin("moderator");
    const password = uniq("pw");
    expect((await admin.api("POST", "/auth/password/set", { password })).status).toBe(200);
    await page.goto("login");
    await page.getByRole("tab", { name: "Password", exact: true }).click();
    await page.getByLabel("npub, hex pubkey or NIP-05 name").fill(admin.pubkey);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect((await (await page.request.get("api/auth/me")).json()).role).toBe("moderator");
  });

  test("a wrong password is rejected with a message", async ({ page }) => {
    const admin = await makeAdmin("admin");
    expect((await admin.api("POST", "/auth/password/set", { password: uniq("pw") })).status).toBe(200);
    await page.goto("login");
    await page.getByRole("tab", { name: "Password", exact: true }).click();
    await page.getByLabel("npub, hex pubkey or NIP-05 name").fill(admin.npub);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(toast(page, "Sign-in failed")).toBeVisible();
    await expect(toast(page, /invalid login or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // no 2FA prompt for a plain wrong password
    await expect(page.getByLabel("Authenticator code")).toHaveCount(0);
    expect((await page.request.get("api/auth/me")).status()).toBe(401);
  });
});

test.describe("logout", () => {
  test("sign out from the user menu ends the session server-side", async ({ page, context }) => {
    await ownSession(page);
    const cookie = (await context.cookies()).find((c) => c.name === "bh_session");
    expect(cookie, "session cookie").toBeTruthy();

    await page.locator('[data-slot="sidebar"]').getByRole("button", { name: /owner/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // the old cookie is dead even if someone kept a copy
    const res = await page.request.get("api/auth/me", { headers: { Cookie: `bh_session=${cookie!.value}` } });
    expect(res.status()).toBe(401);
    // and protected pages bounce to the login page again
    await page.goto("users");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fusers/);
  });

  test("sign out from the command palette", async ({ page }) => {
    await ownSession(page);
    await (await openPalette(page)).fill("sign out");
    await page.getByRole("option", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("api/auth/me")).status()).toBe(401);
  });

  test("sign out from the account page", async ({ page }) => {
    await ownSession(page, "account");
    await page.getByRole("main").getByRole("button", { name: "Sign out" }).or(page.getByRole("button", { name: "Sign out" })).first().click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("api/auth/me")).status()).toBe(401);
  });
});
