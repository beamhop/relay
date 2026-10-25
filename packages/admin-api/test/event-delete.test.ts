import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { createHarness, newKey, signEvent } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const announced = (h: Harness) => {
  const ids: string[] = [];
  h.bus.on("event.deleted", (e) => void ids.push(...e.ids));
  return ids;
};

describe("POST /events/delete reports exactly what it deleted", () => {
  test("a filter without limit deletes and announces every match, page by page", async () => {
    const h = await createHarness();
    const author = newKey();
    const now = Math.floor(Date.now() / 1000);
    const evs: NostrEvent[] = [];
    for (let i = 0; i < 2500; i++) evs.push(signEvent(author, 1, [], `n${i}`, now - (i % 7)));
    for (const e of evs) await h.events.save(e);
    const other = signEvent(newKey(), 1, [], "stays");
    await h.events.save(other);
    const ids = announced(h);
    const res = await h.asKey(h.owner, "/events/delete", { method: "POST", body: { filters: [{ authors: [author.pk] }] } });
    expect(await res.json()).toEqual({ deleted: 2500 });
    expect(new Set(ids)).toEqual(new Set(evs.map((e) => e.id)));
    expect(ids).toHaveLength(2500);
    expect([...h.events.events.keys()]).toEqual([other.id]);
    expect(h.audit.entries.find((e) => e.action === "event.delete")?.details).toMatchObject({ deleted: 2500, matchedIdsCount: 2500 });
  });

  test("a filter's limit deletes that many, newest first", async () => {
    const h = await createHarness();
    const author = newKey();
    const now = Math.floor(Date.now() / 1000);
    const evs = [0, 1, 2, 3, 4].map((i) => signEvent(author, 1, [], `n${i}`, now - i));
    for (const e of evs) await h.events.save(e);
    const ids = announced(h);
    expect(await (await h.asKey(h.owner, "/events/delete", { method: "POST", body: { filters: [{ authors: [author.pk], limit: 2 }] } })).json()).toEqual({ deleted: 2 });
    expect(ids).toEqual([evs[0].id, evs[1].id]);
    expect(h.events.events.size).toBe(3);
  });

  test("ids that aren't stored are neither deleted nor announced", async () => {
    const h = await createHarness();
    const ev = signEvent(newKey(), 1, [], "x");
    await h.events.save(ev);
    const ids = announced(h);
    const missing = "a".repeat(64);
    expect(await (await h.asKey(h.owner, "/events/delete", { method: "POST", body: { ids: [ev.id, missing] } })).json()).toEqual({ deleted: 1 });
    expect(ids).toEqual([ev.id]);
  });

  test("a delete failing halfway is audited with what it deleted and the error", async () => {
    const h = await createHarness();
    const author = newKey();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 1500; i++) await h.events.save(signEvent(author, 1, [], `n${i}`, now - i));
    const deleteByIds = h.events.deleteByIds.bind(h.events);
    let calls = 0;
    h.events.deleteByIds = async (ids: string[]) => {
      if (++calls === 2) throw new Error("disk I/O error");
      return deleteByIds(ids);
    };
    const res = await h.asKey(h.owner, "/events/delete", { method: "POST", body: { filters: [{ authors: [author.pk] }] } });
    expect(res.status).toBe(500);
    expect(h.audit.entries.find((e) => e.action === "event.delete")?.details).toMatchObject({ deleted: 1000, matchedIdsCount: 1000, error: "disk I/O error" });
  });
});
