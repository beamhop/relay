import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { GroupsService } from "../src/nips/nip29/groups";
import { GroupRepo } from "../src/nips/nip29/repo";
import { keypair, setup, sign, tick } from "./fakes";

const h = (id: string, extra: string[][] = []) => [["h", id], ...extra];

/** Patches a prototype method for the duration of `fn`. */
async function patched<T extends object>(proto: T, name: string, impl: unknown, fn: () => Promise<void>) {
  const p = proto as Record<string, unknown>;
  const orig = p[name];
  p[name] = impl;
  try {
    await fn();
  } finally {
    p[name] = orig;
  }
}

describe("NIP-29 group state persistence", () => {
  test("a failing derived-event step after commit still relays the event and answers OK", async () => {
    const { connect, relay, stores } = await setup();
    const c = connect();
    const reader = connect("5.6.7.8");
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g2") }));
    await reader.req("live", { kinds: [9000] });
    const ev = sign(admin, { kind: 9000, tags: h("g2", [["p", bob.pk]]) });
    let ok: unknown[] = [];
    await patched(GroupsService.prototype, "publishMetadata", async () => {
      throw new Error("sign/save failed");
    }, async () => {
      ok = await c.publish(ev);
    });
    await tick(20);
    expect(ok[2]).toBe(true);
    expect(await stores.events.getById(ev.id)).toBeDefined();
    expect((await relay.groups.get("g2"))?.memberList.some((m) => m.pubkey === bob.pk)).toBe(true);
    expect(reader.socket.of("EVENT").some((m) => (m[2] as { id: string }).id === ev.id)).toBe(true);
  });

  const fail = async () => {
    throw new Error("disk full");
  };
  const members = async (relay: Awaited<ReturnType<typeof setup>>["relay"], id: string) =>
    ((await relay.groups.get(id))?.memberList ?? []).map((m) => m.pubkey).sort();

  test("a put-user whose write fails leaves no member in memory", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    expect((await c.publish(sign(admin, { kind: 9007, tags: h("g1", [["closed"], ["restricted"]]) })))[2]).toBe(true);
    await patched(GroupRepo.prototype, "putMember", fail, async () => {
      expect((await c.publish(sign(admin, { kind: 9000, tags: h("g1", [["p", bob.pk]]) })))[2]).toBe(false);
    });
    expect(await members(relay, "g1")).toEqual([admin.pk]);
    // so bob still can't post into the restricted group
    expect((await c.publish(sign(bob, { kind: 9, tags: h("g1") })))[3]).toMatch(/^restricted:/);
  });

  test("a put-user of several pubkeys is written all or nothing", async () => {
    const { connect, relay, stores } = await setup();
    const c = connect();
    const admin = keypair();
    const [bob, carol] = [keypair(), keypair()];
    await c.publish(sign(admin, { kind: 9007, tags: h("g1") }));
    const orig = GroupRepo.prototype.putMember;
    let calls = 0;
    await patched(GroupRepo.prototype, "putMember", function (this: GroupRepo, ...args: Parameters<GroupRepo["putMember"]>) {
      if (++calls === 2) throw new Error("disk full");
      return orig.apply(this, args);
    }, async () => {
      expect((await c.publish(sign(admin, { kind: 9000, tags: h("g1", [["p", bob.pk], ["p", carol.pk]]) })))[2]).toBe(false);
    });
    expect(await members(relay, "g1")).toEqual([admin.pk]);
    const stored = (await new GroupRepo(stores.db).loadAll()).find((g) => g.id === "g1");
    expect([...stored!.members.keys()]).toEqual([admin.pk]);
    // the failed event was removed again, so a retry applies it
    expect((await c.publish(sign(admin, { kind: 9000, tags: h("g1", [["p", bob.pk], ["p", carol.pk]]) })))[2]).toBe(true);
    expect(await members(relay, "g1")).toEqual([admin.pk, bob.pk, carol.pk].sort());
  });

  test("remove-user and leave whose write fails keep the member", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g1") }));
    await c.publish(sign(admin, { kind: 9000, tags: h("g1", [["p", bob.pk]]) }));
    await patched(GroupRepo.prototype, "removeMember", fail, async () => {
      expect((await c.publish(sign(admin, { kind: 9001, tags: h("g1", [["p", bob.pk]]) })))[2]).toBe(false);
      expect((await c.publish(sign(bob, { kind: 9022, tags: h("g1") })))[2]).toBe(false);
    });
    expect(await members(relay, "g1")).toEqual([admin.pk, bob.pk].sort());
  });

  test("edit-metadata whose write fails leaves the group's metadata and flags unchanged", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g1", [["name", "Old"]]) }));
    await patched(GroupRepo.prototype, "saveGroup", fail, async () => {
      expect((await c.publish(sign(admin, { kind: 9002, tags: h("g1", [["name", "New"], ["private"]]) })))[2]).toBe(false);
    });
    expect(await relay.groups.get("g1")).toMatchObject({ name: "Old", private: false });
    // content stays readable to everyone
    const post = sign(admin, { kind: 9, tags: h("g1") });
    await c.publish(post);
    expect((await connect("9.9.9.9").req("r", { kinds: [9] })).events.map((e) => e.id)).toEqual([post.id]);
  });

  test("create-invite whose write fails doesn't make the code usable", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g1", [["closed"]]) }));
    await patched(GroupRepo.prototype, "addInvite", fail, async () => {
      expect((await c.publish(sign(admin, { kind: 9009, tags: h("g1", [["code", "letmein"]]) })))[2]).toBe(false);
    });
    expect((await c.publish(sign(bob, { kind: 9021, tags: h("g1", [["code", "letmein"]]) })))[3]).toMatch(/pending admin approval/);
    expect(await members(relay, "g1")).toEqual([admin.pk]);
  });

  test("a closed group's join request goes through the write pipeline: stored, relayed, refused", async () => {
    const { connect, stores, bus } = await setup();
    const c = connect();
    const watcher = connect("5.6.7.8");
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g1", [["closed"]]) }));
    await watcher.req("live", { kinds: [9021] });
    const rejected: string[] = [];
    const accepted: string[] = [];
    bus.on("event.rejected", (e) => void rejected.push(e.event?.id ?? ""));
    bus.on("event.accepted", (e) => void accepted.push(e.event.id));
    const join = sign(bob, { kind: 9021, tags: h("g1") });
    expect(await c.publish(join)).toEqual(["OK", join.id, false, "restricted: join request pending admin approval"]);
    expect(await stores.events.getById(join.id)).toBeDefined();
    await watcher.socket.waitFor((m) => m[0] === "EVENT" && m[1] === "live" && (m[2] as NostrEvent).id === join.id);
    expect(rejected).toContain(join.id);
    expect(accepted).not.toContain(join.id);
  });

  test("visibility caches are kept across membership changes of public groups", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("open1") }));
    await c.publish(sign(admin, { kind: 9007, tags: h("priv1", [["private"]]) }));
    let computed = 0;
    const orig = (GroupsService.prototype as unknown as { computeUnreadable: (...a: unknown[]) => unknown }).computeUnreadable;
    await patched(GroupsService.prototype, "computeUnreadable", function (this: GroupsService, ...args: unknown[]) {
      computed++;
      return orig.apply(this, args);
    }, async () => {
      await c.req("a", { kinds: [9] });
      expect(computed).toBe(1);
      await c.publish(sign(keypair(), { kind: 9021, tags: h("open1") })); // public group: nothing to recompute
      await c.req("b", { kinds: [9] });
      expect(computed).toBe(1);
      await c.publish(sign(admin, { kind: 9000, tags: h("priv1", [["p", keypair().pk]]) })); // a private group's members
      await c.req("c", { kinds: [9] });
      expect(computed).toBe(2);
    });
  });
});
