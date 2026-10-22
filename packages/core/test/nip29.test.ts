import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { keypair, setup, sign, tick } from "./fakes";

const h = (id: string, extra: string[][] = []) => [["h", id], ...extra];

describe("NIP-29 relay-based groups", () => {
  test("create, join (open), post, moderation and metadata", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    const carol = keypair();
    expect((await c.publish(sign(admin, { kind: 9007, tags: h("pizza", [["name", "Pizza"]]) })))[2]).toBe(true);
    expect((await c.publish(sign(bob, { kind: 9007, tags: h("pizza") })))[3]).toMatch(/^duplicate:/);

    const { events: meta } = await c.req("m", { kinds: [39000, 39001, 39002], "#d": ["pizza"] });
    expect(meta.every((e) => e.pubkey === relay.pubkey)).toBe(true);
    expect(meta.find((e) => e.kind === 39000)?.tags).toContainEqual(["name", "Pizza"]);
    expect(meta.find((e) => e.kind === 39001)?.tags.some((t) => t[0] === "p" && t[1] === admin.pk)).toBe(true);

    // open group: anyone may post & join
    expect((await c.publish(sign(bob, { kind: 9021, tags: h("pizza") })))[2]).toBe(true);
    let g = await relay.groups.get("pizza");
    expect(g?.memberList.map((m) => m.pubkey).sort()).toEqual([admin.pk, bob.pk].sort());
    expect((await c.publish(sign(bob, { kind: 9, content: "hi", tags: h("pizza") })))[2]).toBe(true);

    // non-admins cannot moderate
    expect((await c.publish(sign(bob, { kind: 9001, tags: h("pizza", [["p", admin.pk]]) })))[3]).toMatch(/^restricted:/);
    // admin adds carol, removes bob
    expect((await c.publish(sign(admin, { kind: 9000, tags: h("pizza", [["p", carol.pk]]) })))[2]).toBe(true);
    expect((await c.publish(sign(admin, { kind: 9001, tags: h("pizza", [["p", bob.pk]]) })))[2]).toBe(true);
    g = await relay.groups.get("pizza");
    expect(g?.memberList.map((m) => m.pubkey).sort()).toEqual([admin.pk, carol.pk].sort());

    // edit metadata → regenerated 39000
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("pizza", [["name", "Pizza Club"], ["closed"]]) })))[2]).toBe(true);
    const sum = (await relay.groups.list()).find((x) => x.id === "pizza");
    expect(sum).toMatchObject({ name: "Pizza Club", closed: true, members: 2 });
    // closed: bob (no longer member) cannot post
    expect((await c.publish(sign(bob, { kind: 9, tags: h("pizza") })))[3]).toMatch(/^restricted:/);

    // forged metadata rejected
    expect((await c.publish(sign(bob, { kind: 39000, tags: [["d", "pizza"]] })))[3]).toMatch(/^restricted:/);
    // unknown group / missing h
    expect((await c.publish(sign(bob, { kind: 9, tags: h("nope") })))[3]).toMatch(/^invalid: group not found/);
    expect((await c.publish(sign(bob, { kind: 9021 })))[3]).toMatch(/^invalid:/);
  });

  test("closed group invite codes and private group read gating", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("secret", [["private"], ["closed"]]) }));
    expect((await c.publish(sign(admin, { kind: 9009, tags: h("secret", [["code", "letmein"]]) })))[2]).toBe(true);
    const post = sign(admin, { kind: 9, content: "classified", tags: h("secret") });
    await c.publish(post);

    // anonymous reader cannot see private content
    const anon = connect();
    expect((await anon.req("x", { kinds: [9], "#h": ["secret"] })).events.length).toBe(0);

    // closed group without code → pending (stored request, not a member)
    await c.publish(sign(bob, { kind: 9021, tags: h("secret") }));
    expect((await relay.groups.get("secret"))?.members).toBe(1);
    // with code → member
    expect((await c.publish(sign(bob, { kind: 9021, tags: h("secret", [["code", "letmein"]]) })))[2]).toBe(true);
    expect((await relay.groups.get("secret"))?.members).toBe(2);

    const bobConn = connect();
    await bobConn.auth(bob);
    expect((await bobConn.req("x", { kinds: [9], "#h": ["secret"] })).events.map((e) => e.id)).toEqual([post.id]);
    const live = sign(admin, { kind: 9, content: "more", tags: h("secret") });
    await c.publish(live);
    await bobConn.socket.waitFor((m) => m[0] === "EVENT" && (m[2] as NostrEvent).id === live.id);
    await tick();
    expect(anon.socket.of("EVENT").length).toBe(0);
  });

  test("leave, delete-event and delete group", async () => {
    const { connect, relay, stores } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g1") }));
    await c.publish(sign(bob, { kind: 9021, tags: h("g1") }));
    const msg = sign(bob, { kind: 9, tags: h("g1") });
    await c.publish(msg);
    expect((await c.publish(sign(admin, { kind: 9005, tags: h("g1", [["e", msg.id]]) })))[2]).toBe(true);
    expect(stores.events.events.has(msg.id)).toBe(false);
    expect((await c.publish(sign(bob, { kind: 9022, tags: h("g1") })))[2]).toBe(true);
    expect((await relay.groups.get("g1"))?.members).toBe(1);
    await relay.groups.delete("g1", admin.pk);
    expect(await relay.groups.get("g1")).toBeUndefined();
  });

  test("group creation policy", async () => {
    const { connect } = await setup({ settings: { groups: { creation: "admins" } } });
    const c = connect();
    expect((await c.publish(sign(keypair(), { kind: 9007, tags: h("nope") })))[3]).toMatch(/^restricted:/);
  });

  test("state survives relay restart (persisted tables)", async () => {
    const { connect, deps } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("persist", [["name", "P"]]) }));
    const { createRelay } = await import("../src");
    const relay2 = await createRelay(deps);
    expect((await relay2.groups.get("persist"))?.name).toBe("P");
  });
});
