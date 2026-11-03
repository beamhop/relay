/** NIP-07 sign-in through a stand-in extension: window.nostr signs in the test process with the admin's key. */
import { finalizeEvent } from "nostr-tools";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { freshPage, makeAdmin } from "./auth-support";
import { newUser } from "../harness/client";

async function installExtension(page: Page, sk: Uint8Array, opts: { refuse?: boolean } = {}) {
  const signed: unknown[] = [];
  await page.exposeFunction("__nip07Sign", (template: Parameters<typeof finalizeEvent>[0]) => {
    if (opts.refuse) throw new Error("user rejected");
    const ev = finalizeEvent(template, sk);
    signed.push(ev);
    return ev;
  });
  await page.addInitScript(() => {
    const w = window as unknown as { nostr: unknown; __nip07Sign(t: unknown): Promise<unknown> };
    w.nostr = { getPublicKey: async () => "", signEvent: (t: unknown) => w.__nip07Sign(t) };
  });
  return signed;
}

test("an admin signs in with a NIP-07 extension; the login event is a NIP-98 challenge", async ({ browser, baseURL }) => {
  const admin = await makeAdmin("viewer");
  const { context, page } = await freshPage(browser, baseURL!);
  try {
    const signed = await installExtension(page, admin.sk);
    await page.goto("login");
    await expect(page.getByText("No NIP-07 extension detected")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in with extension" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    expect(signed).toHaveLength(1);
    const ev = signed[0] as { kind: number; tags: string[][] };
    expect(ev.kind).toBe(27235);
    expect(ev.tags.map((t) => t[0]).sort()).toEqual(["challenge", "method", "u"]);
    const me = await (await page.request.get("api/auth/me")).json();
    expect(me).toMatchObject({ pubkey: admin.pubkey, role: "viewer" });
  } finally {
    await context.close();
  }
});

test("NIP-07: a key without a role, or a refused signature, stays on the login page with an error", async ({ browser, baseURL }) => {
  for (const [sk, refuse, message] of [
    [newUser().sk, false, /not an admin/i],
    [newUser().sk, true, /user rejected/i],
  ] as const) {
    const { context, page } = await freshPage(browser, baseURL!);
    try {
      await installExtension(page, sk, { refuse });
      await page.goto("login");
      await page.getByRole("button", { name: "Sign in with extension" }).click();
      await expect(page.getByText("Sign-in failed")).toBeVisible();
      await expect(page.getByText(message)).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close();
    }
  }
});

test("without an extension the button explains what to install", async ({ browser, baseURL }) => {
  const { context, page } = await freshPage(browser, baseURL!);
  try {
    await page.goto("login");
    await expect(page.getByText("No NIP-07 extension detected")).toBeVisible();
    await page.getByRole("button", { name: "Sign in with extension" }).click();
    await expect(page.getByText(/No NIP-07 extension found/)).toBeVisible();
  } finally {
    await context.close();
  }
});
