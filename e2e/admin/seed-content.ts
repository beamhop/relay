/**
 * Node-safe seeding helpers for the content/reports/media/dashboard/live specs (Playwright runs in Node, so the
 * harness RelayClient, which sleeps with Bun.sleep, can't be used here). Global WebSocket + fetch + nostr-tools.
 */
import type { Event } from "nostr-tools";
import type { Locator, Page } from "@playwright/test";
import { hexToBytes } from "nostr-tools/utils";
import { blossomAuth, newUser, nip98Header, pngBytes, sign, sha256, now } from "../harness/client";
import { owner, test as base, expect } from "./fixtures";

/**
 * The fixtures' console guard, plus `allowConsole`: patterns of console errors a test provokes on purpose (the
 * browser logs "Failed to load resource … 500" for every route.fulfill(500)). Page errors always fail the test.
 */
export const test = base.extend<{ allowConsole: RegExp[]; consoleGuard: void }>({
  allowConsole: [[], { option: true }],
  consoleGuard: [
    async ({ page, allowConsole }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text();
        if (/Failed to load resource: the server responded with a status of (4\d\d)/.test(t)) return;
        if (allowConsole.some((r) => r.test(t))) return;
        errors.push(`console.error: ${t}`);
      });
      await use();
      expect(errors, errors.join("\n")).toEqual([]);
    },
    // overriding an auto fixture: Playwright's types omit `auto` here, but it must stay on at runtime
    { auto: true } as unknown as { scope: "test" },
  ],
});
export { expect };
/** for tests that answer API calls with route.fulfill({status: 500}) */
export const ALLOW_500 = [/Failed to load resource: the server responded with a status of 500/];

export { newUser, pngBytes, sign, sha256, now };

export const ownerSk = () => hexToBytes(owner().skHex);
export const http = () => owner().http;
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

type Frame = unknown[];

/** One short-lived websocket: publish events and/or run a REQ, then close. */
export async function withWs<T>(fn: (ws: WsClient) => Promise<T>): Promise<T> {
  const c = await WsClient.connect(owner().ws);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

export class WsClient {
  private inbox: Frame[] = [];
  private waiters: (() => void)[] = [];
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      this.inbox.push(JSON.parse(String(m.data)));
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  static async connect(url: string): Promise<WsClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error(`ws ${url} failed`)), { once: true });
    });
    return new WsClient(ws);
  }
  private async waitFor(pred: (f: Frame) => boolean, ms = 7000): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`ws timeout; inbox ${JSON.stringify(this.inbox).slice(0, 500)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
  async publish(ev: Event): Promise<{ ok: boolean; message: string }> {
    this.ws.send(JSON.stringify(["EVENT", ev]));
    const m = await this.waitFor((f) => f[0] === "OK" && f[1] === ev.id);
    return { ok: m[2] as boolean, message: m[3] as string };
  }
  async query(filters: Record<string, unknown>[]): Promise<Event[]> {
    const sub = `q${Math.random().toString(36).slice(2, 8)}`;
    this.ws.send(JSON.stringify(["REQ", sub, ...filters]));
    await this.waitFor((f) => (f[0] === "EOSE" || f[0] === "CLOSED") && f[1] === sub);
    const out: Event[] = [];
    this.inbox = this.inbox.filter((f) => {
      if (f[0] === "EVENT" && f[1] === sub) {
        out.push(f[2] as Event);
        return false;
      }
      return true;
    });
    this.ws.send(JSON.stringify(["CLOSE", sub]));
    return out;
  }
  close() {
    this.ws.close();
  }
}

/** Publishes over ws and asserts every OK is true. */
export async function publish(...events: Event[]): Promise<Event[]> {
  await withWs(async (c) => {
    for (const e of events) {
      const r = await c.publish(e);
      if (!r.ok) throw new Error(`publish rejected: ${r.message}`);
    }
  });
  return events;
}

export const queryWs = (filters: Record<string, unknown>[]) => withWs((c) => c.query(filters));

/** Bulk seed through the admin import endpoint (no rate limits): NIP-98 as the owner. */
export async function importEvents(events: Event[]): Promise<void> {
  const url = `${http()}/admin/api/events/import?bypassPolicies=true`;
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Requested-With": "beamhop", Accept: "application/json", "Content-Type": "application/x-ndjson", Authorization: nip98Header(ownerSk(), url, "POST", body) },
    body,
  });
  const j = (await res.json()) as { imported: number; errors: string[] };
  if (!res.ok || j.imported !== events.length) throw new Error(`import failed ${res.status} ${JSON.stringify(j)}`);
}

/** A kind-1 note by a fresh user. */
export function note(content: string, opts: { sk?: Uint8Array; created_at?: number; tags?: string[][] } = {}): Event {
  return sign(opts.sk ?? newUser().sk, { kind: 1, content, tags: opts.tags ?? [], ...(opts.created_at ? { created_at: opts.created_at } : {}) });
}

/** NIP-56 report. `target`: {e, p} for an event report, {p} for a profile report, {x, p} for media. */
export function report(target: { e?: string; p: string; x?: string }, type: string, content: string, reporterSk = newUser().sk): Event {
  const tags: string[][] = [];
  if (target.e) tags.push(["e", target.e, type]);
  if (target.x) tags.push(["x", target.x, type]);
  tags.push(target.e || target.x ? ["p", target.p] : ["p", target.p, type]);
  return sign(reporterSk, { kind: 1984, content, tags });
}

/** BUD-02 upload; returns the sha256. */
export async function upload(sk: Uint8Array, bytes: Uint8Array<ArrayBuffer> = pngBytes(), type = "image/png"): Promise<string> {
  const hash = sha256(bytes);
  const res = await fetch(`${http()}/upload`, {
    method: "PUT",
    headers: { Authorization: blossomAuth(sk, "upload", { hash }), "Content-Type": type, "X-SHA-256": hash },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload failed ${res.status} ${await res.text()}`);
  return hash;
}

/**
 * Admin API call as the owner (NIP-98). Unlike harness adminApi, each auth event carries a random tag: two identical
 * calls in the same second would otherwise sign the same event and the second is refused as a replay.
 */
export async function ownerApi<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const url = `${http()}/admin/api${path}`;
  const raw = body === undefined ? (method === "GET" || method === "DELETE" ? undefined : "{}") : JSON.stringify(body);
  const tags = [["u", url], ["method", method], ["nonce", Math.random().toString(36).slice(2)]];
  if (raw) tags.push(["payload", sha256(raw)]);
  const auth = `Nostr ${Buffer.from(JSON.stringify(sign(ownerSk(), { kind: 27235, tags }))).toString("base64")}`;
  const headers: Record<string, string> = { "X-Requested-With": "beamhop", Accept: "application/json", Authorization: auth };
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

// ---------------------------------------------------------------- touch (mobile project)
async function touchAt(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", x: number, y: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  return { cdp, send, x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 40) };
}

/** A real one-finger horizontal swipe (touch events through CDP: swipe rows listen to touch, not mouse). */
export async function swipe(page: Page, target: Locator, dx: number) {
  const t = await touchAt(page, target);
  await t.send("touchStart", t.x, t.y);
  const steps = 8;
  for (let i = 1; i <= steps; i++) await t.send("touchMove", t.x + (dx * i) / steps, t.y);
  await t.send("touchEnd", t.x + dx, t.y);
  await t.cdp.detach();
}

/** Touch and hold (no movement) for `ms`. */
export async function longPress(page: Page, target: Locator, ms = 650) {
  const t = await touchAt(page, target);
  await t.send("touchStart", t.x, t.y);
  await page.waitForTimeout(ms);
  await t.send("touchEnd", t.x, t.y);
  await t.cdp.detach();
}
