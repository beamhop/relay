import type { Db, GeoPoint, TimeRange } from "@beamhop/sdk";
import type { GeoInfo } from "./geo";

const MINUTE = 60;
const HOUR = 3600;
const minuteOf = (sec: number) => Math.floor(sec / MINUTE) * MINUTE;
const hourOf = (sec: number) => Math.floor(sec / HOUR) * HOUR;

/** Built-in gauge series (averaged when re-bucketed); everything else is a counter (summed) unless registered via `gauge()`. */
const BUILTIN_GAUGES = ["connections", "subscriptions", "cpu", "memory", "heap", "loop_lag", "req_latency_p95"] as const;

interface GaugeAcc {
  sum: number;
  count: number;
}
class MinuteAcc {
  counters = new Map<string, number>();
  gauges = new Map<string, GaugeAcc>();
  constructor(readonly bucket: number) {}
  add(name: string, v: number) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + v);
  }
  sample(name: string, v: number) {
    const g = this.gauges.get(name);
    if (g) {
      g.sum += v;
      g.count++;
    } else this.gauges.set(name, { sum: v, count: 1 });
  }
  merge(o: MinuteAcc) {
    for (const [k, v] of o.counters) this.add(k, v);
    for (const [k, g] of o.gauges) {
      const t = this.gauges.get(k);
      if (t) {
        t.sum += g.sum;
        t.count += g.count;
      } else this.gauges.set(k, { ...g });
    }
  }
}

export interface PubkeyAcc {
  events: number;
  rejected: number;
}
export interface RejectAcc {
  code: string;
  reason: string;
  count: number;
}
export interface GeoAcc extends GeoInfo {
  connections: number;
  events: number;
}
class HourAcc {
  kinds = new Map<number, number>();
  pubkeys = new Map<string, PubkeyAcc>();
  rejections = new Map<string, RejectAcc>();
  geo = new Map<string, GeoAcc>();
  droppedPubkeys = 0;
  /**
   * @param admitted pubkeys admitted in this hour bucket so far, shared by every accumulator of the bucket
   *   (a flush closes the accumulator mid-hour) so `maxPubkeys` bounds the whole hour, not each flush
   */
  constructor(
    readonly bucket: number,
    private maxPubkeys: number,
    private admitted: Set<string> = new Set(),
  ) {}

  kind(k: number) {
    this.kinds.set(k, (this.kinds.get(k) ?? 0) + 1);
  }
  pubkey(pk: string, events: number, rejected: number) {
    const p = this.pubkeys.get(pk);
    if (p) {
      p.events += events;
      p.rejected += rejected;
    } else if (this.admitted.has(pk) || this.admitted.size < this.maxPubkeys) {
      this.admitted.add(pk);
      this.pubkeys.set(pk, { events, rejected });
    } else this.droppedPubkeys++;
  }
  rejection(code: string, reason: string, n = 1) {
    const key = code + "\u0000" + reason;
    const r = this.rejections.get(key);
    if (r) r.count += n;
    else this.rejections.set(key, { code, reason, count: n });
  }
  geoHit(g: GeoInfo, connections: number, events: number) {
    const key = g.country + "\u0000" + (g.city ?? "");
    const a = this.geo.get(key);
    if (a) {
      a.connections += connections;
      a.events += events;
    } else this.geo.set(key, { ...g, connections, events });
  }
  get empty() {
    return !this.kinds.size && !this.pubkeys.size && !this.rejections.size && !this.geo.size;
  }
  /** Fresh accumulator for the same bucket that keeps counting toward this hour's pubkey cap. */
  continuation(): HourAcc {
    return new HourAcc(this.bucket, this.maxPubkeys, this.admitted);
  }
  merge(o: HourAcc) {
    for (const [k, v] of o.kinds) this.kinds.set(k, (this.kinds.get(k) ?? 0) + v);
    for (const [k, v] of o.pubkeys) this.pubkey(k, v.events, v.rejected);
    for (const r of o.rejections.values()) this.rejection(r.code, r.reason, r.count);
    for (const g of o.geo.values()) this.geoHit(g, g.connections, g.events);
    this.droppedPubkeys += o.droppedPubkeys;
  }
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const CHUNK = 200;

/**
 * A batch the database rejects for its content (e.g. a value postgres can't store) would fail forever;
 * such errors drop the batch instead of re-queuing it. Connection/lock errors are retried.
 */
function isPermanentDbError(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  if (/^(22|23|42)/.test(code)) return true; // postgres: data exception, integrity violation, syntax/undefined object
  // generic SQLITE_ERROR also covers transient conditions (schema changing under a migration…): retried
  return /^SQLITE_(CONSTRAINT|MISMATCH|TOOBIG|RANGE)/.test(code);
}
/** Even retryable failures stop being re-queued after this many consecutive attempts. */
const MAX_FLUSH_ATTEMPTS = 10;

/** Orders rows by their key columns so concurrent upserts (several instances) lock rows in the same order. */
function sortByKeys(cols: string[], keys: string[], rows: unknown[][]): unknown[][] {
  const idx = keys.map((k) => cols.indexOf(k));
  return [...rows].sort((a, b) => {
    for (const i of idx) {
      const x = a[i] as string | number;
      const y = b[i] as string | number;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
}

/** multi-row upsert in chunks (keys must be unique per call) */
async function upsert(db: Db, table: string, cols: string[], keys: string[], update: string, rows: unknown[][]) {
  rows = sortByKeys(cols, keys, rows);
  const one = `(${cols.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const sql =
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map(() => one).join(", ")} ` +
      `ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${update}`;
    await db.run(sql, chunk.flat());
  }
}

/**
 * In-memory minute/hour accumulators + persistence and query helpers.
 * Closed accumulators queue in `pending` until flushed; `inflight` ones are still visible to queries.
 */
export class Rollup {
  current: MinuteAcc;
  hour: HourAcc;
  private pendingMinutes: MinuteAcc[] = [];
  private inflightMinutes: MinuteAcc[] = [];
  private pendingHours: HourAcc[] = [];
  private flushChain: Promise<void> = Promise.resolve();
  /** Consecutive failed flushes of re-queued data. */
  private failedFlushes = 0;
  private lastTrimmedHour = 0;
  readonly gaugeNames = new Set<string>(BUILTIN_GAUGES);

  constructor(
    private db: Db,
    nowSec: number,
    private opts: { maxPubkeysPerBucket: number; topPubkeysPerHour: number; onDropped?: (message: string) => void },
  ) {
    this.current = new MinuteAcc(minuteOf(nowSec));
    this.hour = new HourAcc(hourOf(nowSec), opts.maxPubkeysPerBucket);
    this.lastTrimmedHour = hourOf(nowSec) - 2 * HOUR;
  }

  /** Advances accumulators to `nowSec`, queuing closed buckets for flush. */
  advance(nowSec: number) {
    const m = minuteOf(nowSec);
    if (m !== this.current.bucket) {
      this.pendingMinutes.push(this.current);
      this.current = new MinuteAcc(m);
    }
    const h = hourOf(nowSec);
    if (h !== this.hour.bucket) {
      this.pendingHours.push(this.hour);
      this.hour = new HourAcc(h, this.opts.maxPubkeysPerBucket);
    }
  }

  /** Close the current (partial) minute so it gets flushed too (used on stop). */
  closeCurrent(nowSec: number) {
    this.pendingMinutes.push(this.current);
    this.current = new MinuteAcc(minuteOf(nowSec));
  }

  /**
   * Persist pending minutes and all hourly data in one transaction. Serialized. Only scheduled flushes
   * (`countFailure`, the default) spend the retry budget; read-path flushes can't push a batch into being dropped.
   */
  flush(opts: { countFailure?: boolean } = {}): Promise<void> {
    const run = this.flushChain.then(() => this.doFlush(opts.countFailure ?? true));
    this.flushChain = run.catch(() => {});
    return run;
  }

  /**
   * Flush before a read so it sees recent data. A transient failure is left to the scheduled flush to retry;
   * a batch dropped here (permanent DB error) is reported, since nobody awaits this flush's error.
   */
  private flushForRead(): Promise<void> {
    return this.flush({ countFailure: false }).catch((err) => {
      if (String(err).includes("metrics batch dropped")) this.opts.onDropped?.(String(err));
    });
  }

  private async doFlush(countFailure: boolean) {
    const minutes = mergeBy(this.pendingMinutes.splice(0), (a) => a.bucket, (a) => new MinuteAcc(a.bucket));
    if (!this.hour.empty) {
      this.pendingHours.push(this.hour);
      this.hour = this.hour.continuation();
    }
    const hours = mergeBy(this.pendingHours.splice(0), (a) => a.bucket, (a) => new HourAcc(a.bucket, Number.MAX_SAFE_INTEGER));
    this.inflightMinutes = minutes;
    if (!minutes.length && !hours.length) return;
    const counters: unknown[][] = [];
    const gauges: unknown[][] = [];
    const kinds: unknown[][] = [];
    const pubkeys: unknown[][] = [];
    const rejections: unknown[][] = [];
    const geo: unknown[][] = [];
    for (const m of minutes) {
      for (const [name, v] of m.counters) counters.push([name, m.bucket, v]);
      for (const [name, g] of m.gauges) gauges.push([name, m.bucket, g.sum / g.count]);
    }
    for (const h of hours) {
      for (const [k, c] of h.kinds) kinds.push([h.bucket, k, c]);
      for (const [pk, p] of h.pubkeys) pubkeys.push([h.bucket, pk, p.events, p.rejected]);
      for (const r of h.rejections.values()) rejections.push([h.bucket, r.code, r.reason, r.count]);
      for (const g of h.geo.values())
        geo.push([h.bucket, g.country, g.countryName, g.city ?? "", g.lat, g.lon, g.connections, g.events]);
    }
    try {
      await this.db.tx(async (db) => {
        const S = ["name", "bucket", "value"];
        await upsert(db, "metrics_series", S, ["name", "bucket"], "value = metrics_series.value + excluded.value", counters);
        await upsert(db, "metrics_series", S, ["name", "bucket"], "value = excluded.value", gauges);
        await upsert(db, "metrics_kinds", ["bucket", "kind", "count"], ["bucket", "kind"], "count = metrics_kinds.count + excluded.count", kinds);
        await upsert(
          db, "metrics_pubkeys", ["bucket", "pubkey", "events", "rejected"], ["bucket", "pubkey"],
          "events = metrics_pubkeys.events + excluded.events, rejected = metrics_pubkeys.rejected + excluded.rejected", pubkeys,
        );
        await upsert(
          db, "metrics_rejections", ["bucket", "code", "reason", "count"], ["bucket", "code", "reason"],
          "count = metrics_rejections.count + excluded.count", rejections,
        );
        await upsert(
          db, "metrics_geo", ["bucket", "country", "country_name", "city", "lat", "lon", "connections", "events"], ["bucket", "country", "city"],
          "connections = metrics_geo.connections + excluded.connections, events = metrics_geo.events + excluded.events", geo,
        );
      });
      this.failedFlushes = 0;
    } catch (err) {
      if (countFailure) this.failedFlushes++;
      if (isPermanentDbError(err) || this.failedFlushes >= MAX_FLUSH_ATTEMPTS) {
        this.failedFlushes = 0;
        throw new Error(`metrics batch dropped (${minutes.length} minute / ${hours.length} hour buckets): ${String(err)}`);
      }
      // keep data for the next attempt
      this.pendingMinutes.unshift(...minutes);
      this.pendingHours.unshift(...hours);
      throw err;
    } finally {
      this.inflightMinutes = [];
    }
    await this.trimPubkeys();
  }

  /** Keep only the top-N pubkeys of each closed hour to bound table growth. */
  private async trimPubkeys() {
    const closedUpTo = this.hour.bucket - HOUR;
    for (let h = this.lastTrimmedHour + HOUR; h <= closedUpTo; h += HOUR) {
      await this.db.run(
        `DELETE FROM metrics_pubkeys WHERE bucket = ? AND pubkey NOT IN
         (SELECT pubkey FROM metrics_pubkeys WHERE bucket = ? ORDER BY events + rejected DESC, pubkey LIMIT ?)`,
        [h, h, this.opts.topPubkeysPerHour],
      );
      this.lastTrimmedHour = h;
      if (closedUpTo - h > 48 * HOUR) h = closedUpTo - HOUR; // don't walk ancient gaps one by one
    }
  }

  async prune(beforeSec: number): Promise<number> {
    let n = 0;
    await this.db.tx(async (db) => {
      for (const t of ["metrics_series", "metrics_kinds", "metrics_pubkeys", "metrics_rejections", "metrics_geo"])
        n += (await db.run(`DELETE FROM ${t} WHERE bucket < ?`, [beforeSec])).changes;
    });
    return n;
  }

  isGauge(name: string) {
    return this.gaugeNames.has(name);
  }

  async series(name: string, range: TimeRange): Promise<{ t: number; v: number }[]> {
    const step = pickStep(range);
    const start = Math.floor(range.from / step) * step;
    const end = Math.floor(range.to / step) * step;
    const gauge = this.isGauge(name);
    await this.flushChain; // avoid reading half-written flush rows + inflight memory
    const rows = await this.db.all<{ bucket: unknown; value: unknown }>(
      "SELECT bucket, value FROM metrics_series WHERE name = ? AND bucket >= ? AND bucket < ?",
      [name, start, end + step],
    );
    // per-minute values: db + memory (memory gauges override, counters add)
    const minutes = new Map<number, number>();
    for (const r of rows) minutes.set(num(r.bucket), num(r.value));
    for (const m of [...this.inflightMinutes, ...this.pendingMinutes, this.current]) {
      if (m.bucket < start || m.bucket >= end + step) continue;
      if (gauge) {
        const g = m.gauges.get(name);
        if (g) minutes.set(m.bucket, g.sum / g.count);
      } else {
        const c = m.counters.get(name);
        if (c !== undefined) minutes.set(m.bucket, (minutes.get(m.bucket) ?? 0) + c);
      }
    }
    const sums = new Map<number, { sum: number; count: number }>();
    for (const [b, v] of minutes) {
      const t = Math.floor(b / step) * step;
      const s = sums.get(t);
      if (s) {
        s.sum += v;
        s.count++;
      } else sums.set(t, { sum: v, count: 1 });
    }
    const out: { t: number; v: number }[] = [];
    for (let t = start; t <= end; t += step) {
      const s = sums.get(t);
      if (gauge) {
        if (s) out.push({ t, v: s.sum / s.count });
      } else out.push({ t, v: s ? s.sum : 0 });
    }
    return out;
  }

  async kinds(range: TimeRange) {
    await this.flushForRead();
    const rows = await this.db.all<{ kind: unknown; count: unknown }>(
      "SELECT kind, SUM(count) AS count FROM metrics_kinds WHERE bucket >= ? AND bucket <= ? GROUP BY kind ORDER BY count DESC, kind",
      [hourOf(range.from), range.to],
    );
    return rows.map((r) => ({ kind: num(r.kind), count: num(r.count) }));
  }

  async topPubkeys(range: TimeRange, limit = 20) {
    await this.flushForRead();
    const rows = await this.db.all<{ pubkey: string; events: unknown; rejected: unknown }>(
      `SELECT pubkey, SUM(events) AS events, SUM(rejected) AS rejected FROM metrics_pubkeys
       WHERE bucket >= ? AND bucket <= ? GROUP BY pubkey ORDER BY events DESC, rejected DESC, pubkey LIMIT ?`,
      [hourOf(range.from), range.to, Math.max(1, Math.min(1000, Math.floor(limit)))],
    );
    return rows.map((r) => ({ pubkey: r.pubkey, events: num(r.events), rejected: num(r.rejected) }));
  }

  async rejections(range: TimeRange, limit = 100) {
    await this.flushForRead();
    const rows = await this.db.all<{ code: string; reason: string; count: unknown }>(
      `SELECT code, reason, SUM(count) AS count FROM metrics_rejections
       WHERE bucket >= ? AND bucket <= ? GROUP BY code, reason ORDER BY count DESC, code, reason LIMIT ?`,
      [hourOf(range.from), range.to, limit],
    );
    return rows.map((r) => ({ code: r.code, reason: r.reason, count: num(r.count) }));
  }

  async geo(range: TimeRange): Promise<GeoPoint[]> {
    await this.flushForRead();
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT country, MAX(country_name) AS country_name, city, MAX(lat) AS lat, MAX(lon) AS lon,
              SUM(connections) AS connections, SUM(events) AS events
       FROM metrics_geo WHERE bucket >= ? AND bucket <= ? GROUP BY country, city ORDER BY connections DESC, events DESC`,
      [hourOf(range.from), range.to],
    );
    return rows.map((r) => ({
      country: String(r.country),
      countryName: String(r.country_name),
      city: r.city ? String(r.city) : undefined,
      lat: num(r.lat),
      lon: num(r.lon),
      connections: num(r.connections),
      events: num(r.events),
    }));
  }
}

/** Step in seconds: explicit (rounded to whole minutes) or auto (~360 points); capped at 5000 points. */
export function pickStep(range: TimeRange): number {
  const span = Math.max(0, range.to - range.from);
  let step = range.stepSec && range.stepSec > 0 ? range.stepSec : span / 360;
  step = Math.max(MINUTE, Math.ceil(step / MINUTE) * MINUTE);
  const minForCap = Math.ceil(span / 5000 / MINUTE) * MINUTE;
  return Math.max(step, minForCap);
}

function mergeBy<T extends { bucket: number; merge(o: T): void }>(items: T[], key: (t: T) => number, make: (t: T) => T): T[] {
  const byKey = new Map<number, T>();
  for (const it of items) {
    const k = key(it);
    let t = byKey.get(k);
    if (!t) byKey.set(k, (t = make(it)));
    t.merge(it);
  }
  return [...byKey.values()];
}
