import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { FakeSocket, keypair, now, setup, sign, tick } from "./fakes";

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
    // closed alone only gates joining: bob (no longer a member) may still post
    expect((await c.publish(sign(bob, { kind: 9, tags: h("pizza") })))[2]).toBe(true);
    // restricted: non-members cannot post, members can
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("pizza", [["name", "Pizza Club"], ["closed"], ["restricted"]]) })))[2]).toBe(true);
    expect((await c.publish(sign(bob, { kind: 9, content: "again", tags: h("pizza") })))[3]).toMatch(/^restricted:/);
    expect((await c.publish(sign(carol, { kind: 9, tags: h("pizza") })))[2]).toBe(true);

    // forged metadata rejected
    expect((await c.publish(sign(bob, { kind: 39000, tags: [["d", "pizza"]] })))[3]).toMatch(/^restricted:/);
    // unknown group / missing h
    expect((await c.publish(sign(bob, { kind: 9, tags: h("nope") })))[3]).toMatch(/^invalid: group not found/);
    expect((await c.publish(sign(bob, { kind: 9021 })))[3]).toMatch(/^invalid:/);
  });

  test("closed group invite codes and private group read gating", async () => {
    const { connect, relay, stores } = await setup();
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

    // closed group without code → rejected (MUST per NIP-29) but kept as a pending request for admins
    const pending = sign(bob, { kind: 9021, tags: h("secret") });
    expect(await c.publish(pending)).toEqual(["OK", pending.id, false, "restricted: join request pending admin approval"]);
    expect((await relay.groups.get("secret"))?.members).toBe(1);
    expect(stores.events.events.has(pending.id)).toBe(true);
    // a wrong code is treated the same
    expect((await c.publish(sign(bob, { kind: 9021, tags: h("secret", [["code", "nope"]]) })))[3]).toMatch(/pending admin approval/);
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

  test("previous tags must reference recent group events", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("tl") }));
    const first = sign(admin, { kind: 9, content: "one", tags: h("tl") });
    expect((await c.publish(first))[2]).toBe(true);
    expect((await c.publish(sign(admin, { kind: 9, content: "two", tags: h("tl", [["previous", first.id.slice(0, 8)]]) })))[2]).toBe(true);
    expect((await c.publish(sign(admin, { kind: 9, content: "bad", tags: h("tl", [["previous", "deadbeef"]]) })))[3]).toMatch(/^invalid:/);

    // references to recent events outside this group (still on this relay) are valid too
    const other = sign(admin, { kind: 1, content: "elsewhere" });
    await c.publish(other);
    expect((await c.publish(sign(admin, { kind: 9, content: "x", tags: h("tl", [["previous", other.id.slice(0, 8), first.id.slice(0, 8)]]) })))[2]).toBe(true);
    // ...and beyond the group's last 100 events
    for (let i = 0; i < 105; i++) await c.publish(sign(admin, { kind: 9, content: `n${i}`, tags: h("tl") }));
    expect((await c.publish(sign(admin, { kind: 9, content: "old ref", tags: h("tl", [["previous", first.id.slice(0, 8)]]) })))[2]).toBe(true);
  });

  test("late publication of group events is rejected", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    expect((await c.publish(sign(admin, { kind: 9007, tags: h("late"), created_at: now() - 2 * 3600 })))[3]).toMatch(/late publication/);
    await c.publish(sign(admin, { kind: 9007, tags: h("late") }));
    expect((await c.publish(sign(admin, { kind: 9, tags: h("late"), created_at: now() - 2 * 3600 })))[3]).toMatch(/^invalid: .*late publication/);
    expect((await c.publish(sign(admin, { kind: 9, tags: h("late"), created_at: now() - 60 })))[2]).toBe(true);
    // events outside managed groups are unaffected
    expect((await c.publish(sign(admin, { kind: 1, created_at: now() - 2 * 3600 })))[2]).toBe(true);
  });

  test("edit-metadata carries the full metadata set (standard tags only in 39000)", async () => {
    const { connect, relay, deps } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.auth(admin);
    await c.publish(sign(admin, { kind: 9007, tags: h("meta", [["name", "Meta"], ["private"], ["closed"]]) }));
    const meta = async () => (await c.req("m", { kinds: [39000], "#d": ["meta"] })).events[0]!;
    let ev = await meta();
    expect(ev.tags).toEqual([["d", "meta"], ["name", "Meta"], ["private"], ["closed"]]);

    const full = [["name", "Meta 2"], ["about", "hi"], ["picture", "https://x/p.png"], ["banner", "https://x/b.png"], ["restricted"], ["hidden"], ["supported_kinds", "9", "11"]];
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("meta", full) })))[2]).toBe(true);
    ev = await meta();
    // absent private/closed → off; standard tags only
    expect(ev.tags).toEqual([["d", "meta"], ...full]);
    expect(await relay.groups.get("meta")).toMatchObject({ name: "Meta 2", about: "hi", private: false, closed: false });

    // supported_kinds is enforced for content; restricted blocks non-members
    expect((await c.publish(sign(admin, { kind: 1, tags: h("meta") })))[3]).toMatch(/^restricted: kind 1/);
    expect((await c.publish(sign(admin, { kind: 9, tags: h("meta") })))[2]).toBe(true);
    // the group is also hidden: a non-member is told it doesn't exist rather than that they aren't a member
    expect((await c.publish(sign(bob, { kind: 9, tags: h("meta") })))[3]).toBe("invalid: group not found");

    // legacy tags still accepted (they mean "off"); absent fields are cleared; public/open never emitted
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("meta", [["name", "Meta 3"], ["public"], ["open"], ["visible"], ["unrestricted"]]) })))[2]).toBe(true);
    ev = await meta();
    expect(ev.tags).toEqual([["d", "meta"], ["name", "Meta 3"]]);
    expect((await c.publish(sign(bob, { kind: 1, tags: h("meta") })))[2]).toBe(true);
    // omitted name falls back to the group id
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("meta") })))[2]).toBe(true);
    expect((await meta()).tags).toEqual([["d", "meta"], ["name", "meta"]]);

    // subgroups are rejected rather than silently ignored
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("meta", [["name", "M"], ["parent", "other"]]) })))[3]).toBe("invalid: subgroups are not supported");
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("meta", [["name", "M"], ["child", "kid"]]) })))[3]).toBe("invalid: subgroups are not supported");
    expect((await c.publish(sign(admin, { kind: 9007, tags: h("sub", [["parent", "meta"]]) })))[3]).toBe("invalid: subgroups are not supported");

    // banner / empty supported_kinds persist and survive a restart
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("meta", [["name", "M"], ["banner", "b"], ["supported_kinds"]]) })))[2]).toBe(true);
    expect((await meta()).tags).toEqual([["d", "meta"], ["name", "M"], ["banner", "b"], ["supported_kinds"]]);
    expect((await c.publish(sign(admin, { kind: 9, content: "empty kinds", tags: h("meta") })))[3]).toMatch(/^restricted: kind 9/);
    const { createRelay } = await import("../src");
    await createRelay(deps);
    const row = await deps.stores.db.get<{ banner: string; supported_kinds: string }>("SELECT banner, supported_kinds FROM core_groups WHERE id = ?", ["meta"]);
    expect(row).toMatchObject({ banner: "b", supported_kinds: "[]" });
  });

  test("group creation policy", async () => {
    const { connect } = await setup({ settings: { groups: { creation: "admins" } } });
    const c = connect();
    expect((await c.publish(sign(keypair(), { kind: 9007, tags: h("nope") })))[3]).toMatch(/^restricted:/);
  });

  test("state survives relay restart (persisted tables)", async () => {
    const { connect, deps, stores } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("persist", [["name", "P"]]) }));
    const { createRelay } = await import("../src");
    const relay2 = await createRelay(deps);
    expect((await relay2.groups.get("persist"))?.name).toBe("P");

    // metadata regenerated after a restart is strictly newer than what was stored (no created_at ties)
    const before = [...stores.events.events.values()].find((e) => e.kind === 39002)!;
    const carol = keypair();
    const socket = new FakeSocket();
    const handle = relay2.handleConnection(socket, { ip: "1.2.3.5" });
    const put = sign(admin, { kind: 9000, tags: h("persist", [["p", carol.pk]]) });
    handle.onMessage(JSON.stringify(["EVENT", put]));
    expect(((await socket.waitFor((m) => m[0] === "OK" && m[1] === put.id)) as unknown[])[2]).toBe(true);
    const after = [...stores.events.events.values()].filter((e) => e.kind === 39002);
    expect(after.length).toBe(1);
    expect(after[0]!.created_at).toBeGreaterThan(before.created_at);
    expect(after[0]!.tags).toContainEqual(["p", carol.pk]);
  });
});
