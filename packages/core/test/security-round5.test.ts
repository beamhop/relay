import { describe, expect, test } from "bun:test";
import { keypair, now, setup, sign } from "./fakes";

describe("NIP-62 replays don't wipe gift wraps that arrived later", () => {
  test("a replayed request (not stored: muted author) leaves wraps received since alone", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const victim = keypair();
    await stores.users.upsert(victim.pk, { status: "muted" });
    const vanish = sign(victim, { kind: 62, tags: [["relay", "ALL_RELAYS"]], created_at: now() - 30 });
    expect((await c.publish(vanish))[2]).toBe(true);
    // muted: honoured but not kept, so the same signed request can be sent again
    expect(stores.events.events.has(vanish.id)).toBe(false);
    const later = sign(keypair(), { kind: 1059, tags: [["p", victim.pk]], created_at: now() - 5 });
    expect((await c.publish(later))[2]).toBe(true);
    const attacker = connect("203.0.113.9");
    expect((await attacker.publish(vanish))[2]).toBe(true);
    expect(stores.events.events.has(later.id)).toBe(true);
  });

  test("an unknown pubkey's request only removes wraps up to its created_at", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const victim = keypair();
    const before = sign(keypair(), { kind: 1059, tags: [["p", victim.pk]], created_at: now() - 100 });
    const after = sign(keypair(), { kind: 1059, tags: [["p", victim.pk]], created_at: now() - 5 });
    for (const e of [before, after]) await stores.events.save(e);
    expect((await c.publish(sign(victim, { kind: 62, tags: [["relay", "ALL_RELAYS"]], created_at: now() - 50 })))[2]).toBe(true);
    expect(stores.events.events.has(before.id)).toBe(false);
    expect(stores.events.events.has(after.id)).toBe(true);
  });

  test("a newer request from the same user still removes wraps up to it", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const victim = keypair();
    await stores.users.upsert(victim.pk, {});
    expect((await c.publish(sign(victim, { kind: 62, tags: [["relay", "ALL_RELAYS"]], created_at: now() - 60 })))[2]).toBe(true);
    const wrap = sign(keypair(), { kind: 1059, tags: [["p", victim.pk]], created_at: now() - 20 });
    await stores.events.save(wrap);
    expect((await c.publish(sign(victim, { kind: 62, tags: [["relay", "ALL_RELAYS"]], created_at: now() - 10 })))[2]).toBe(true);
    expect(stores.events.events.has(wrap.id)).toBe(false);
  });
});
