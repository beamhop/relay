import { test, expect } from "./fixtures";
import { freshPage, makeAdmin, signInWithKey } from "./auth-support";

test("sessions card: lists this admin's sessions; ending one or all the others signs those browsers out", async ({ browser, baseURL }) => {
  const admin = await makeAdmin("moderator");
  const signIn = async () => {
    const s = await freshPage(browser, baseURL!);
    await s.page.goto("login");
    await signInWithKey(s.page, admin.nsec);
    await expect(s.page).not.toHaveURL(/\/login/);
    return s;
  };
  const [a, b, c] = [await signIn(), await signIn(), await signIn()];
  try {
    await a.page.goto("account");
    const card = a.page.locator('[data-slot="card"]').filter({ has: a.page.locator('[data-slot="card-title"]', { hasText: /^\s*Sessions\s*$/ }) });
    await expect(card.getByText("this device")).toHaveCount(1);
    await expect(card.getByText(/signed in with Nostr key/)).toHaveCount(3);

    // one session by its own button
    await card.getByRole("button", { name: "End session" }).first().click();
    await a.page.getByRole("alertdialog").getByRole("button", { name: "Sign out" }).click();
    await expect(a.page.getByText("Session ended")).toBeVisible();
    await expect(card.getByText(/signed in with Nostr key/)).toHaveCount(2);

    // then every other one
    await card.getByRole("button", { name: "Sign out other sessions" }).click();
    await a.page.getByRole("alertdialog").getByRole("button", { name: "Sign out others" }).click();
    await expect(a.page.getByText("Signed out of 1 other session")).toBeVisible();
    await expect(card.getByText(/signed in with Nostr key/)).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Sign out other sessions" })).toBeDisabled();

    for (const other of [b, c]) {
      await other.page.goto("users");
      await expect(other.page).toHaveURL(/\/login/);
    }
    await a.page.reload();
    await expect(a.page).toHaveURL(/\/account/);
  } finally {
    for (const s of [a, b, c]) await s.context.close();
  }
});
