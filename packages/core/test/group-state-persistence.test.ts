import { describe, expect, test } from "bun:test";
import { GroupsService } from "../src/nips/nip29/groups";
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
});
