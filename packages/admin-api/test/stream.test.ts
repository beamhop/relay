import { describe, expect, test } from "bun:test";
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

  test("events=1 requires content.view; unauthenticated is 401", async () => {
    const h = await createHarness();
    expect((await h.req("/stream")).status).toBe(401);
  });
});
