/**
 * Passkeys for real: a CDP virtual authenticator registers a credential from the account page and signs in with it.
 * WebAuthn refuses IP origins, so this needs the suite served on localhost (E2E_HOST=localhost); skipped otherwise.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { freshPage, makeAdmin, ownerApi, signInWithKey } from "./auth-support";

test.skip(({ baseURL }) => new URL(baseURL!).hostname !== "localhost", "WebAuthn needs a localhost origin (run with E2E_HOST=localhost)");
test.skip(({ browserName }) => browserName !== "chromium", "virtual authenticators are a Chromium CDP feature");

async function virtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

test("register a passkey on the account page, sign in with it (discoverable and by npub), then remove it", async ({ browser, baseURL }) => {
  const admin = await makeAdmin("moderator");
  const { context, page } = await freshPage(browser, baseURL!);
  try {
    const { cdp, authenticatorId } = await virtualAuthenticator(context, page);
    await page.goto("login");
    await signInWithKey(page, admin.nsec);
    await expect(page).not.toHaveURL(/\/login/);

    await page.goto("account");
    const card = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: /^\s*Passkeys\s*$/ }) });
    await card.getByRole("button", { name: "Add passkey" }).click();
    const dialog = page.getByRole("dialog", { name: "Add passkey" });
    await dialog.getByLabel("Name").fill("Virtual key");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Passkey added")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText("Virtual key")).toBeVisible();
    await expect(card).toContainText("never used");
    expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials).toHaveLength(1);

    // sign out, then back in with the passkey alone (discoverable), and once more naming the account
    for (const login of ["", admin.npub]) {
      await page.getByRole("button", { name: "Sign out" }).first().click();
      await expect(page).toHaveURL(/\/login/);
      await page.getByRole("tab", { name: "Passkey", exact: true }).click();
      if (login) await page.getByPlaceholder(/npub or name/).fill(login);
      await page.getByRole("button", { name: "Sign in with passkey" }).click();
      await expect(page).not.toHaveURL(/\/login/);
      await page.goto("account");
    }
    await expect(card).toContainText("last used");
    const audit = await ownerApi("GET", `/audit?action=auth.login&actor=${admin.pubkey}`);
    expect(audit.body.items.map((e: { details: { method: string } }) => e.details.method)).toEqual(["passkey", "passkey", "nostr"]);

    // removing it: a passkey sign-in counts as a fresh login, so no password is asked for
    await card.getByRole("button", { name: "Remove passkey" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Passkey removed")).toBeVisible();
    await expect(card).toContainText("No passkeys registered.");

    // the authenticator still holds the credential, but the relay no longer accepts it
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.getByRole("tab", { name: "Passkey", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(page.getByRole("alert").or(page.locator("[data-sonner-toast]")).first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await context.close();
  }
});
