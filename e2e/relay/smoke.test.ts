import { afterAll, beforeAll, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, adminApi, newUser, sign } from "../harness/client";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => relay?.stop());

test("harness: publish + query + admin api with NIP-98", async () => {
  const c = await RelayClient.connect(relay.ws);
  const u = newUser();
  const ev = sign(u.sk, { kind: 1, content: "harness smoke" });
  expect((await c.publish(ev)).ok).toBe(true);
  const { events } = await c.query("q", [{ ids: [ev.id] }]);
  expect(events.map((e) => e.id)).toEqual([ev.id]);
  c.close();
  const me = await adminApi(relay.http, relay.owner.sk, "GET", "/auth/me");
  expect(me.status).toBe(200);
  const anon = await adminApi(relay.http, null, "GET", "/auth/me");
  expect(anon.status).toBe(401);
  const stranger = await adminApi(relay.http, u.sk, "GET", "/auth/me");
  expect([401, 403]).toContain(stranger.status);
});
