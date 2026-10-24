/**
 * IP rules and per-IP connection limits. The relay runs with server.trustProxy, so the test client (on 127.0.0.1,
 * a default trusted proxy) can present any client address via X-Forwarded-For; each test uses its own addresses.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { newUser } from "../harness/client";
import { api, connectAs, note, ownerApi, tryConnect, uniqueIp, waitClosed, withSettings } from "./policy-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
});
afterAll(() => relay?.stop());

const addRule = (cidr: string, action: "block" | "allow", extra: Record<string, unknown> = {}) =>
  ownerApi(relay, "POST", "/ip-rules", { cidr, action, reason: `e2e ${action}`, ...extra });
const removeRule = (cidr: string) => ownerApi(relay, "DELETE", `/ip-rules/${encodeURIComponent(cidr)}`);

async function connectionIps(): Promise<string[]> {
  return (await ownerApi(relay, "GET", "/connections")).items.map((c: any) => c.ip);
}

describe("client IP derivation", () => {
  test("with trustProxy the relay uses the X-Forwarded-For address", async () => {
    const ip = uniqueIp();
    const c = await connectAs(relay, ip);
    expect(await connectionIps()).toContain(ip);
    c.close();
  });

  test("only the rightmost X-Forwarded-For hop is believed", async () => {
    const spoofed = uniqueIp("172.16");
    const real = uniqueIp();
    const c = await connectAs(relay, `${spoofed}, ${real}`);
    const ips = await connectionIps();
    expect(ips).toContain(real);
    expect(ips).not.toContain(spoofed);
    c.close();
  });
});

describe("IP block rules", () => {
  test("blocking an address refuses new connections from it with a blocked: NOTICE; others still connect", async () => {
    const bad = uniqueIp();
    const good = uniqueIp();
    await addRule(bad, "block");
    try {
      const r = await tryConnect(relay, bad);
      expect(r.closed).toBe(true);
      expect(r.client.closeCode).toBe(1008);
      expect(r.notices.some((n) => n.startsWith("blocked:"))).toBe(true);
      const ok = await tryConnect(relay, good);
      expect(ok.closed).toBe(false);
      ok.client.close();
    } finally {
      await removeRule(bad);
    }
  });

  test("blocking an address disconnects its open connections", async () => {
    const ip = uniqueIp();
    const c = await connectAs(relay, ip);
    await addRule(ip, "block");
    try {
      await waitClosed(c);
      expect(c.inbox.some((m) => m[0] === "NOTICE" && String(m[1]).startsWith("blocked:"))).toBe(true);
    } finally {
      await removeRule(ip);
    }
  });

  test("blocking a CIDR closes open connections inside it and refuses new ones; addresses outside are unaffected", async () => {
    const cidr = `10.250.${Math.floor(Math.random() * 250)}.0/24`;
    const inside = cidr.replace(/0\/24$/, "7");
    const outside = uniqueIp();
    const open = await connectAs(relay, inside);
    const bystander = await connectAs(relay, outside);
    await addRule(cidr, "block");
    try {
      await waitClosed(open);
      expect((await tryConnect(relay, inside.replace(/\.7$/, ".8"))).closed).toBe(true);
      expect(bystander.closed).toBe(false);
      bystander.close();
    } finally {
      await removeRule(cidr);
    }
  });

  test("removing the block rule lets the address connect and publish again", async () => {
    const ip = uniqueIp();
    await addRule(ip, "block");
    expect((await tryConnect(relay, ip)).closed).toBe(true);
    await removeRule(ip);
    const c = await connectAs(relay, ip);
    expect((await c.publish(note(newUser().sk))).ok).toBe(true);
    c.close();
  });

  test("an allow rule overrides a block rule covering the same address", async () => {
    const cidr = `10.251.${Math.floor(Math.random() * 250)}.0/24`;
    const allowed = cidr.replace(/0\/24$/, "5");
    await addRule(cidr, "block");
    await addRule(allowed, "allow");
    try {
      expect((await tryConnect(relay, cidr.replace(/0\/24$/, "6"))).closed).toBe(true);
      const ok = await tryConnect(relay, allowed);
      expect(ok.closed).toBe(false);
      ok.client.close();
    } finally {
      await removeRule(allowed);
      await removeRule(cidr);
    }
  });

  test("IPv6 block rules match IPv6 clients", async () => {
    const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}`;
    await addRule(`${prefix}::/48`, "block");
    try {
      expect((await tryConnect(relay, `${prefix}::1`)).closed).toBe(true);
      const ok = await tryConnect(relay, `2001:db9::${Math.floor(Math.random() * 0xffff).toString(16)}`);
      expect(ok.closed).toBe(false);
      ok.client.close();
    } finally {
      await removeRule(`${prefix}::/48`);
    }
  });

  test("invalid CIDRs and unconfirmed broad allow rules are refused", async () => {
    const bad = await api(relay, relay.owner.sk, "POST", "/ip-rules", { cidr: "10.0.0.0/33", action: "block" });
    expect(bad.status).toBe(400);
    const broad = await api(relay, relay.owner.sk, "POST", "/ip-rules", { cidr: "10.0.0.0/8", action: "allow" });
    expect(broad.status).toBe(400);
    expect(broad.body.code).toBe("broad_allow_rule");
  });

  test("non-admins cannot manage IP rules", async () => {
    const r = await api(relay, newUser().sk, "POST", "/ip-rules", { cidr: uniqueIp(), action: "block" });
    expect([401, 403]).toContain(r.status);
  });
});

describe("connections per IP", () => {
  test("connectionsPerIp caps simultaneous connections from one address; closing one frees a slot", async () => {
    const ip = uniqueIp();
    await withSettings(relay, { limits: { connectionsPerIp: 2 } }, async () => {
      const a = await connectAs(relay, ip);
      const b = await connectAs(relay, ip);
      const third = await tryConnect(relay, ip);
      expect(third.closed).toBe(true);
      expect(third.notices).toContain("rate-limited: too many connections from your IP address");
      // another address is unaffected
      const other = await tryConnect(relay, uniqueIp());
      expect(other.closed).toBe(false);
      other.client.close();
      a.close();
      await Bun.sleep(100);
      const again = await tryConnect(relay, ip);
      expect(again.closed).toBe(false);
      again.client.close();
      b.close();
    });
  });

  test("allow-listed addresses are exempt from connectionsPerIp", async () => {
    const ip = uniqueIp();
    await addRule(ip, "allow");
    try {
      await withSettings(relay, { limits: { connectionsPerIp: 1 } }, async () => {
        const a = await connectAs(relay, ip);
        const b = await tryConnect(relay, ip);
        expect(b.closed).toBe(false);
        a.close();
        b.client.close();
      });
    } finally {
      await removeRule(ip);
    }
  });
});
