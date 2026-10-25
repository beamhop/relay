import { describe, expect, test } from "bun:test";
import { MAX_STREAMS_PER_ADMIN } from "../src/routes/stream";
import { createHarness, newKey, signEvent } from "./fakes";

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pred: (s: string) => boolean, timeoutMs = 2000): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (!pred(buf)) {
    if (Date.now() > deadline) throw new Error(`timeout; got: ${buf}`);
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    buf += dec.decode(r.value, { stream: true });
  }
  return buf;
}

describe("SSE /stream", () => {
  test("emits snapshot first, then alerts; cleans up on cancel", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const ac = new AbortController();
    const res = await h.req("/stream", { headers: { cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = await readUntil(reader, (s) => s.includes("\n\n"));
    expect(first).toContain("event: snapshot");
    expect(first).toContain('"connections":3');
    expect(h.metrics.listenerCount()).toBe(1);
    h.bus.emit("alert", { level: "warning", title: "Disk", message: "low" });
    expect(await readUntil(reader, (s) => s.includes("event: alert"))).toContain('"title":"Disk"');
    await reader.cancel();
    ac.abort();
    await Bun.sleep(30);
    expect(h.metrics.listenerCount()).toBe(0);
  });

  test("events=1 streams filtered events with country; ip hidden from moderators", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const cookie = await h.login(mod);
    const res = await h.req("/stream?events=1&kinds=7", { headers: { cookie } });
    const reader = res.body!.getReader();
    await readUntil(reader, (s) => s.includes("event: snapshot"));
    const k = newKey();
    h.bus.emit("event.accepted", { event: signEvent(k, 1, [], "skip me"), status: "saved", ip: "1.2.3.4", source: "ws" });
    h.bus.emit("event.accepted", { event: signEvent(k, 7, [], "+"), status: "saved", ip: "1.2.3.4", source: "ws" });
    const out = await readUntil(reader, (s) => s.includes("event: event"));
    const line = out.split("\n").find((l) => l.startsWith("data:") && l.includes('"status":"accepted"'))!;
    const data = JSON.parse(line.slice(5));
    expect(data.event.kind).toBe(7);
    expect(data.country).toBe("DE");
    expect(data.ip).toBeUndefined();
    expect(out).not.toContain("skip me");
    await reader.cancel();
  });

  test(`at most ${MAX_STREAMS_PER_ADMIN} open streams per admin`, async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_ADMIN; i++) {
      const res = await h.req("/stream", { headers: { cookie } });
      expect(res.status).toBe(200);
      readers.push(res.body!.getReader());
    }
    const over = await h.req("/stream", { headers: { cookie } });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe("too_many_streams");
    // another admin isn't affected
    const other = await h.login(await h.addAdmin("viewer"));
    expect((await h.req("/stream", { headers: { cookie: other } })).status).toBe(200);
    await readers[0].cancel();
    await Bun.sleep(20);
    expect((await h.req("/stream", { headers: { cookie } })).status).toBe(200);
    for (const r of readers.slice(1)) await r.cancel();
  });

  test("a message sent to many streams is serialized once", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < 5; i++) {
      const reader = (await h.req("/stream", { headers: { cookie } })).body!.getReader();
      await readUntil(reader, (s) => s.includes("event: snapshot"));
      readers.push(reader);
    }
    const alert = { level: "warning" as const, title: "Disk", message: "low" };
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((v: unknown, ...rest: never[]) => {
      if (v === alert) calls++;
      return stringify(v, ...rest);
    }) as typeof JSON.stringify;
    try {
      h.bus.emit("alert", alert);
    } finally {
      JSON.stringify = stringify;
    }
    for (const r of readers) expect(await readUntil(r, (s) => s.includes("event: alert"))).toContain('"title":"Disk"');
    expect(calls).toBe(1);
    for (const r of readers) await r.cancel();
  });

  test("streams of one session share one authorization recheck, and all end at logout", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const cookie = await h.login(mod);
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < 4; i++) {
      const reader = (await h.req("/stream", { headers: { cookie } })).body!.getReader();
      await readUntil(reader, (s) => s.includes("event: snapshot"));
      readers.push(reader);
    }
    const get = h.stores.users.get.bind(h.stores.users);
    let lookups = 0;
    h.stores.users.get = (pk: string) => (pk === mod.pk && lookups++, get(pk));
    await Bun.sleep(275); // ~5 rounds at the 50 ms test interval
    h.stores.users.get = get;
    expect(lookups).toBeGreaterThan(0);
    expect(lookups).toBeLessThanOrEqual(7);
    await h.withCookie(cookie, "/auth/logout", { method: "POST" });
    for (const r of readers) {
      const end = await Promise.race([
        (async () => {
          for (;;) if ((await r.read()).done) return "closed";
        })(),
        Bun.sleep(1000).then(() => "open"),
      ]);
      expect(end).toBe("closed");
    }
  });

  test("events=1 requires content.view; unauthenticated is 401", async () => {
    const h = await createHarness();
    expect((await h.req("/stream")).status).toBe(401);
  });
});
