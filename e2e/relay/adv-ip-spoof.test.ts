/**
 * Address spelling games behind a trusted reverse proxy (server.trustProxy): the same client address written as
 * IPv4-mapped IPv6, with brackets/ports, in upper case or uncompressed must be one identity for IP blocks and the
 * per-address connection cap; rotating through one IPv6 /64 must not multiply the cap; junk forwarding values must
 * fall back to the socket address instead of becoming a fresh identity.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient } from "../harness/client";
import { api } from "./admin-helpers";
import { patchSettings } from "./core-helpers";
import { tryConnect } from "./policy-helpers";

let relay: Relay;
const open: RelayClient[] = [];
beforeAll(async () => {
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
  await patchSettings(relay, { limits: { eventsPerMinute: 0, reqPerMinute: 0, connectionsPerIp: 0 } });
});
afterAll(async () => {
  for (const c of open.splice(0)) c.close();
  await relay?.stop();
});

const attempt = async (xff: string) => {
  const r = await tryConnect(relay, xff, 120);
  open.push(r.client);
  return r;
};
const closeAll = async () => {
  for (const c of open.splice(0)) c.close();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const r = await api(relay.http, relay.owner.sk, "GET", "/connections");
    if (r.body.total === 0) return;
    await Bun.sleep(20);
  }
  throw new Error("connections did not drain");
};

describe("IP blocks can't be dodged by respelling the address", () => {
  test("IPv4 block vs IPv4-mapped IPv6, bracketed and port-suffixed spellings", async () => {
    const add = await api(relay.http, relay.owner.sk, "POST", "/ip-rules", { cidr: "10.9.0.1", action: "block", reason: "adv" });
    expect(add.status).toBeLessThan(300);
    try {
      for (const spelling of ["10.9.0.1", "::ffff:10.9.0.1", "::FFFF:10.9.0.1", "[::ffff:10.9.0.1]", "10.9.0.1:5555", "::ffff:a09:1", "0:0:0:0:0:ffff:a09:1", " 10.9.0.1 "]) {
        const r = await attempt(spelling);
        expect(r.closed).toBe(true);
        expect(r.notices.some((n) => n.startsWith("blocked:"))).toBe(true);
      }
      // a neighbour isn't caught
      expect((await attempt("10.9.0.2")).closed).toBe(false);
    } finally {
      await api(relay.http, relay.owner.sk, "DELETE", `/ip-rules/${encodeURIComponent("10.9.0.1")}`);
      await closeAll();
    }
  });

  test("IPv6 block vs upper-case, uncompressed and bracketed spellings", async () => {
    const add = await api(relay.http, relay.owner.sk, "POST", "/ip-rules", { cidr: "2001:db8:aa::1", action: "block", reason: "adv" });
    expect(add.status).toBeLessThan(300);
    try {
      for (const spelling of ["2001:db8:aa::1", "2001:DB8:AA::1", "2001:0db8:00aa:0000:0000:0000:0000:0001", "[2001:db8:aa::1]", "[2001:db8:aa::1]:443"]) {
        const r = await attempt(spelling);
        expect(r.closed).toBe(true);
        expect(r.notices.some((n) => n.startsWith("blocked:"))).toBe(true);
      }
      expect((await attempt("2001:db8:aa::2")).closed).toBe(false);
    } finally {
      await api(relay.http, relay.owner.sk, "DELETE", `/ip-rules/${encodeURIComponent("2001:db8:aa::1")}`);
      await closeAll();
    }
  });
});

describe("connectionsPerIp can't be multiplied", () => {
  test("respellings of one address share its connection slots", async () => {
    await patchSettings(relay, { limits: { connectionsPerIp: 2 } });
    try {
      expect((await attempt("10.8.0.1")).closed).toBe(false);
      expect((await attempt("::ffff:10.8.0.1")).closed).toBe(false);
      const third = await attempt("[::ffff:a08:1]:80");
      expect(third.closed).toBe(true);
      expect(third.notices.some((n) => n.startsWith("rate-limited:"))).toBe(true);
      await closeAll();
      expect((await attempt("2001:db8:bb::1")).closed).toBe(false);
      expect((await attempt("2001:DB8:BB:0:0:0:0:1")).closed).toBe(false);
      expect((await attempt("[2001:db8:bb::1]:1")).closed).toBe(true);
    } finally {
      await closeAll();
      await patchSettings(relay, { limits: { connectionsPerIp: 0 } });
    }
  });

  test("rotating addresses inside one IPv6 /64 is capped at 4× the per-address limit", async () => {
    await patchSettings(relay, { limits: { connectionsPerIp: 1 } });
    try {
      const results: boolean[] = [];
      for (let i = 1; i <= 7; i++) results.push((await attempt(`2001:db8:cc:1::${i.toString(16)}`)).closed);
      expect(results.filter((closed) => !closed).length).toBe(4);
      // another /64 has its own allowance
      expect((await attempt("2001:db8:cc:2::1")).closed).toBe(false);
    } finally {
      await closeAll();
      await patchSettings(relay, { limits: { connectionsPerIp: 0 } });
    }
  });
});

describe("junk forwarding values", () => {
  test("non-addresses fall back to the socket address (they don't mint a new identity)", async () => {
    const junk = ["unknown", "1.2.3.4.5", "999.1.1.1", "<script>alert(1)</script>", "x".repeat(5000), "::ffff:999.1.1.1", "10.0.0.1%eth0", "", " , , "];
    for (const j of junk) {
      const r = await attempt(j);
      expect(r.closed).toBe(false);
    }
    const conns = await api(relay.http, relay.owner.sk, "GET", "/connections");
    const ips = new Set((conns.body.items as { ip: string }[]).map((c) => c.ip));
    expect([...ips]).toEqual(["127.0.0.1"]);
    await closeAll();
  });
});
