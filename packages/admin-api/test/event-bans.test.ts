import { describe, expect, test } from "bun:test";
import { stopContext, type EventBanListResponse, type NostrEvent } from "@beamhop/sdk";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const rpc = (h: Harness, k: Key, method: string, params: unknown[]) => {
  const text = JSON.stringify({ method, params });
  return h.api.nip86(
    new Request(`${PUBLIC_URL}/`, { method: "POST", body: text, headers: { "content-type": "application/nostr+json+rpc", authorization: nip98Header(k, PUBLIC_URL, "POST", text) } }),
  );
};
const write = (h: Harness, ev: NostrEvent) => h.deps.hooks.runWrite(ev, { source: "ws" } as never);

describe("event bans (BannedEventService, GET/DELETE /events/bans)", () => {
  test("a NIP-86 ban is listed over REST with who placed it, and lifting it there lets the event be written again", async () => {
    const h = await createHarness();
    const ev = signEvent(newKey(), 1, [], "spam");
    expect(await (await rpc(h, h.owner, "banevent", [ev.id, "spam"])).json()).toEqual({ result: true });
    expect((await write(h, ev)).result).toBe("reject");

    const list = (await (await h.asKey(h.owner, "/events/bans")).json()) as EventBanListResponse;
    expect(list.items).toEqual([{ id: ev.id, reason: "spam", by: h.owner.pk, at: expect.any(Number), byRole: "owner" }]);

    const lifted = await h.asKey(h.owner, `/events/bans/${ev.id}`, { method: "DELETE", body: { reason: "fine after all" } });
    expect([lifted.status, await lifted.json()]).toEqual([200, { ok: true }]);
    expect((await write(h, ev)).result).toBe("next");
    expect(((await (await h.asKey(h.owner, "/events/bans")).json()) as EventBanListResponse).items).toEqual([]);
    expect(h.audit.entries.find((e) => e.action === "event.unban" && e.target === ev.id)).toMatchObject({ actor: h.owner.pk, details: { reason: "fine after all" } });
    // nothing left to lift
    expect((await h.asKey(h.owner, `/events/bans/${ev.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("lifting needs content.delete and at least the rank that placed the ban (same rule as NIP-86 unbanevent)", async () => {
    const h = await createHarness();
    const id = "a".repeat(64);
    await rpc(h, h.owner, "banevent", [id, "owner's call"]);
    const moderator = await h.addAdmin("moderator");
    const viewer = await h.addAdmin("viewer");
    expect((await h.asKey(viewer, "/events/bans")).status).toBe(200);
    expect((await h.asKey(viewer, `/events/bans/${id}`, { method: "DELETE" })).status).toBe(403);
    const refused = await h.asKey(moderator, `/events/bans/${id}`, { method: "DELETE" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("forbidden_target");
    expect(await (await rpc(h, moderator, "unbanevent", [id])).json()).toMatchObject({ result: null, error: expect.stringContaining("role owner") });
    expect(((await (await h.asKey(h.owner, "/events/bans")).json()) as EventBanListResponse).items.map((b) => b.id)).toEqual([id]);
    expect((await h.asKey(h.owner, "/events/bans/not-an-id", { method: "DELETE" })).status).toBe(400);
  });

  test("the write hook is registered by createAdminApi and removed when the admin API stops (not when it drains)", async () => {
    const h = await createHarness();
    const ev = signEvent(newKey(), 1, [], "x");
    await rpc(h, h.owner, "banevent", [ev.id, ""]);
    await h.api.drain!(stopContext("test", 1_000));
    expect((await write(h, ev)).result).toBe("reject");
    await h.api.stop!(stopContext("test", 1_000));
    expect((await write(h, ev)).result).toBe("next");
  });
});
