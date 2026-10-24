import { describe, expect, test } from "bun:test";
import { renderPrometheus } from "../src";
import { ev, setup } from "./fakes";

describe("metrics regressions", () => {
  test("rejections that may precede signature checks are not credited to the claimed pubkey", async () => {
    const { metrics, bus, clock } = await setup();
    const victim = "c".repeat(64);
    const spammer = "d".repeat(64);
    // forged events (bad id/sig) and oversized ones carry an unauthenticated pubkey
    bus.emit("event.rejected", { code: "invalid", reason: "invalid: bad event id or signature", pubkey: victim, event: ev(1, victim), source: "ws" });
    bus.emit("event.rejected", { code: "too-large", reason: "invalid: event is too large", pubkey: victim, source: "ws" });
    bus.emit("event.rejected", { code: "error", reason: "error: internal error", pubkey: victim, source: "ws" });
    // a policy rejection happens after verification
    bus.emit("event.rejected", { code: "rate-limited", reason: "rate-limited: slow down", pubkey: spammer, source: "ws" });
    const top = await metrics.topPubkeys({ from: clock.sec - 60, to: clock.sec }, 10);
    expect(top).toEqual([{ pubkey: spammer, events: 0, rejected: 1 }]);
  });

  test("the per-hour pubkey cap holds across mid-hour flushes", async () => {
    const { metrics, bus, clock, db } = await setup({ options: { maxPubkeysPerBucket: 5 } });
    const pk = (i: number) => String(i).padStart(64, "0");
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 5; i++) bus.emit("event.accepted", { event: ev(1, pk(round * 5 + i)), status: "saved", source: "ws" });
      await metrics.flush(); // e.g. triggered by an admin opening /metrics/top-pubkeys
    }
    // pubkeys admitted earlier in the hour keep counting after a flush
    bus.emit("event.accepted", { event: ev(1, pk(0)), status: "saved", source: "ws" });
    await metrics.flush();
    const rows = await db.all<{ pubkey: string; events: number }>("SELECT pubkey, events FROM metrics_pubkeys");
    expect(rows).toHaveLength(5);
    const top = await metrics.topPubkeys({ from: clock.sec - 60, to: clock.sec }, 100);
    expect(top.find((t) => t.pubkey === pk(0))?.events).toBe(2);
  });

  test("plugin metrics can't duplicate a built-in series name", async () => {
    const { metrics, bus, run } = await setup();
    bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
    metrics.counter("beamhop_events_in", "shadow").add(100);
    metrics.counter("beamhop_events_in_total", "shadow 2").add(100);
    metrics.gauge("beamhop_connections").set(99);
    run(1);
    const text = renderPrometheus(metrics);
    expect(text.match(/# TYPE beamhop_events_in_total /g)).toHaveLength(1);
    expect(text.match(/# TYPE beamhop_connections /g)).toHaveLength(1);
    expect(text).toContain("beamhop_events_in_total 1\n");
    expect(text).not.toContain("beamhop_connections 99");
  });

  test("blobs served are rolled up as a series", async () => {
    const { metrics, bus, clock, run } = await setup();
    const from = clock.sec;
    run(1, () => bus.emit("blob.served", { sha256: "x", size: 10, ip: "1.1.1.1" }));
    run(1, () => bus.emit("blob.served", { sha256: "y", size: 5, ip: "1.1.1.1" }));
    const points = await metrics.series("blobs_served", { from, to: clock.sec + 60 });
    expect(points.reduce((a, p) => a + p.v, 0)).toBe(2);
  });
});
