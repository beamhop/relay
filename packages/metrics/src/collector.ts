import type { EventBus } from "@beamhop/sdk";
import type { GeoLookup } from "./geo";
import { normalizeReason } from "./normalize";
import type { Rollup } from "./rollup";
import { LatencyWindow, RateWindow } from "./window";

/** Cumulative counters since process start (Prometheus / OTel observable counters). */
export interface Totals {
  eventsIn: number;
  eventsOut: number;
  req: number;
  rejected: number;
  rejectedByCode: Map<string, number>;
  connectionsOpened: number;
  connectionsClosed: number;
  bytesIn: number;
  bytesOut: number;
  blobsUploaded: number;
  blobBytesUploaded: number;
  blobsServed: number;
  blobBytesServed: number;
}

/** Per-second accumulators that are rolled into the minute rollup on each tick. */
interface SecondCounters {
  bytesIn: number;
  bytesOut: number;
  connectionsOpened: number;
  blobsUploaded: number;
  blobBytesUploaded: number;
  blobsServed: number;
  blobBytesServed: number;
}

/**
 * Rejection codes that can be emitted before the signature was verified (size limits, bad id/sig,
 * internal errors): their `pubkey` is unauthenticated, so it isn't credited in per-pubkey stats.
 */
const UNVERIFIED_CODES = new Set(["invalid", "too-large", "error"]);

/**
 * Bus subscribers. Every handler is O(1): integer increments, plus a couple of Map updates on the
 * current hour accumulator (kinds, pubkeys, geo via cached lookup). No timers, no I/O, no Date.now().
 */
export class Collector {
  readonly eventsIn: RateWindow;
  readonly eventsOut: RateWindow;
  readonly req: RateWindow;
  readonly rejected: RateWindow;
  readonly latency = new LatencyWindow(4096);
  readonly totals: Totals = {
    eventsIn: 0, eventsOut: 0, req: 0, rejected: 0, rejectedByCode: new Map(),
    connectionsOpened: 0, connectionsClosed: 0, bytesIn: 0, bytesOut: 0,
    blobsUploaded: 0, blobBytesUploaded: 0, blobsServed: 0, blobBytesServed: 0,
  };
  private sec: SecondCounters = { bytesIn: 0, bytesOut: 0, connectionsOpened: 0, blobsUploaded: 0, blobBytesUploaded: 0, blobsServed: 0, blobBytesServed: 0 };
  /** time of the last tick; used to stamp latency samples without calling the clock on the hot path */
  tickMs: number;
  private unsubs: (() => void)[] = [];

  constructor(startMs: number, private rollup: Rollup, private geo: GeoLookup) {
    this.tickMs = startMs;
    this.eventsIn = new RateWindow(startMs);
    this.eventsOut = new RateWindow(startMs);
    this.req = new RateWindow(startMs);
    this.rejected = new RateWindow(startMs);
  }

  attach(bus: EventBus) {
    if (this.unsubs.length) return;
    const t = this.totals;
    const s = this.sec;
    this.unsubs.push(
      bus.on("connection.open", (p) => {
        t.connectionsOpened++;
        s.connectionsOpened++;
        if (this.geo.enabled) {
          const g = this.geo.lookup(p.ip);
          if (g) this.rollup.hour.geoHit(g, 1, 0);
        }
      }),
      bus.on("connection.close", () => {
        t.connectionsClosed++;
      }),
      bus.on("event.accepted", (p) => {
        t.eventsIn++;
        this.eventsIn.cur++;
        const h = this.rollup.hour;
        h.kind(p.event.kind);
        h.pubkey(p.event.pubkey, 1, 0);
        if (p.ip && this.geo.enabled) {
          const g = this.geo.lookup(p.ip);
          if (g) h.geoHit(g, 0, 1);
        }
      }),
      bus.on("event.rejected", (p) => {
        t.rejected++;
        this.rejected.cur++;
        t.rejectedByCode.set(p.code, (t.rejectedByCode.get(p.code) ?? 0) + 1);
        const h = this.rollup.hour;
        h.rejection(p.code, normalizeReason(p.reason));
        const pk = p.pubkey ?? p.event?.pubkey;
        if (pk && !UNVERIFIED_CODES.has(p.code)) h.pubkey(pk, 0, 1);
      }),
      bus.on("req.executed", (p) => {
        t.req++;
        this.req.cur++;
        this.latency.add(p.durationMs, this.tickMs);
      }),
      bus.on("message.in", (p) => {
        t.bytesIn += p.bytes;
        s.bytesIn += p.bytes;
      }),
      bus.on("message.out", (p) => {
        t.bytesOut += p.bytes;
        s.bytesOut += p.bytes;
        if (p.type === "EVENT") {
          t.eventsOut++;
          this.eventsOut.cur++;
        }
      }),
      bus.on("blob.uploaded", (p) => {
        t.blobsUploaded++;
        t.blobBytesUploaded += p.size;
        s.blobsUploaded++;
        s.blobBytesUploaded += p.size;
      }),
      bus.on("blob.served", (p) => {
        t.blobsServed++;
        t.blobBytesServed += p.size;
        s.blobsServed++;
        s.blobBytesServed += p.size;
      }),
    );
  }

  detach() {
    for (const u of this.unsubs.splice(0)) u();
  }

  /** Close the current second: roll rate windows and move per-second counts into the minute rollup. */
  roll(nowMs: number) {
    this.tickMs = nowMs;
    const m = this.rollup.current;
    const s = this.sec;
    const add = (name: string, v: number) => {
      if (v) m.add(name, v);
    };
    add("events_in", this.eventsIn.roll(nowMs));
    add("events_out", this.eventsOut.roll(nowMs));
    add("req", this.req.roll(nowMs));
    add("rejected", this.rejected.roll(nowMs));
    add("bytes_in", s.bytesIn);
    add("bytes_out", s.bytesOut);
    add("connections_opened", s.connectionsOpened);
    add("blobs_uploaded", s.blobsUploaded);
    add("blob_bytes_uploaded", s.blobBytesUploaded);
    add("blobs_served", s.blobsServed);
    add("blob_bytes_served", s.blobBytesServed);
    s.bytesIn = s.bytesOut = s.connectionsOpened = s.blobsUploaded = s.blobBytesUploaded = s.blobsServed = s.blobBytesServed = 0;
  }
}
