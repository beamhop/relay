/** Shared helpers for the core-*.test.ts NIP-01 suites (black-box: ws + http only). */
import { randomBytes } from "node:crypto";
import { expect } from "bun:test";
import type { Event } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, adminApi, now, sign, type Msg } from "../harness/client";

export { now, sign };

/** Rate limits and the per-IP connection cap off, so a whole file can run from 127.0.0.1 without tripping them. */
export const RELAXED_LIMITS = { eventsPerMinute: 0, reqPerMinute: 0, connectionsPerIp: 0 };

/** Starts a relay and applies runtime settings through the admin API (NIP-98, as the owner). */
export async function startCoreRelay(settings: Record<string, unknown> = {}): Promise<Relay> {
  const relay = await startRelay();
  const limits = { ...RELAXED_LIMITS, ...((settings.limits as Record<string, unknown>) ?? {}) };
  await patchSettings(relay, { ...settings, limits });
  return relay;
}

export async function patchSettings(relay: Relay, patch: Record<string, unknown>) {
  const res = await adminApi(relay.http, relay.owner.sk, "PATCH", "/settings", patch);
  if (res.status !== 200) throw new Error(`settings patch failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.settings;
}

export const rand = (n = 8) => randomBytes(n).toString("hex");

/** Opens a client and registers it for closing at the end of the test. */
export function clients() {
  const open: RelayClient[] = [];
  return {
    async connect(url: string) {
      const c = await RelayClient.connect(url);
      open.push(c);
      return c;
    },
    closeAll() {
      for (const c of open.splice(0)) c.close();
    },
  };
}

/** Sends a raw (unparsed) text frame. */
export function sendRaw(c: RelayClient, data: string) {
  c.ws.send(data);
}

export const isOk = (id: string) => (m: Msg) => m[0] === "OK" && m[1] === id;
export const isNotice = (m: Msg) => m[0] === "NOTICE";
export const isClosed = (sub: string) => (m: Msg) => m[0] === "CLOSED" && m[1] === sub;
export const isEose = (sub: string) => (m: Msg) => m[0] === "EOSE" && m[1] === sub;
export const isEventFor = (sub: string, id?: string) => (m: Msg) => m[0] === "EVENT" && m[1] === sub && (id === undefined || (m[2] as Event).id === id);

export async function publishOk(c: RelayClient, ev: Event) {
  const r = await c.publish(ev);
  expect(r).toEqual({ ok: true, message: "" });
  return ev;
}

export const ids = (evs: Event[]) => evs.map((e) => e.id);

/** Strips nostr-tools' verified symbol so events compare structurally with what came over the wire. */
export const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
