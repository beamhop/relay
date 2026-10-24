/** rate-limited: replies for events, REQs and connections per IP (each test uses its own budget keys). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser } from "../harness/client";
import { isClosed, isEose, isNotice, publishOk, rand, sign, startCoreRelay } from "./core-helpers";

const EVENTS_PER_MINUTE = 5;
const REQ_PER_MINUTE = 5;
const CONNECTIONS_PER_IP = 4;

let relay: Relay;
beforeAll(async () => {
  relay = await startCoreRelay({ limits: { eventsPerMinute: EVENTS_PER_MINUTE, reqPerMinute: REQ_PER_MINUTE, connectionsPerIp: CONNECTIONS_PER_IP } });
});
afterAll(() => relay?.stop());

/** Closes a client and waits for the close handshake, so the server has released the connection slot. */
async function closeAndWait(c: RelayClient) {
  c.close();
  const deadline = Date.now() + 2000;
  while (!c.closed && Date.now() < deadline) await Bun.sleep(5);
}

test("events beyond eventsPerMinute for one author are refused with rate-limited:; replays are not charged", async () => {
  const c = await RelayClient.connect(relay.ws);
  try {
    const u = newUser();
    const first = await publishOk(c, sign(u.sk, { kind: 1, content: `rl 0 ${rand()}` }));
    for (let i = 1; i < EVENTS_PER_MINUTE; i++) await publishOk(c, sign(u.sk, { kind: 1, content: `rl ${i} ${rand()}` }));
    const over = await c.publish(sign(u.sk, { kind: 1, content: "one too many" }));
    expect(over.ok).toBe(false);
    expect(over.message).toStartWith("rate-limited:");
    // a replay of a stored event changes nothing, so it is answered duplicate: rather than rate-limited:
    const dup = await c.publish(first);
    expect(dup.ok).toBe(true);
    expect(dup.message).toStartWith("duplicate:");
    // another author on the same connection has their own bucket
    await publishOk(c, sign(newUser().sk, { kind: 1, content: "other author" }));
  } finally {
    await closeAndWait(c);
  }
});

test("REQs beyond reqPerMinute on a connection are CLOSED with rate-limited:", async () => {
  const c = await RelayClient.connect(relay.ws);
  try {
    for (let i = 0; i < REQ_PER_MINUTE; i++) {
      c.send(["REQ", `q${i}`, { limit: 0 }]);
      await c.waitFor(isEose(`q${i}`));
      c.send(["CLOSE", `q${i}`]);
    }
    c.send(["REQ", "over", { limit: 0 }]);
    expect((await c.waitFor(isClosed("over")))[2] as string).toStartWith("rate-limited:");
  } finally {
    await closeAndWait(c);
  }
});

test("connections beyond connectionsPerIp get a rate-limited: NOTICE and are closed", async () => {
  const open: RelayClient[] = [];
  try {
    for (let i = 0; i < CONNECTIONS_PER_IP; i++) open.push(await RelayClient.connect(relay.ws));
    const extra = await RelayClient.connect(relay.ws);
    open.push(extra);
    const m = await extra.waitFor(isNotice);
    expect(m[1] as string).toStartWith("rate-limited:");
    const deadline = Date.now() + 2000;
    while (!extra.closed && Date.now() < deadline) await Bun.sleep(5);
    expect(extra.closed).toBe(true);
  } finally {
    await Promise.all(open.map(closeAndWait));
  }
});
