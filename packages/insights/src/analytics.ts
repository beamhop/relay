// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Community analytics — local only, never sent anywhere (§8, rule 9).
 *
 * - Active users: one HyperLogLog per relay per UTC day (pubkeys are never
 *   stored for this); weekly/monthly figures are unions of daily sketches.
 * - Top kinds / clients (`client` tag, NIP-89) / user agents / countries: daily counters.
 * - Retention cohorts: users are grouped by the week they were first seen;
 *   for each later week we count how many came back. Only a 12-hex-char key
 *   prefix is kept to recognise returning users.
 * - Coarse geo: ONLY from a country code supplied by the runtime/proxy
 *   (e.g. Cloudflare `cf-ipcountry`). Never derived from IPs.
 * - Storage by user: computed on demand from the blob index.
 */
import type { DocStore, NostrEvent, Ports, RelayId } from '@beamhop/core';
import { HyperLogLog } from './hll.ts';

export const ANALYTICS_COLLECTION = 'insights.analytics';
export const COHORT_COLLECTION = 'insights.cohorts';
export const WEEK_ACTIVE_COLLECTION = 'insights.weekactive';

/** Max distinct keys per counter map per day (cardinality guard). */
const MAX_KEYS = 300;
/** Weeks of cohorts kept for returning-user recognition. */
export const COHORT_WEEKS = 26;

export function dayOf(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/** Week index with weeks starting Monday 00:00 UTC. */
export function weekOf(t: number): number {
  return Math.floor((Math.floor(t / 86400) + 3) / 7);
}

export function weekStart(week: number): number {
  return (week * 7 - 3) * 86400;
}

interface DayDoc {
  hll: string;
  events: number;
  newUsers: number;
  kinds: Record<string, number>;
  clients: Record<string, number>;
  agents: Record<string, number>;
  countries: Record<string, number>;
}

interface DayState {
  relayId: RelayId;
  day: string;
  hll: HyperLogLog;
  events: number;
  newUsers: number;
  kinds: Map<string, number>;
  clients: Map<string, number>;
  agents: Map<string, number>;
  countries: Map<string, number>;
  loaded: boolean;
  dirty: boolean;
}

interface CohortDoc {
  week: number;
  members: string[];
  /** weeks-after-first-seen → returning users. */
  retained: Record<string, number>;
}

interface RelayCohorts {
  loaded: Promise<void> | null;
  /** short key → cohort week */
  firstSeen: Map<string, number>;
  cohorts: Map<number, CohortDoc>;
  activeWeek: number;
  active: Set<string>;
  dirtyCohorts: Set<number>;
  activeDirty: boolean;
}

function bump(m: Map<string, number>, key: string, n = 1): void {
  const k = !m.has(key) && m.size >= MAX_KEYS ? 'other' : key;
  m.set(k, (m.get(k) ?? 0) + n);
}

function shortKey(pubkey: string): string {
  return pubkey.slice(0, 12);
}

/** Product token of a User-Agent, e.g. "Damus/1.2 (iOS)" → "Damus". */
export function agentName(ua: string): string {
  const first = ua.trim().split(/[\s/;(]/)[0] ?? '';
  return first.slice(0, 40) || 'unknown';
}

export function clientName(event: NostrEvent): string | undefined {
  for (const t of event.tags) {
    if (t[0] === 'client' && t[1]) return t[1].trim().slice(0, 40);
  }
  return undefined;
}

const COUNTRY = /^[A-Z]{2}$/;

export interface AnalyticsReport {
  relayId: RelayId;
  activeUsers: { daily: number; weekly: number; monthly: number };
  /** Daily active users for the last `days` days, oldest first. */
  dailyActive: Array<{ day: string; users: number; newUsers: number; events: number }>;
  topKinds: Array<{ kind: number; count: number }>;
  topClients: Array<{ name: string; count: number }>;
  topUserAgents: Array<{ name: string; count: number }>;
  countries: Array<{ country: string; count: number }>;
  cohorts: Array<{ weekStart: string; size: number; retained: number[] }>;
  storageByUser: Array<{ pubkey: string; bytes: number; files: number }>;
}

export class Analytics {
  private days = new Map<string, DayState>();
  private cohorts = new Map<RelayId, RelayCohorts>();
  private storageCache = new Map<RelayId, { at: number; rows: AnalyticsReport['storageByUser'] }>();
  private pending: Promise<unknown>[] = [];

  constructor(
    private ports: Ports,
    private opts: { geo: boolean; retentionDays: number },
  ) {}

  private get docs(): DocStore {
    return this.ports.docs;
  }

  private dayState(relayId: RelayId, now: number): DayState {
    const day = dayOf(now);
    const key = `${relayId}:${day}`;
    let s = this.days.get(key);
    if (!s) {
      s = {
        relayId,
        day,
        hll: new HyperLogLog(),
        events: 0,
        newUsers: 0,
        kinds: new Map(),
        clients: new Map(),
        agents: new Map(),
        countries: new Map(),
        loaded: false,
        dirty: false,
      };
      this.days.set(key, s);
    }
    s.dirty = true;
    return s;
  }

  private relayCohorts(relayId: RelayId): RelayCohorts {
    let c = this.cohorts.get(relayId);
    if (!c) {
      const fresh: RelayCohorts = {
        loaded: null,
        firstSeen: new Map(),
        cohorts: new Map(),
        activeWeek: -1,
        active: new Set(),
        dirtyCohorts: new Set(),
        activeDirty: false,
      };
      fresh.loaded = this.loadCohorts(relayId, fresh);
      this.cohorts.set(relayId, fresh);
      c = fresh;
    }
    return c;
  }

  private async loadCohorts(relayId: RelayId, c: RelayCohorts): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<CohortDoc>(COHORT_COLLECTION, {
        prefix: `${relayId}:`,
        cursor,
        limit: 100,
      });
      for (const { value } of page.items) {
        c.cohorts.set(value.week, value);
        for (const m of value.members) c.firstSeen.set(m, value.week);
      }
      cursor = page.cursor;
    } while (cursor);
  }

  private async loadActive(relayId: RelayId, c: RelayCohorts, week: number): Promise<void> {
    const doc = await this.docs.get<{ members: string[] }>(
      WEEK_ACTIVE_COLLECTION,
      `${relayId}:${week}`,
    );
    if (doc) for (const m of doc.members) c.active.add(m);
  }

  private track<T>(p: Promise<T>): void {
    const tracked = p.catch(() => undefined);
    this.pending.push(tracked);
  }

  /** Wait for background bookkeeping (tests). */
  async idle(): Promise<void> {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  /** An accepted event: counts author activity, kind and client. */
  onEvent(relayId: RelayId, event: NostrEvent, now: number): void {
    const s = this.dayState(relayId, now);
    s.events++;
    bump(s.kinds, String(event.kind));
    const client = clientName(event);
    if (client) bump(s.clients, client);
    this.onActive(relayId, event.pubkey, now);
  }

  onActive(relayId: RelayId, pubkey: string, now: number): void {
    const s = this.dayState(relayId, now);
    s.hll.add(pubkey);
    this.track(this.cohortActivity(relayId, pubkey, now));
  }

  onConnection(relayId: RelayId, now: number, userAgent?: string, country?: string): void {
    if (!userAgent && !country) return;
    const s = this.dayState(relayId, now);
    if (userAgent) bump(s.agents, agentName(userAgent));
    if (country && this.opts.geo) {
      const cc = country.toUpperCase();
      // XX / T1 are Cloudflare's "unknown" / Tor markers.
      if (COUNTRY.test(cc) && cc !== 'XX' && cc !== 'T1') bump(s.countries, cc);
    }
  }

  private async cohortActivity(relayId: RelayId, pubkey: string, now: number): Promise<void> {
    const c = this.relayCohorts(relayId);
    await c.loaded;
    const week = weekOf(now);
    if (c.activeWeek !== week) {
      c.activeWeek = week;
      c.active = new Set();
      await this.loadActive(relayId, c, week);
    }
    const k = shortKey(pubkey);
    if (c.active.has(k)) return;
    c.active.add(k);
    c.activeDirty = true;
    const first = c.firstSeen.get(k);
    if (first === undefined) {
      c.firstSeen.set(k, week);
      let doc = c.cohorts.get(week);
      if (!doc) {
        doc = { week, members: [], retained: {} };
        c.cohorts.set(week, doc);
      }
      doc.members.push(k);
      c.dirtyCohorts.add(week);
      this.dayState(relayId, now).newUsers++;
      return;
    }
    const doc = c.cohorts.get(first);
    if (!doc || first === week) return;
    const offset = String(week - first);
    doc.retained[offset] = (doc.retained[offset] ?? 0) + 1;
    c.dirtyCohorts.add(first);
  }

  private async loadDay(s: DayState): Promise<void> {
    if (s.loaded) return;
    s.loaded = true;
    const prev = await this.docs.get<DayDoc>(ANALYTICS_COLLECTION, `${s.relayId}:${s.day}`);
    if (!prev) return;
    s.hll.merge(HyperLogLog.fromBase64(prev.hll));
    s.events += prev.events;
    s.newUsers += prev.newUsers;
    const merge = (m: Map<string, number>, r: Record<string, number>) => {
      for (const [k, v] of Object.entries(r)) bump(m, k, v);
    };
    merge(s.kinds, prev.kinds);
    merge(s.clients, prev.clients);
    merge(s.agents, prev.agents);
    merge(s.countries, prev.countries);
  }

  /** Persist dirty day/cohort state and drop finished days from memory. */
  async flush(now: number): Promise<void> {
    await this.idle();
    const today = dayOf(now);
    for (const [key, s] of this.days) {
      if (s.dirty) {
        await this.loadDay(s);
        const doc: DayDoc = {
          hll: s.hll.toBase64(),
          events: s.events,
          newUsers: s.newUsers,
          kinds: Object.fromEntries(s.kinds),
          clients: Object.fromEntries(s.clients),
          agents: Object.fromEntries(s.agents),
          countries: Object.fromEntries(s.countries),
        };
        await this.docs.put(ANALYTICS_COLLECTION, key, doc);
        s.dirty = false;
      }
      if (s.day !== today) this.days.delete(key);
    }
    for (const [relayId, c] of this.cohorts) {
      for (const week of c.dirtyCohorts) {
        const doc = c.cohorts.get(week);
        if (doc) await this.docs.put(COHORT_COLLECTION, `${relayId}:${week}`, doc);
      }
      c.dirtyCohorts.clear();
      if (c.activeDirty && c.activeWeek >= 0) {
        await this.docs.put(WEEK_ACTIVE_COLLECTION, `${relayId}:${c.activeWeek}`, {
          members: [...c.active],
        });
        c.activeDirty = false;
      }
    }
  }

  /** Delete analytics older than the retention window. */
  async prune(now: number): Promise<number> {
    let removed = 0;
    const cutoffDay = dayOf(now - this.opts.retentionDays * 86400);
    const oldestWeek = weekOf(now) - COHORT_WEEKS;
    for (const [col, isOld] of [
      [ANALYTICS_COLLECTION, (k: string) => (k.split(':')[1] ?? '') < cutoffDay],
      [COHORT_COLLECTION, (k: string) => Number(k.split(':')[1]) < oldestWeek],
      [WEEK_ACTIVE_COLLECTION, (k: string) => Number(k.split(':')[1]) < weekOf(now) - 1],
    ] as const) {
      let cursor: string | undefined;
      const doomed: string[] = [];
      do {
        const page = await this.docs.list(col, { cursor, limit: 500 });
        for (const { key } of page.items) if (isOld(key)) doomed.push(key);
        cursor = page.cursor;
      } while (cursor);
      for (const k of doomed) if (await this.docs.delete(col, k)) removed++;
    }
    for (const c of this.cohorts.values()) {
      for (const [week, doc] of c.cohorts) {
        if (week >= oldestWeek) continue;
        for (const m of doc.members) if (c.firstSeen.get(m) === week) c.firstSeen.delete(m);
        c.cohorts.delete(week);
      }
    }
    return removed;
  }

  private async readDays(relayId: RelayId, now: number, n: number): Promise<Map<string, DayDoc>> {
    await this.flush(now);
    const out = new Map<string, DayDoc>();
    const from = dayOf(now - (n - 1) * 86400);
    const page = await this.docs.list<DayDoc>(ANALYTICS_COLLECTION, {
      prefix: `${relayId}:`,
      cursor: `${relayId}:${from}`.slice(0, -1),
      limit: n + 1,
    });
    for (const { key, value } of page.items) {
      const day = key.slice(relayId.length + 1);
      if (day >= from) out.set(day, value);
    }
    return out;
  }

  async storageByUser(
    relayId: RelayId,
    now: number,
    limit = 20,
  ): Promise<AnalyticsReport['storageByUser']> {
    const cached = this.storageCache.get(relayId);
    if (cached && now - cached.at < 600) return cached.rows.slice(0, limit);
    const by = new Map<string, { bytes: number; files: number }>();
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = await this.ports.blobIndex.list(relayId, { cursor, limit: 500 });
      for (const o of page.items) {
        const cur = by.get(o.pubkey) ?? { bytes: 0, files: 0 };
        cur.bytes += o.size;
        cur.files++;
        by.set(o.pubkey, cur);
      }
      scanned += page.items.length;
      cursor = page.cursor;
    } while (cursor && scanned < 100_000);
    const rows = [...by]
      .map(([pubkey, v]) => ({ pubkey, ...v }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 100);
    this.storageCache.set(relayId, { at: now, rows });
    return rows.slice(0, limit);
  }

  async report(
    relayId: RelayId,
    now: number,
    opts: { days?: number } = {},
  ): Promise<AnalyticsReport> {
    const span = Math.max(30, opts.days ?? 30);
    const docs = await this.readDays(relayId, now, span);
    const series: AnalyticsReport['dailyActive'] = [];
    const sketches: Array<{ day: string; hll: HyperLogLog }> = [];
    const kinds = new Map<string, number>();
    const clients = new Map<string, number>();
    const agents = new Map<string, number>();
    const countries = new Map<string, number>();
    const shown = opts.days ?? 30;
    for (let i = span - 1; i >= 0; i--) {
      const day = dayOf(now - i * 86400);
      const d = docs.get(day);
      const hll = d ? HyperLogLog.fromBase64(d.hll) : new HyperLogLog();
      sketches.push({ day, hll });
      if (i < shown) {
        series.push({
          day,
          users: d ? hll.count() : 0,
          newUsers: d?.newUsers ?? 0,
          events: d?.events ?? 0,
        });
      }
      if (d && i < 30) {
        for (const [k, v] of Object.entries(d.kinds)) kinds.set(k, (kinds.get(k) ?? 0) + v);
        for (const [k, v] of Object.entries(d.clients)) clients.set(k, (clients.get(k) ?? 0) + v);
        for (const [k, v] of Object.entries(d.agents)) agents.set(k, (agents.get(k) ?? 0) + v);
        for (const [k, v] of Object.entries(d.countries))
          countries.set(k, (countries.get(k) ?? 0) + v);
      }
    }
    const union = (n: number) => HyperLogLog.union(sketches.slice(-n).map((s) => s.hll)).count();
    const top = (m: Map<string, number>, n = 10) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

    const c = this.relayCohorts(relayId);
    await c.loaded;
    const thisWeek = weekOf(now);
    const cohorts = [...c.cohorts.values()]
      .filter((d) => d.week > thisWeek - 12)
      .sort((a, b) => a.week - b.week)
      .map((d) => ({
        weekStart: new Date(weekStart(d.week) * 1000).toISOString().slice(0, 10),
        size: d.members.length,
        retained: Array.from(
          { length: thisWeek - d.week },
          (_, i) => d.retained[String(i + 1)] ?? 0,
        ),
      }));

    return {
      relayId,
      activeUsers: { daily: union(1), weekly: union(7), monthly: union(30) },
      dailyActive: series,
      topKinds: top(kinds).map(([k, count]) => ({ kind: Number(k), count })),
      topClients: top(clients).map(([name, count]) => ({ name, count })),
      topUserAgents: top(agents).map(([name, count]) => ({ name, count })),
      countries: this.opts.geo
        ? top(countries, 50).map(([country, count]) => ({ country, count }))
        : [],
      cohorts,
      storageByUser: await this.storageByUser(relayId, now),
    };
  }
}
