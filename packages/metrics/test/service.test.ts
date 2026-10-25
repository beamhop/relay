import { describe, expect, test } from "bun:test";
import { renderPrometheus } from "../src";
import { ev, fakeBlossom, fakeGeo, fakeRelay, setup } from "./fakes";

describe("live snapshot", () => {
  test("rates, connections, process stats and latency percentiles", async () => {
    const relay = fakeRelay([{ subscriptions: 3, authedPubkeys: ["p"] }, { subscriptions: 2 }]);
    const { metrics, bus, proc, run } = await setup({ relay, blossom: fakeBlossom(7, 700) });
    await metrics.refreshStats();
    const seen: number[] = [];
    metrics.onSnapshot((s) => seen.push(s.at));
    run(10, () => {
      for (let i = 0; i < 4; i++) bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
      bus.emit("message.out", { connId: "c", type: "EVENT", bytes: 10 });
      bus.emit("message.out", { connId: "c", type: "OK", bytes: 10 });
      bus.emit("event.rejected", { code: "invalid", reason: "bad", source: "ws" });
      bus.emit("req.executed", { connId: "c", subId: "s", filters: [], results: 0, durationMs: 5, ip: "1.1.1.1" });
      proc.state.user += 250_000; // 250ms CPU per 1s
    });
    for (let i = 1; i <= 100; i++)
      bus.emit("req.executed", { connId: "c", subId: "s", filters: [], results: 0, durationMs: i, ip: "1.1.1.1" });
    metrics.tick();
    const s = metrics.snapshot();
    expect(s.connections).toBe(2);
    expect(s.authedConnections).toBe(1);
    expect(s.subscriptions).toBe(5);
    expect(s.eventsInPerSec).toBe(4);
    expect(s.eventsOutPerSec).toBe(1);
    expect(s.rejectedPerSec).toBe(1);
    expect(s.totalEvents).toBe(42 + 40); // the last COUNT plus the events stored since
    expect(s.dbBytes).toBe(4096);
    expect(s.mediaCount).toBe(7);
    expect(s.mediaBytes).toBe(700);
    expect(s.memoryRss).toBe(100 * 1048576);
    expect(s.reqLatencyP99).toBe(99);
    expect(s.reqLatencyP50).toBeLessThanOrEqual(50);
    expect(seen.length).toBe(11);
    // last tick had no CPU usage, the previous ones 25%
    expect(s.cpuPercent).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
  });

  test("cpu percent from cpuUsage deltas", async () => {
    const { metrics, proc, run } = await setup();
    run(1);
    proc.state.user += 300_000;
    proc.state.system += 200_000;
    run(1);
    expect(metrics.snapshot().cpuPercent).toBe(50);
  });

  test("store stats are refreshed at most every statsIntervalMs", async () => {
    const { metrics, events, run } = await setup({ options: { statsIntervalMs: 60_000 } });
    run(1);
    await new Promise((r) => setTimeout(r, 0));
    const calls = events.calls;
    expect(calls).toBe(1);
    run(30);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.calls).toBe(calls);
    run(31);
    expect(events.calls).toBe(calls + 1);
  });

  test("stored events update the total in memory; the event COUNT still runs only every statsIntervalMs", async () => {
    const { metrics, bus, events, run } = await setup({ options: { statsIntervalMs: 60_000, statsDirtyMs: 5_000 } });
    run(1);
    await new Promise((r) => setTimeout(r, 0));
    run(1);
    const calls = events.calls;
    expect(metrics.snapshot().totalEvents).toBe(42);
    bus.emit("event.accepted", { event: ev(20001), status: "ephemeral", source: "ws" });
    bus.emit("event.accepted", { event: ev(0), status: "replaced", source: "ws" });
    for (let i = 0; i < 3; i++) bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
    bus.emit("event.deleted", { ids: ["x"], actor: "a" });
    run(5);
    expect(events.calls).toBe(calls);
    expect(metrics.snapshot().totalEvents).toBe(45);
    run(54);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.calls).toBe(calls + 1);
    run(1);
    expect(metrics.snapshot().totalEvents).toBe(42); // the COUNT is authoritative again
  });

  test("media stats refresh within statsDirtyMs after blobs change, without an event COUNT", async () => {
    const blossom = fakeBlossom(7, 700);
    const { bus, events, run } = await setup({ blossom, options: { statsIntervalMs: 60_000, statsDirtyMs: 5_000 } });
    run(1);
    await new Promise((r) => setTimeout(r, 0));
    const [eventCalls, mediaCalls] = [events.calls, blossom.calls];
    bus.emit("blob.deleted", { sha256: "x", actor: "a" });
    run(5);
    await new Promise((r) => setTimeout(r, 0));
    expect(blossom.calls).toBe(mediaCalls + 1);
    expect(events.calls).toBe(eventCalls);
  });
});

describe("rollups", () => {
  test("flush + series: counters summed with gap filling, gauges averaged", async () => {
    const relay = fakeRelay([{}, {}]);
    const { metrics, bus, clock, run } = await setup({ relay });
    const t0 = Math.floor(clock.sec / 60) * 60;
    // minute 0: 2 events/s for 60s, 2 connections
    run(60, () => {
      bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
      bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
    });
    // minute 1: idle, 4 connections
    relay.conns = [{}, {}, {}, {}];
    run(60);
    await metrics.flush();
    const rows = await metrics.series("events_in", { from: t0, to: t0 + 180, stepSec: 60 });
    expect(rows).toEqual([
      { t: t0, v: 120 },
      { t: t0 + 60, v: 0 },
      { t: t0 + 120, v: 0 },
      { t: t0 + 180, v: 0 },
    ]);
    const twoMin = await metrics.series("events_in", { from: t0, to: t0 + 119, stepSec: 120 });
    expect(twoMin).toEqual([{ t: t0, v: 120 }]);
    const conns = await metrics.series("connections", { from: t0, to: t0 + 180, stepSec: 120 });
    // gauge: avg of minute averages (2 and 4); the empty 2nd step is omitted (no gap filling for gauges)
    expect(conns).toEqual([{ t: t0, v: 3 }]);
  });

  test("series include the current in-memory minute and plugin metrics", async () => {
    const { metrics, bus, clock, run } = await setup();
    const t0 = Math.floor(clock.sec / 60) * 60;
    run(5, () => bus.emit("req.executed", { connId: "c", subId: "s", filters: [], results: 0, durationMs: 1, ip: "x" }));
    const c = metrics.counter("myplugin.hits");
    c.add(3);
    c.add();
    const g = metrics.gauge("myplugin.queue");
    g.set(10);
    g.set(20);
    expect(await metrics.series("req", { from: t0, to: t0 + 59, stepSec: 60 })).toEqual([{ t: t0, v: 5 }]);
    expect(await metrics.series("myplugin.hits", { from: t0, to: t0 + 59, stepSec: 60 })).toEqual([{ t: t0, v: 4 }]);
    expect(await metrics.series("myplugin.queue", { from: t0, to: t0 + 59, stepSec: 60 })).toEqual([{ t: t0, v: 15 }]);
    // after stop the partial minute is persisted
    await metrics.start();
    await metrics.stop();
    expect(await metrics.series("myplugin.hits", { from: t0, to: t0 + 59, stepSec: 60 })).toEqual([{ t: t0, v: 4 }]);
  });

  test("repeated flushes add counters instead of overwriting", async () => {
    const { metrics, bus, clock, db, run } = await setup();
    const h = Math.floor(clock.sec / 3600) * 3600;
    bus.emit("event.accepted", { event: ev(7), status: "saved", source: "ws" });
    await metrics.flush();
    bus.emit("event.accepted", { event: ev(7), status: "saved", source: "ws" });
    await metrics.flush();
    run(1);
    const rows = await db.all<{ count: number }>("SELECT count FROM metrics_kinds WHERE bucket = ? AND kind = 7", [h]);
    expect(rows.map((r) => Number(r.count))).toEqual([2]);
  });

  test("kinds, top pubkeys and rejections aggregate over range", async () => {
    const { metrics, bus, clock, run } = await setup();
    const from = clock.sec - 10;
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    for (let i = 0; i < 3; i++) bus.emit("event.accepted", { event: ev(1, A), status: "saved", source: "ws" });
    bus.emit("event.accepted", { event: ev(7, B), status: "saved", source: "ws" });
    await metrics.flush();
    run(3600); // next hour
    bus.emit("event.accepted", { event: ev(1, B), status: "saved", source: "ws" });
    bus.emit("event.accepted", { event: ev(1, B), status: "saved", source: "ws" });
    bus.emit("event.accepted", { event: ev(1, B), status: "saved", source: "ws" });
    bus.emit("event.rejected", { code: "rate-limited", reason: "rate-limited: 121 events/min from 8.8.8.8", pubkey: B, source: "ws" });
    bus.emit("event.rejected", { code: "rate-limited", reason: "rate-limited: 999 events/min from 1.2.3.4", event: ev(1, A), source: "ws" });
    bus.emit("event.rejected", { code: "pow", reason: "pow: difficulty 8 < 20", source: "ws" });
    const range = { from, to: clock.sec };
    expect(await metrics.kinds(range)).toEqual([{ kind: 1, count: 6 }, { kind: 7, count: 1 }]);
    expect(await metrics.topPubkeys(range, 10)).toEqual([
      { pubkey: B, events: 4, rejected: 1 },
      { pubkey: A, events: 3, rejected: 1 },
    ]);
    expect(await metrics.topPubkeys(range, 1)).toHaveLength(1);
    expect(await metrics.rejections(range)).toEqual([
      { code: "rate-limited", reason: "<n> events/min from <ip>", count: 2 },
      { code: "pow", reason: "difficulty <n> < <n>", count: 1 },
    ]);
    // range limited to the current hour only
    expect(await metrics.kinds({ from: clock.sec, to: clock.sec })).toEqual([{ kind: 1, count: 3 }]);
  });

  test("pubkey tracking is memory bounded", async () => {
    const { metrics, bus, clock } = await setup({ options: { maxPubkeysPerBucket: 5 } });
    for (let i = 0; i < 20; i++) bus.emit("event.accepted", { event: ev(1, String(i).padStart(64, "0")), status: "saved", source: "ws" });
    const top = await metrics.topPubkeys({ from: clock.sec - 60, to: clock.sec }, 100);
    expect(top).toHaveLength(5);
    expect((await metrics.kinds({ from: clock.sec - 60, to: clock.sec }))[0].count).toBe(20);
  });

  test("retention prune removes old rows", async () => {
    const { metrics, db, clock } = await setup({ config: { metrics: { retentionDays: 1 } } });
    const old = clock.sec - 2 * 86400;
    await db.run("INSERT INTO metrics_series (name, bucket, value) VALUES ('req', ?, 1), ('req', ?, 2)", [old, clock.sec - 60]);
    await db.run("INSERT INTO metrics_kinds (bucket, kind, count) VALUES (?, 1, 1)", [old]);
    await db.run("INSERT INTO metrics_geo (bucket, country, country_name, city, lat, lon, connections, events) VALUES (?, 'DE', 'Germany', '', 0, 0, 1, 1)", [old]);
    expect(await metrics.prune()).toBe(3);
    const left = await db.all<{ bucket: number }>("SELECT bucket FROM metrics_series");
    expect(left.map((r) => Number(r.bucket))).toEqual([clock.sec - 60]);
  });
});

describe("geo", () => {
  test("no database: geo() is empty and lookupIp undefined", async () => {
    const { metrics, bus, clock } = await setup();
    bus.emit("connection.open", { connId: "1", ip: "8.8.8.8", at: clock.sec });
    expect(await metrics.geo({ from: 0, to: clock.sec })).toEqual([]);
    expect(metrics.lookupIp("8.8.8.8")).toBeUndefined();
  });

  test("aggregates connections and events per city without storing IPs", async () => {
    const DE = { country: "DE", countryName: "Germany", city: "Berlin", lat: 52.5, lon: 13.4 };
    const { metrics, bus, clock, db } = await setup({ options: { geo: fakeGeo({ "8.8.8.8": DE, "9.9.9.9": DE }) } });
    bus.emit("connection.open", { connId: "1", ip: "8.8.8.8", at: clock.sec });
    bus.emit("connection.open", { connId: "2", ip: "9.9.9.9", at: clock.sec });
    bus.emit("connection.open", { connId: "3", ip: "127.0.0.1", at: clock.sec });
    bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws", ip: "8.8.8.8" });
    expect(await metrics.geo({ from: clock.sec - 60, to: clock.sec })).toEqual([{ ...DE, connections: 2, events: 1 }]);
    expect(metrics.lookupIp("8.8.8.8")).toEqual({ country: "DE", city: "Berlin", lat: 52.5, lon: 13.4 });
    const dump = JSON.stringify(await db.all("SELECT * FROM metrics_geo"));
    expect(dump).not.toContain("8.8.8.8");
  });

  test("missing mmdb file disables geo gracefully", async () => {
    const { metrics, clock } = await setup({ config: { metrics: { geoipDbPath: "./does-not-exist.mmdb" } } });
    expect(metrics.lookupIp("8.8.8.8")).toBeUndefined();
    expect(await metrics.geo({ from: 0, to: clock.sec })).toEqual([]);
  });
});

describe("alerts", () => {
  test("rejection spike must be sustained 30s and respects a 10 min cooldown", async () => {
    const { bus, alerts, run } = await setup();
    const spam = () => {
      for (let i = 0; i < 60; i++) bus.emit("event.rejected", { code: "rate-limited", reason: "slow down", source: "ws" });
    };
    run(29, spam);
    expect(alerts).toHaveLength(0);
    run(2, spam);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "warning", title: "Rejection spike" });
    run(300, spam);
    expect(alerts).toHaveLength(1);
    run(301, spam);
    expect(alerts).toHaveLength(2);
  });

  test("short bursts do not alert", async () => {
    const { bus, alerts, run } = await setup();
    for (let k = 0; k < 5; k++) {
      run(20, () => {
        for (let i = 0; i < 100; i++) bus.emit("event.rejected", { code: "invalid", reason: "x", source: "ws" });
      });
      run(1);
    }
    expect(alerts).toHaveLength(0);
  });

  test("memory and loop lag alerts", async () => {
    let lag = 0;
    const { proc, alerts, run } = await setup({ options: { memoryLimitBytes: 200 * 1048576, loopLag: () => lag } });
    proc.state.rss = 190 * 1048576;
    run(1);
    expect(alerts).toEqual([expect.objectContaining({ level: "critical", title: "High memory usage" })]);
    run(5);
    expect(alerts).toHaveLength(1);
    lag = 800;
    run(12);
    expect(alerts.at(-1)).toMatchObject({ title: "Event loop lag" });
  });
});

test("prometheus rendering", async () => {
  const { metrics, bus, run } = await setup({ relay: fakeRelay([{}]) });
  bus.emit("event.rejected", { code: "pow", reason: "x", source: "ws" });
  bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
  metrics.counter("plugin.spam-filter hits", "Spam hits").add(2);
  metrics.gauge("queue_depth").set(7);
  run(1);
  const text = renderPrometheus(metrics);
  expect(text).toContain("# TYPE beamhop_connections gauge\nbeamhop_connections 1\n");
  expect(text).toContain("beamhop_events_in_total 1");
  expect(text).toContain('beamhop_rejected_total{code="pow"} 1');
  expect(text).toContain("# HELP plugin_spam_filter_hits_total Spam hits\n# TYPE plugin_spam_filter_hits_total counter\nplugin_spam_filter_hits_total 2");
  expect(text).toContain("queue_depth 7");
  expect(text.endsWith("\n")).toBe(true);
});

test("otel enabled with unreachable collector does not crash", async () => {
  const { metrics, run } = await setup({ config: { metrics: { otel: { enabled: true, endpoint: "http://127.0.0.1:1/v1/metrics", intervalMs: 50 } } } });
  await metrics.start();
  metrics.counter("x").add(1);
  metrics.gauge("y").set(1);
  run(1);
  await new Promise((r) => setTimeout(r, 150));
  await metrics.stop();
});
