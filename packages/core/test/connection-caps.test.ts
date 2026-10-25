import { describe, expect, test } from "bun:test";
import { ipSiteKey } from "../src/util/cidr";
import { setup } from "./fakes";

const refused = (c: { socket: { closed: unknown; of(t: string): unknown[][] } }) => c.socket.closed !== null;

describe("relay-wide and IPv6 site connection caps", () => {
  test("maxConnections caps open connections relay-wide", async () => {
    const { connect, relay } = await setup({ settings: { limits: { maxConnections: 2 } } });
    const a = connect("1.1.1.1");
    connect("2.2.2.2");
    const c = connect("3.3.3.3");
    expect(refused(c)).toBe(true);
    expect(c.socket.of("NOTICE")[0]?.[1]).toMatch(/^rate-limited: relay has too many connections/);
    a.handle.onClose();
    expect(refused(connect("3.3.3.3"))).toBe(false);
    expect(relay.connections().length).toBe(2);
  });

  test("an IPv6 /48 is capped across its /64s", async () => {
    const { connect } = await setup({ settings: { limits: { connectionsPerIpv6Site: 3 } } });
    for (let i = 0; i < 3; i++) expect(refused(connect(`2001:db8:1:${i}::1`))).toBe(false);
    expect(refused(connect("2001:db8:1:ff::1"))).toBe(true);
    expect(refused(connect("2001:db8:2::1"))).toBe(false); // another site
  });

  test("by default a /48 holds 16 times connectionsPerIp; 0 lifts the cap", async () => {
    const def = await setup({ settings: { limits: { connectionsPerIp: 1 } } });
    for (let i = 0; i < 16; i++) expect(refused(def.connect(`2001:db8:1:${i}::1`))).toBe(false);
    expect(refused(def.connect("2001:db8:1:99::1"))).toBe(true);
    const off = await setup({ settings: { limits: { connectionsPerIp: 1, connectionsPerIpv6Site: 0 } } });
    for (let i = 0; i < 20; i++) expect(refused(off.connect(`2001:db8:1:${i}::1`))).toBe(false);
  });

  test("ipSiteKey aggregates IPv6 by /48 and ignores IPv4", () => {
    expect(ipSiteKey("2001:db8:1:2::1")).toBe(ipSiteKey("2001:db8:1:ffff::abcd"));
    expect(ipSiteKey("2001:db8:1::1")).not.toBe(ipSiteKey("2001:db8:2::1"));
    expect(ipSiteKey("1.2.3.4")).toBeUndefined();
    expect(ipSiteKey("::ffff:1.2.3.4")).toBeUndefined();
  });
});

describe("relay-wide filter weight", () => {
  test("subscriptions are refused while the fan-out index holds maxTotalFilterWeight values", async () => {
    const { connect } = await setup({ settings: { limits: { maxTotalFilterWeight: 10 } } });
    const authors = Array.from({ length: 5 }, (_, i) => String(i).padStart(64, "0"));
    const a = connect("1.1.1.1");
    const b = connect("2.2.2.2");
    expect((await a.req("s", { authors, limit: 0 })).end[0]).toBe("EOSE"); // weight 6
    expect((await b.req("s", { authors, limit: 0 })).end).toEqual(["CLOSED", "s", "rate-limited: relay holds too many subscriptions, try again later"]);
    a.send(["CLOSE", "s"]);
    expect((await b.req("s", { authors, limit: 0 })).end[0]).toBe("EOSE");
  });
});
