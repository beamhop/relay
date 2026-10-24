/** Helpers shared by the auth-*, shell-* and settings-* specs (Node-safe: no Bun APIs). */
import { nip19 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { expect, type Browser, type Page } from "@playwright/test";
import { adminApi, newUser, type ApiResult } from "../harness/client";
import { owner } from "./fixtures";

/** storageState for a signed-out browser context */
export const SIGNED_OUT = { cookies: [], origins: [] };

export const ownerSk = () => Uint8Array.from(Buffer.from(owner().skHex, "hex"));

/** Admin API as the owner (NIP-98, so it never touches the browser's session). */
export const ownerApi = <T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> => adminApi<T>(owner().http, ownerSk(), method, nonce(path), body);

/**
 * Two identical NIP-98 requests within one second sign to the same event id, which the server rejects as a replay;
 * a throwaway query param makes every signed URL unique.
 */
const nonce = (path: string) => `${path}${path.includes("?") ? "&" : "?"}_n=${Math.random().toString(36).slice(2)}`;

export interface TestAdmin {
  sk: Uint8Array;
  pubkey: string;
  npub: string;
  nsec: string;
  skHex: string;
  api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>>;
}

/** A fresh pubkey given an admin role by the owner (so its sessions/passwords can't disturb the shared owner session). */
export async function makeAdmin(role: "admin" | "moderator" | "viewer" | "owner" = "admin"): Promise<TestAdmin> {
  const u = newUser();
  const r = await ownerApi("PUT", `/users/${u.pubkey}/role`, { role });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return {
    ...u,
    npub: nip19.npubEncode(u.pubkey),
    nsec: nip19.nsecEncode(u.sk),
    skHex: bytesToHex(u.sk),
    api: (method, path, body) => adminApi(owner().http, u.sk, method, nonce(path), body),
  };
}

/** Fills the Key tab on the login page that is already open (keeps its ?redirect=). */
export async function signInWithKey(page: Page, key: string) {
  await page.getByRole("tab", { name: "Key", exact: true }).click();
  await page.getByLabel("Private key").fill(key);
  await page.getByRole("button", { name: /sign in with key/i }).click();
}

/** A new signed-out page (own context, no console guard) — for flows that log errors on purpose, or need a fresh login. */
export async function freshPage(browser: Browser, baseURL: string, opts: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT, ...opts });
  return { context, page: await context.newPage() };
}

/** Sign in as the owner with a brand-new session (log out / expire it freely without touching the shared one). */
export async function ownSession(page: Page, path = "./") {
  await page.goto("login");
  await signInWithKey(page, owner().nsec);
  await expect(page).not.toHaveURL(/\/login/);
  if (path !== "./") await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

/** Opens the command palette with ⌘/Ctrl+K (retries until the shell's key listener is attached). */
export async function openPalette(page: Page) {
  const input = page.getByPlaceholder(/Search pages/);
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(input).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 5000 });
  return input;
}

/** Path + query of the page, relative to /admin (what the app's router calls `href`). */
export const appHref = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname.replace(/^\/admin/, "") + u.search;
};

export const uniq = (p = "e2e") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });
