/** Without server.trustProxy the relay identifies clients by the socket address and ignores X-Forwarded-For. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { connectAs, ownerApi, tryConnect } from "./policy-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay(); // trustProxy defaults to false
});
afterAll(() => relay?.stop());

test("X-Forwarded-For is ignored: the connection is attributed to 127.0.0.1", async () => {
  const c = await connectAs(relay, "10.66.66.66");
  const ips = (await ownerApi(relay, "GET", "/connections")).items.map((x: any) => x.ip);
  expect(ips).toContain("127.0.0.1");
  expect(ips).not.toContain("10.66.66.66");
  c.close();
});

test("a block on a forged X-Forwarded-For address doesn't affect the client; blocking 127.0.0.1 does", async () => {
  await ownerApi(relay, "POST", "/ip-rules", { cidr: "10.77.77.77", action: "block", reason: "x" });
  const spoof = await tryConnect(relay, "10.77.77.77");
  expect(spoof.closed).toBe(false);
  await ownerApi(relay, "POST", "/ip-rules", { cidr: "127.0.0.1", action: "block", reason: "loopback" });
  try {
    // the open connection is dropped, new ones are refused
    for (let i = 0; i < 200 && !spoof.client.closed; i++) await Bun.sleep(10);
    expect(spoof.client.closed).toBe(true);
    const r = await tryConnect(relay);
    expect(r.closed).toBe(true);
    expect(r.notices).toContain("blocked: loopback");
  } finally {
    // the admin API is HTTP, not affected by websocket IP rules
    await ownerApi(relay, "DELETE", `/ip-rules/${encodeURIComponent("127.0.0.1")}`);
  }
  const ok = await tryConnect(relay);
  expect(ok.closed).toBe(false);
  ok.client.close();
});
