/** NIP-11 auth_required / restricted_writes advertised in auth-required mode, and their enforcement (NIP-42). */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Relay } from "../harness/relay";
import { newUser } from "../harness/client";
import { clients, ids, isClosed, publishOk, rand, sign, startCoreRelay } from "./core-helpers";

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay({ access: { mode: "auth-required" } });
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

test("NIP-11 advertises auth_required and restricted_writes", async () => {
  const doc = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
  expect(doc.limitation.auth_required).toBe(true);
  expect(doc.limitation.restricted_writes).toBe(true);
  expect(doc.supported_nips).toContain(42);
});

test("unauthenticated REQ is CLOSED with auth-required:", async () => {
  const c = await cs.connect(relay.ws);
  c.send(["REQ", "r", { limit: 1 }]);
  expect((await c.waitFor(isClosed("r")))[2] as string).toStartWith("auth-required:");
});

test("unauthenticated EVENT is refused with auth-required:", async () => {
  const c = await cs.connect(relay.ws);
  const r = await c.publish(sign(newUser().sk, { kind: 1, content: "anon" }));
  expect(r.ok).toBe(false);
  expect(r.message).toStartWith("auth-required:");
});

test("after AUTH the user can publish and read their events", async () => {
  const c = await cs.connect(relay.ws);
  const u = newUser();
  expect((await c.auth(u.sk, relay.ws)).ok).toBe(true);
  const ev = await publishOk(c, sign(u.sk, { kind: 1, content: `authed ${rand()}` }));
  expect(ids((await c.query("mine", [{ ids: [ev.id] }])).events)).toEqual([ev.id]);
});

test("authenticated as A, publishing an event authored by B is restricted:", async () => {
  const c = await cs.connect(relay.ws);
  const [a, b] = [newUser(), newUser()];
  await c.auth(a.sk, relay.ws);
  const r = await c.publish(sign(b.sk, { kind: 1, content: "not mine" }));
  expect(r.ok).toBe(false);
  expect(r.message).toStartWith("restricted:");
});

test("AUTH with a wrong challenge is refused and grants nothing", async () => {
  const c = await cs.connect(relay.ws);
  const u = newUser();
  await c.waitFor((m) => m[0] === "AUTH");
  const ev = sign(u.sk, { kind: 22242, tags: [["relay", relay.ws], ["challenge", "wrong"]] });
  c.send(["AUTH", ev]);
  const ok = await c.waitFor((m) => m[0] === "OK" && m[1] === ev.id);
  expect(ok[2]).toBe(false);
  const r = await c.publish(sign(u.sk, { kind: 1, content: "still anon" }));
  expect(r.message).toStartWith("auth-required:");
});
