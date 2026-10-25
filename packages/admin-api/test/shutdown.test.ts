import { describe, expect, test } from "bun:test";
import { stopContext } from "@beamhop/sdk";
import { createHarness } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function subscribeDevice(h: Harness) {
  const sub = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/dev0", keys: { p256dh: "k", auth: "a" } };
  expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: { subscription: sub, topics: ["alerts", "reports"] } })).status).toBe(200);
}

describe("admin API shutdown", () => {
  test("drain ends the open live streams and refuses new ones", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const res = await h.req("/stream", { headers: { cookie } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
    await h.api.drain!(stopContext("test", 1_000));
    // the stream finishes (the dashboard reconnects elsewhere or once the server is back)
    for (;;) {
      const r = await Promise.race([reader.read(), Bun.sleep(1_000).then(() => "timeout" as const)]);
      if (r === "timeout") throw new Error("stream still open after drain");
      if (r.done) break;
    }
    expect(h.metrics.listenerCount()).toBe(0);
    const again = await h.req("/stream", { headers: { cookie } });
    expect(again.status).toBe(503);
  });

  test("drain waits for a push being sent, drops the pending digest and stops listening", async () => {
    const sent: string[] = [];
    const h = await createHarness({
      apiOptions: { alertPushIntervalMs: 40 },
      pushSender: async (_sub, payload) => {
        await Bun.sleep(30);
        sent.push(JSON.parse(payload).title);
      },
    });
    await subscribeDevice(h);
    h.bus.emit("alert", { level: "warning", title: "Disk", message: "1" });
    h.bus.emit("alert", { level: "warning", title: "Disk", message: "2" }); // counted for the digest
    await h.api.drain!(stopContext("test", 1_000));
    expect(sent).toEqual(["Disk"]);
    h.bus.emit("alert", { level: "warning", title: "Other", message: "3" });
    await Bun.sleep(100);
    expect(sent).toEqual(["Disk"]);
  });

  test("a push still running at the deadline doesn't hold the drain", async () => {
    const h = await createHarness({ pushSender: () => new Promise(() => {}) });
    await subscribeDevice(h);
    h.bus.emit("alert", { level: "warning", title: "Disk", message: "1" });
    const t0 = Date.now();
    await h.api.drain!(stopContext("test", 30));
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
