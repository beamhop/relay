// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Numbers from the insights module (`insights.overview`, `insights.series`,
 * `insights.analytics` and the `insights.tick` live channel) for the Home
 * tiles and the Insights screen. Everything returns null when the module is
 * not installed; the tiles then fall back to numbers counted from the live
 * channel.
 */
import type { ApiClient } from './api/client.ts';
import type { CatalogAction } from './api/types.ts';

export interface Insights {
  connections: number;
  eventsPerSecond: number;
  errorsPerMinute: number;
  storageBytes: number | null;
  series: { connections: number[]; events: number[]; errors: number[] };
}

/** One relay in an insights live snapshot (newer fields are optional for older servers). */
export interface LiveRelay {
  relayId: string;
  connections: number;
  eventsPerSecond: number;
  rejectedPerSecond: number;
  rejectedByReason?: Record<string, number>;
  acceptRatio?: number;
  reqPerSecond?: number;
  p50Ms?: number;
  p95Ms?: number;
  errorsPerMinute: number;
  errorRate?: number;
  storageEvents?: number | null;
  storageBytes?: number | null;
  blobFiles?: number | null;
  blobBytes?: number | null;
}

export interface LiveSnapshot {
  at: number;
  relays: LiveRelay[];
  storage: { events: number; bytes: number } | null;
  disk?: { freeBytes: number; totalBytes: number } | null;
}

interface Overview {
  live: LiveSnapshot;
  storage: { bytes: number; events?: number } | null;
}

const SERIES: Array<[keyof Insights['series'], string]> = [
  ['connections', 'connections'],
  ['events', 'events.accepted'],
  ['errors', 'events.rejected'],
];

const has = (catalog: CatalogAction[], id: string) => catalog.find((a) => a.id === id);

export async function loadInsights(
  api: ApiClient,
  catalog: CatalogAction[],
): Promise<Insights | null> {
  const overview = has(catalog, 'insights.overview');
  if (!overview || !api.relayId) return null;
  const o = (await api.run<Overview>('insights.overview', {}, overview.scope)).output;
  const sum = (f: (r: LiveRelay) => number) =>
    Math.round(o.live.relays.reduce((a, r) => a + f(r), 0) * 10) / 10;
  const out: Insights = {
    connections: sum((r) => r.connections),
    eventsPerSecond: sum((r) => r.eventsPerSecond),
    errorsPerMinute: sum((r) => r.errorsPerMinute + r.rejectedPerSecond * 60),
    storageBytes: o.storage?.bytes ?? null,
    series: { connections: [], events: [], errors: [] },
  };
  if (has(catalog, 'insights.series')) {
    await Promise.all(
      SERIES.map(async ([k, metric]) => {
        out.series[k] = (await loadSeries(api, catalog, metric, 1)) ?? [];
      }),
    );
  }
  return out;
}

/** Points of one metric over the last `hours` (null without the module or on error). */
export async function loadSeries(
  api: ApiClient,
  catalog: CatalogAction[],
  metric: string,
  hours = 1,
  labels?: Record<string, string>,
): Promise<number[] | null> {
  const def = has(catalog, 'insights.series');
  if (!def) return null;
  try {
    const r = await api.run<{ points: Array<{ t: number; v: number }> }>(
      'insights.series',
      { metric, hours, ...(labels ? { labels } : {}) },
      def.scope,
    );
    return r.output.points.map((p) => p.v);
  } catch {
    return null;
  }
}

// ───────────────────────────── live ops ─────────────────────────────

/** Why posts were refused, as counted by the server (`normalizeReason`). */
export const REJECT_REASONS = [
  'duplicate',
  'pow',
  'blocked',
  'rate-limited',
  'invalid',
  'restricted',
  'mute',
  'error',
  'auth-required',
  'spam',
  'other',
] as const;

export interface LiveOps {
  connections: number;
  eventsPerSecond: number;
  rejectedPerSecond: number;
  /** Share of posts let in (0–1); 1 when idle. */
  acceptRatio: number;
  reqPerSecond: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorsPerMinute: number;
  /** Share of requests that hit an internal error (0–1). */
  errorRate: number | null;
  dbBytes: number | null;
  blobBytes: number | null;
  blobFiles: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** Refusals per second by reason, biggest first; `share` of all refusals. */
  reasons: Array<{ reason: string; perSecond: number; share: number }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sum a live snapshot over the relays it contains (one on a relay route). */
export function summarizeLive(snap: LiveSnapshot): LiveOps {
  const rs = snap.relays;
  const sum = (f: (r: LiveRelay) => number | null | undefined) =>
    rs.reduce((a, r) => a + (f(r) ?? 0), 0);
  const anyOf = (f: (r: LiveRelay) => number | null | undefined) =>
    rs.some((r) => typeof f(r) === 'number');
  const maxOf = (f: (r: LiveRelay) => number | undefined) =>
    anyOf(f) ? Math.max(...rs.map((r) => f(r) ?? 0)) : null;
  const accepted = sum((r) => r.eventsPerSecond);
  const rejected = sum((r) => r.rejectedPerSecond);
  const byReason = new Map<string, number>();
  for (const r of rs)
    for (const [k, v] of Object.entries(r.rejectedByReason ?? {}))
      byReason.set(k, (byReason.get(k) ?? 0) + v);
  const totalReasons = [...byReason.values()].reduce((a, b) => a + b, 0);
  const reqs = sum((r) => r.reqPerSecond);
  const errs = sum((r) => r.errorsPerMinute) / 60;
  const handled = accepted + rejected + reqs;
  const errorRate = anyOf((r) => r.errorRate)
    ? Math.max(...rs.map((r) => r.errorRate ?? 0))
    : handled > 0
      ? errs / handled
      : rs.length
        ? 0
        : null;
  // Per-relay storage when the server sends it; else the node-wide total.
  const dbBytes = anyOf((r) => r.storageBytes)
    ? sum((r) => r.storageBytes)
    : (snap.storage?.bytes ?? null);
  return {
    connections: sum((r) => r.connections),
    eventsPerSecond: r2(accepted),
    rejectedPerSecond: r2(rejected),
    acceptRatio: accepted + rejected > 0 ? r2(accepted / (accepted + rejected)) : 1,
    reqPerSecond: r2(reqs),
    p50Ms: maxOf((r) => r.p50Ms),
    p95Ms: maxOf((r) => r.p95Ms),
    errorsPerMinute: r2(errs * 60),
    errorRate: errorRate === null ? null : Math.round(errorRate * 10000) / 10000,
    dbBytes,
    blobBytes: anyOf((r) => r.blobBytes) ? sum((r) => r.blobBytes) : null,
    blobFiles: anyOf((r) => r.blobFiles) ? sum((r) => r.blobFiles) : null,
    diskFreeBytes: snap.disk?.freeBytes ?? null,
    diskTotalBytes: snap.disk?.totalBytes ?? null,
    reasons: [...byReason]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, v]) => ({
        reason,
        perSecond: r2(v),
        share: totalReasons ? Math.round((v / totalReasons) * 1000) / 1000 : 0,
      })),
  };
}

/** Rolling history of live values for the "right now" charts (newest last). */
export interface LiveHistory {
  events: number[];
  rejected: number[];
  p95: number[];
  errors: number[];
  connections: number[];
}

export const HISTORY_POINTS = 60;

export function emptyHistory(): LiveHistory {
  return { events: [], rejected: [], p95: [], errors: [], connections: [] };
}

/** Append one snapshot summary, keeping at most `max` points per series. */
export function pushHistory(h: LiveHistory, ops: LiveOps, max = HISTORY_POINTS): LiveHistory {
  const add = (xs: number[], v: number) => [...xs, v].slice(-max);
  return {
    events: add(h.events, ops.eventsPerSecond),
    rejected: add(h.rejected, ops.rejectedPerSecond),
    p95: add(h.p95, ops.p95Ms ?? 0),
    errors: add(h.errors, ops.errorsPerMinute),
    connections: add(h.connections, ops.connections),
  };
}

export async function loadOverview(
  api: ApiClient,
  catalog: CatalogAction[],
): Promise<{ snapshot: LiveSnapshot; ops: LiveOps } | null> {
  const def = has(catalog, 'insights.overview');
  if (!def || !api.relayId) return null;
  const o = (await api.run<Overview>('insights.overview', {}, def.scope)).output;
  const snapshot: LiveSnapshot = {
    ...o.live,
    storage:
      o.live.storage ??
      (o.storage ? { events: o.storage.events ?? 0, bytes: o.storage.bytes } : null),
  };
  return { snapshot, ops: summarizeLive(snapshot) };
}

/**
 * Listen to `insights.tick` on the live channel (relay-scoped) until `signal`
 * aborts. The shared Home live store does not ask for ticks, so the Insights
 * screen opens its own short-lived subscription.
 */
export function watchTicks(
  api: ApiClient,
  onTick: (s: LiveSnapshot) => void,
  signal: AbortSignal,
  onState?: (up: boolean) => void,
): void {
  void api.live(
    (msg) => {
      if (msg.event !== 'insights.tick' || !msg.data || typeof msg.data !== 'object') return;
      const s = msg.data as LiveSnapshot;
      if (Array.isArray(s.relays)) onTick(s);
    },
    { events: ['insights.tick'], relay: true, signal, ...(onState ? { onState } : {}) },
  );
}

// ───────────────────────────── community ─────────────────────────────

export interface CommunityReport {
  activeUsers: { daily: number; weekly: number; monthly: number };
  dailyActive: Array<{ day: string; users: number; newUsers: number; events: number }>;
  topKinds: Array<{ kind: number; name?: string; count: number }>;
  topClients: Array<{ name: string; count: number }>;
  topUserAgents: Array<{ name: string; count: number }>;
  countries: Array<{ country: string; count: number }>;
  cohorts: Array<{ weekStart: string; size: number; retained: number[] }>;
  storageByUser: Array<{ pubkey: string; bytes: number; files: number }>;
  storageTotal?: { bytes: number; files: number; users: number };
  geoSource?: 'runtime-header' | 'off';
}

export type CommunityResult =
  | { state: 'ok'; report: CommunityReport }
  | { state: 'absent' }
  | { state: 'off'; message: string };

export async function loadCommunity(
  api: ApiClient,
  catalog: CatalogAction[],
  days = 30,
): Promise<CommunityResult> {
  const def = has(catalog, 'insights.analytics');
  if (!def || !api.relayId) return { state: 'absent' };
  try {
    const r = await api.run<CommunityReport>('insights.analytics', { days }, def.scope);
    return { state: 'ok', report: r.output };
  } catch (err) {
    return { state: 'off', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Retention cohorts as percentages (0–100) for a heat table. */
export function cohortPercents(
  cohorts: CommunityReport['cohorts'],
): Array<{ weekStart: string; size: number; cells: number[] }> {
  return cohorts.map((c) => ({
    weekStart: c.weekStart,
    size: c.size,
    cells: c.retained.map((n) => (c.size ? Math.round((n / c.size) * 100) : 0)),
  }));
}

/** Merge NIP-89 client tags and User-Agent products into one "apps people use" list. */
export function topApps(
  report: Pick<CommunityReport, 'topClients' | 'topUserAgents'>,
  n = 8,
): Array<{ name: string; count: number; from: Array<'tag' | 'agent'> }> {
  const by = new Map<string, { name: string; count: number; from: Set<'tag' | 'agent'> }>();
  const add = (name: string, count: number, from: 'tag' | 'agent') => {
    const key = name.toLowerCase();
    const cur = by.get(key) ?? { name, count: 0, from: new Set() };
    cur.count = Math.max(cur.count, count);
    cur.from.add(from);
    by.set(key, cur);
  };
  for (const c of report.topClients) add(c.name, c.count, 'tag');
  for (const c of report.topUserAgents) add(c.name, c.count, 'agent');
  return [...by.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
    .map((x) => ({ name: x.name, count: x.count, from: [...x.from] }));
}

/** Plain country name for a 2-letter code ("DE" → "Germany"); the code when unknown. */
export function countryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Width (0–100) of a bar for `v` against the biggest value. */
export function barWidth(v: number, max: number): number {
  if (!(max > 0) || !(v > 0)) return 0;
  return Math.max(2, Math.round((v / max) * 100));
}
