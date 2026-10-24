/**
 * Node-safe seeding helpers for the users/admins/invites/ip-rules specs (Playwright runs in Node, so no Bun APIs):
 * a tiny websocket publisher, NIP-98 admin API calls, CDP touch gestures, and a console guard that can tolerate
 * the browser's own "Failed to load resource: 500" log for requests a test fails on purpose.
 */
import { createHash, randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event, type EventTemplate } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { Page } from "@playwright/test";
import { test as base, expect, owner } from "./fixtures";

export const now = () => Math.floor(Date.now() / 1000);
export const uid = (p = "t") => `${p}${randomBytes(4).toString("hex")}`;

export interface SeedUser {
  sk: Uint8Array;
  pubkey: string;
  npub: string;
  nsec: string;
  name: string;
}

export function makeUser(name = uid("u")): SeedUser {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(sk), name };
}

export function sign(sk: Uint8Array, t: Partial<EventTemplate> & { kind: number }): Event {
  return finalizeEvent({ created_at: now(), tags: [], content: "", ...t }, sk);
}

/** Publishes events over one websocket and waits for every OK. */
export async function publish(events: Event[]): Promise<void> {
  const ws = new WebSocket(owner().ws);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map(events.map((e) => [e.id, e]));
  const done = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for OK of ${[...pending.keys()].join(",")}`)), 10_000);
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      if (f[0] !== "OK" || !pending.has(f[1])) return;
      if (!f[2]) {
        clearTimeout(t);
        rej(new Error(`event rejected: ${f[3]}`));
        return;
      }
      pending.delete(f[1]);
      if (!pending.size) {
        clearTimeout(t);
        res();
      }
    };
  });
  for (const e of events) ws.send(JSON.stringify(["EVENT", e]));
  try {
    await done;
  } finally {
    ws.close();
  }
}

/** A user that exists on the relay because it published a profile (and optionally notes). */
export async function seedUser(opts: { name?: string; notes?: string[] } = {}): Promise<SeedUser> {
  const u = makeUser(opts.name);
  const evs = [sign(u.sk, { kind: 0, content: JSON.stringify({ name: u.name }) })];
  for (const n of opts.notes ?? []) evs.push(sign(u.sk, { kind: 1, content: n }));
  await publish(evs);
  await waitListed(u.pubkey, evs.length);
  return u;
}

/**
 * The relay buffers user activity (first/last seen, event counts) and flushes it every ~2s; the users *list* reads
 * the table only, so wait until the row is written with at least `events` counted.
 */
export async function waitListed(pubkey: string, events = 1) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await apiOk<{ items: { pubkey: string; eventCount: number }[] }>("GET", `/users?search=${pubkey}&limit=5`);
    const hit = r.items.find((i) => i.pubkey === pubkey);
    // the list overlays pending counts on rows it finds, so also require the row itself to be present
    if (hit && hit.eventCount >= events) return;
    if (Date.now() > deadline) throw new Error(`user ${pubkey} not listed with ${events} events`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ------------------------------------------------------------------ admin API (NIP-98, as the owner)
const sha256 = (d: string) => createHash("sha256").update(d).digest("hex");
function nip98(sk: Uint8Array, url: string, method: string, body?: string) {
  const tags = [["u", url], ["method", method], ["nonce", randomBytes(8).toString("hex")]];
  if (body) tags.push(["payload", sha256(body)]);
  return `Nostr ${Buffer.from(JSON.stringify(sign(sk, { kind: 27235, tags }))).toString("base64")}`;
}

export async function api<T = any>(method: string, path: string, body?: unknown, sk: Uint8Array = hexToBytes(owner().skHex)): Promise<{ status: number; body: T }> {
  const url = `${owner().http}/admin/api${path}`;
  const raw = body === undefined ? (method === "GET" || method === "DELETE" ? undefined : "{}") : JSON.stringify(body);
  const headers: Record<string, string> = { "X-Requested-With": "beamhop", Accept: "application/json", Authorization: nip98(sk, url, method, raw) };
  if (raw !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: raw });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed as T };
}

export async function apiOk<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Adds N users (no events) carrying `tag`, via POST /users. */
export async function addTaggedUsers(n: number, tag: string): Promise<SeedUser[]> {
  const users = Array.from({ length: n }, () => makeUser());
  for (let i = 0; i < users.length; i += 10) {
    await Promise.all(users.slice(i, i + 10).map((u) => apiOk("POST", "/users", { pubkey: u.pubkey, tags: [tag] })));
  }
  return users;
}

export const setRole = (pubkey: string, role: string | null) => apiOk("PUT", `/users/${pubkey}/role`, { role });
export const getUser = (pubkey: string) => apiOk(`GET`, `/users/${pubkey}`);
export const ownerSk = () => hexToBytes(owner().skHex);
export { bytesToHex, nip19 };

// ------------------------------------------------------------------ touch gestures (CDP, real touch events)
async function cdp(page: Page) {
  return page.context().newCDPSession(page);
}

async function centerOf(page: Page, sel: Parameters<Page["locator"]>[0] | ReturnType<Page["locator"]>) {
  const loc = typeof sel === "string" ? page.locator(sel) : sel;
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width };
}

/** Holds a finger on the element for `ms` (long-press), then lifts it. */
export async function longPress(page: Page, loc: ReturnType<Page["locator"]>, ms = 650) {
  const { x, y } = await centerOf(page, loc);
  const s = await cdp(page);
  await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await s.detach();
}

/** Horizontal swipe across the element: `dir` left (negative) or right (positive), in ~10 moves. */
export async function swipe(page: Page, loc: ReturnType<Page["locator"]>, dir: "left" | "right", px?: number) {
  const { x, y, w } = await centerOf(page, loc);
  const dist = (dir === "left" ? -1 : 1) * (px ?? Math.min(w * 0.45, 200));
  const s = await cdp(page);
  await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await s.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dist * i) / 10, y }] });
    await page.waitForTimeout(16);
  }
  await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await s.detach();
}

// ------------------------------------------------------------------ console guard override
/**
 * Same guard as fixtures.ts, but tests that stub a 5xx response on purpose can call `allowServerErrors()`: only the
 * browser's own network log line for that status is then tolerated — real console errors and page errors still fail.
 */
export const test = base.extend<{ allowServerErrors: () => void }, object>({
  allowServerErrors: async ({}, use) => {
    await use(() => {
      allow.value = true;
    });
  },
  consoleGuard: [
    async ({ page }, use) => {
      allow.value = false;
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text();
        if (/Failed to load resource: the server responded with a status of (4\d\d)/.test(t)) return;
        if (allow.value && /Failed to load resource: the server responded with a status of (5\d\d)/.test(t)) return;
        errors.push(`console.error: ${t}`);
      });
      await use();
      expect(errors, errors.join("\n")).toEqual([]);
    },
    // overriding an auto fixture: Playwright's types omit `auto` here, but it must stay on at runtime
    { auto: true } as unknown as { scope: "test" },
  ],
});
const allow = { value: false };
export { expect, owner };

/**
 * Fails every request matching `url` (and `method`) with a JSON 500.
 * Needs `test.use({ serviceWorkers: "block" })`: once the PWA service worker has installed and claimed the page
 * (timing varies with how long its precache takes), the page's fetches go through its fetch handler and Playwright's
 * routes no longer see them, so the request reaches the real server.
 */
export async function fail500(page: Page, url: string | RegExp, method?: string) {
  await page.route(url, (route) => {
    if (method && route.request().method() !== method) return route.fallback();
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom from test" }) });
  });
}

/** Counts requests matching `pred` from now on. */
export function countRequests(page: Page, pred: (url: string, method: string) => boolean) {
  const c = { n: 0 };
  page.on("request", (r) => {
    if (pred(r.url(), r.method())) c.n++;
  });
  return c;
}
