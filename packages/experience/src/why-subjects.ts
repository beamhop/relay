// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Why?" for alerts, numbers and blocked people (§6.10, §8). Every lookup is
 * duck-typed against the providing module's service (`alerts`, `insights`,
 * `policy`) so this module never imports feature packages and degrades to a
 * plain "not available" answer when one is missing. Read-only.
 */
import type { Kernel, Principal, RelayConfig, RelayId } from '@beamhop/core';
import { npubToHex } from '@beamhop/policy';
import { plural } from './util.ts';
import type { RejectionRing, WhyAnswer, WhyOption } from './why.ts';

const notFound = (title: string, cause: string, options: WhyOption[] = []): WhyAnswer => ({
  title,
  cause,
  options,
  technical: [],
  found: false,
});

const isoTime = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
/** Plain date for people ("21 Oct 2026"). */
const plainDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

function ago(now: number, t: number): string {
  const s = Math.max(0, now - t);
  if (s < 90) return 'just now';
  if (s < 90 * 60) return `${Math.round(s / 60)} minutes ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ───────────────────────────── alerts ─────────────────────────────

/** Shape of `AlertRecord` from @beamhop/alerts (subset). */
export interface AlertLike {
  id: string;
  key: string;
  rule: string;
  category?: string;
  relayId: RelayId | null;
  severity: 'warning' | 'critical';
  title: string;
  body: string;
  technical: string;
  playbook?: string;
  firstAt: number;
  lastAt: number;
  count: number;
  resolvedAt?: number;
}

/** Duck-typed `kernel.use('alerts')`. */
export interface AlertsLike {
  engine?: {
    active?(): Promise<AlertLike[]>;
    history?(since: number, limit?: number): Promise<AlertLike[]>;
    rules?: Array<{ id: string; name: string }>;
    baseline?(relayId: RelayId, signal: string): BaselineLike;
  };
}

export interface BaselineLike {
  expected(t: number): { mean: number; std: number; n: number; seasonal: boolean };
}

export async function explainAlert(
  kernel: Kernel,
  relayId: RelayId | null,
  alertId: string,
): Promise<WhyAnswer> {
  const svc = kernel.use<AlertsLike>('alerts');
  if (!svc?.engine?.active)
    return notFound(
      'Alert',
      'Alerts are not turned on for this server, so there is nothing to explain.',
    );
  const now = kernel.ports.clock.now();
  const match = (a: AlertLike) =>
    (a.id === alertId || a.key === alertId) && (!relayId || !a.relayId || a.relayId === relayId);
  let alert = (await svc.engine.active()).find(match);
  let resolved = false;
  if (!alert && svc.engine.history) {
    alert = (await svc.engine.history(now - 30 * 86400, 500)).find(match);
    resolved = !!alert;
  }
  if (!alert)
    return notFound(
      'Alert',
      'This alert is no longer on record — it was resolved a while ago or the id is wrong.',
      [{ label: 'See current alerts', screen: '/activity/alerts' }],
    );
  const ruleName = svc.engine.rules?.find((r) => r.id === alert.rule)?.name ?? alert.rule;
  const options: WhyOption[] = [];
  if (alert.playbook) options.push({ label: 'Step-by-step help', playbook: alert.playbook });
  if (!resolved) {
    const target = { rule: alert.rule, relayId: alert.relayId };
    options.push({
      label: 'Quiet this alert for an hour',
      actionId: 'alerts.snooze',
      input: { ...target, minutes: 60 },
    });
    options.push({ label: `Stop “${ruleName}” alerts`, actionId: 'alerts.mute', input: target });
  }
  options.push({ label: 'See all alerts', screen: '/activity/alerts' });
  const when =
    alert.count > 1
      ? `It first fired ${ago(now, alert.firstAt)} and has fired ${plural(alert.count, 'time')} since.`
      : `It fired ${ago(now, alert.firstAt)}.`;
  const state = resolved
    ? ` It has since cleared${alert.resolvedAt ? ` (${ago(now, alert.resolvedAt)})` : ''}.`
    : '';
  return {
    title: alert.title,
    cause: `${alert.body} ${when}${state}`.trim(),
    options,
    technical: [
      `alert ${alert.id} rule=${alert.rule} severity=${alert.severity} relay=${alert.relayId ?? '*'}`,
      alert.technical,
      `firstAt=${isoTime(alert.firstAt)} lastAt=${isoTime(alert.lastAt)} count=${alert.count}${alert.resolvedAt ? ` resolvedAt=${isoTime(alert.resolvedAt)}` : ''}`,
    ],
    found: true,
  };
}

// ───────────────────────────── metrics ─────────────────────────────

/** Duck-typed live snapshot from `kernel.use('insights').live()`. */
interface LiveLike {
  relays: Array<{ relayId: RelayId } & Record<string, unknown>>;
  storage?: { events: number; bytes: number } | null;
  disk?: { freeBytes: number; totalBytes: number } | null;
}

interface InsightsLike {
  live?(relayId?: RelayId): LiveLike;
}

export type MetricUnit =
  | 'count'
  | 'perSecond'
  | 'perMinute'
  | 'ms'
  | 'bytes'
  | 'ratio'
  | 'score'
  | 'people';

export interface MetricInfo {
  /** Canonical id. */
  id: string;
  title: string;
  /** What the number means, plainly. */
  plain: string;
  /** What is normal (used when there is no learned baseline). */
  normal: string;
  unit: MetricUnit;
  options: WhyOption[];
  technical: string;
  /** Read the current value from the live snapshot. */
  current?: (live: LiveLike, relayId: RelayId | null) => number | undefined;
  /** Learned baseline (alerts module) signal and scale to this metric's unit. */
  baseline?: { signal: string; scale: number };
}

function relayField(field: string) {
  return (live: LiveLike, relayId: RelayId | null) => {
    const rows = live.relays.filter((r) => !relayId || r.relayId === relayId);
    if (!rows.length) return undefined;
    let sum = 0;
    for (const r of rows) {
      const v = r[field];
      if (typeof v !== 'number') return undefined;
      sum += v;
    }
    return field === 'p50Ms' ||
      field === 'p95Ms' ||
      field === 'acceptRatio' ||
      field === 'errorRate'
      ? sum / rows.length
      : sum;
  };
}

const SLOW: WhyOption = { label: 'My relay is slow — help', playbook: 'relay-is-slow' };
const SPAM: WhyOption = { label: 'Spam attack help', playbook: 'spam-attack' };
const DISK: WhyOption = { label: 'Disk is filling up — help', playbook: 'disk-full' };
const CHARTS: WhyOption = { label: 'Open the charts', screen: '/insights' };

export const METRIC_INFO: MetricInfo[] = [
  {
    id: 'connections',
    title: 'Connections',
    plain:
      'How many apps are connected to your relay right now. Each open app (phone, desktop, bot) counts once.',
    normal:
      'It goes up and down with the time of day. Sudden jumps can be a popular post — or a bot opening many connections.',
    unit: 'count',
    options: [CHARTS, { label: 'Change the per-person limits', screen: '/settings/goals' }],
    technical:
      'gauge `connections` (open WebSockets), set from relay.engine.connectionCount() every flush',
    current: relayField('connections'),
    baseline: { signal: 'connections', scale: 1 },
  },
  {
    id: 'events.accepted',
    title: 'Posts per second',
    plain:
      'How many new posts (and other items like reactions and profile updates) your relay accepted per second over the last minute.',
    normal:
      'Small community relays often sit well under 1 per second; bursts are normal when people are active.',
    unit: 'perSecond',
    options: [CHARTS, { label: 'See what is coming in', screen: '/activity/stream' }],
    technical: 'counter `events.accepted` rate over the last 60 s (insights live ring)',
    current: relayField('eventsPerSecond'),
    baseline: { signal: 'acceptedPerMin', scale: 1 / 60 },
  },
  {
    id: 'events.rejected',
    title: 'Refused posts',
    plain:
      'Posts your relay said no to per second — because of your rules, spam filters, size limits or because the sender is blocked.',
    normal:
      'A few refusals are normal. A sudden rise usually means a spam wave or an app with a wrong clock.',
    unit: 'perSecond',
    options: [CHARTS, { label: 'See recently refused posts', screen: '/activity/stream' }, SPAM],
    technical: 'counter `events.rejected` rate (60 s), labelled by reason prefix',
    current: relayField('rejectedPerSecond'),
    baseline: { signal: 'rejectedPerMin', scale: 1 / 60 },
  },
  {
    id: 'accept-ratio',
    title: 'Let in vs refused',
    plain: 'Of all posts sent to your relay in the last minute, the share that was let in.',
    normal:
      'Usually well above 90%. A low share means many posts are being refused — check the reasons.',
    unit: 'ratio',
    options: [CHARTS, SPAM],
    technical: 'accepted / (accepted + rejected) over 60 s; 1 when idle',
    current: relayField('acceptRatio'),
  },
  {
    id: 'errors',
    title: 'Problems per minute',
    plain:
      'How often something went wrong inside your relay (not refusals — real errors like a storage hiccup).',
    normal:
      'This should be 0 almost all the time. Anything above a few per minute is worth a look.',
    unit: 'perMinute',
    options: [CHARTS, { label: 'See recent activity', screen: '/activity/stream' }, SLOW],
    technical: 'counter `errors` (bus `error` events, by source) × 60 over the last 60 s',
    current: relayField('errorsPerMinute'),
    baseline: { signal: 'errorsPerMin', scale: 1 },
  },
  {
    id: 'error-rate',
    title: 'Error rate',
    plain: 'The share of requests (posts and reads) that ran into an internal problem.',
    normal: 'Should be 0%. Above 1% means something is wrong — usually storage or a plugin.',
    unit: 'ratio',
    options: [CHARTS, SLOW],
    technical: 'errors / (accepted + rejected + REQs) over 60 s',
    current: relayField('errorRate'),
  },
  {
    id: 'latency.p50',
    title: 'Typical response time',
    plain:
      'How long your relay takes to handle a typical post. Half of all posts are handled faster than this.',
    normal: 'A few milliseconds is normal. Over 100 ms feels sluggish.',
    unit: 'ms',
    options: [CHARTS, SLOW],
    technical: 'p50 of summary `event.latency` (quantile sketch, last 5 min)',
    current: relayField('p50Ms'),
  },
  {
    id: 'latency.p95',
    title: 'Slowest response times',
    plain: 'How long the slowest posts take: 95 out of 100 posts are handled faster than this.',
    normal: 'Under 100 ms is good. Over 500 ms means people will notice delays.',
    unit: 'ms',
    options: [CHARTS, SLOW],
    technical: 'p95 of summary `event.latency` (quantile sketch, last 5 min)',
    current: relayField('p95Ms'),
  },
  {
    id: 'req.served',
    title: 'Reads per second',
    plain: 'How many times per second apps asked your relay for posts (feeds, profiles, replies).',
    normal: 'Usually much higher than posts per second — people read more than they write.',
    unit: 'perSecond',
    options: [CHARTS],
    technical: 'counter `req.served` rate over 60 s',
    current: relayField('reqPerSecond'),
  },
  {
    id: 'db.size',
    title: 'Database size',
    plain: 'How much space the stored posts take up in your database.',
    normal: 'It grows slowly as people post. How long posts are kept is set by your Storage goal.',
    unit: 'bytes',
    options: [{ label: 'Keep posts for less time', screen: '/settings/goals' }, DISK],
    technical: 'events.stats().bytes (approximate; refreshed every 60 s)',
    current: (live) => live.storage?.bytes,
  },
  {
    id: 'storage.used',
    title: 'Storage used',
    plain: 'Space used on this server by posts and uploaded files together.',
    normal: 'Grows over time. Beamhop warns you well before the disk is full.',
    unit: 'bytes',
    options: [
      { label: 'Change how long things are kept', screen: '/settings/goals' },
      { label: 'See who uses the most', screen: '/insights' },
      DISK,
    ],
    technical: 'events.stats().bytes + blob bytes (blobIndex sizes)',
    current: (live, relayId) => {
      const blobs = relayField('blobBytes')(live, relayId);
      const db = live.storage?.bytes;
      return db === undefined && blobs === undefined ? undefined : (db ?? 0) + (blobs ?? 0);
    },
  },
  {
    id: 'blobs.bytes',
    title: 'Files stored',
    plain: 'Space taken by photos, videos and other files people uploaded.',
    normal: 'Grows with uploads. Per-person limits come from your Media goal.',
    unit: 'bytes',
    options: [
      { label: 'Change the media limits', screen: '/settings/goals' },
      { label: 'See who uses the most', screen: '/insights' },
    ],
    technical: 'sum of blobIndex ownership sizes for this relay (refreshed every 10 min)',
    current: relayField('blobBytes'),
  },
  {
    id: 'storage.hot',
    title: 'Fast storage',
    plain: 'Files kept on fast storage because people opened them recently.',
    normal: 'Recent and popular files live here; older ones move to cheaper storage automatically.',
    unit: 'bytes',
    options: [{ label: 'Media settings', screen: '/settings/media' }],
    technical: 'blob bytes on the primary (hot) BlobStore tier',
  },
  {
    id: 'storage.cold',
    title: 'Archive storage',
    plain:
      'Older files moved to cheaper, slower storage. They still open — just a little slower the first time.',
    normal: 'Most files end up here over time; that keeps costs down.',
    unit: 'bytes',
    options: [{ label: 'Media settings', screen: '/settings/media' }],
    technical: 'blob bytes on the archive (cold) BlobStore tier',
  },
  {
    id: 'disk.free',
    title: 'Free disk space',
    plain: 'How much room is left on this server’s disk.',
    normal: 'Keep at least 10–20% free. Beamhop warns you before it runs out.',
    unit: 'bytes',
    options: [DISK, { label: 'Keep posts for less time', screen: '/settings/goals' }],
    technical: 'runtime disk provider (statfs) — freeBytes',
    current: (live) => live.disk?.freeBytes,
  },
  {
    id: 'health.score',
    title: 'Health score',
    plain:
      'One number from 0 to 100 that sums up all of Beamhop’s checks (storage, backups, speed, moderation, security).',
    normal:
      '80 or more is healthy. The worst check pulls the score down, so one problem is enough to lower it.',
    unit: 'score',
    options: [{ label: 'See what is checked', screen: '/' }],
    technical: 'weighted mean of kernel.health check scores, capped by the worst check',
  },
  {
    id: 'active-users.daily',
    title: 'Active today',
    plain: 'Different people who posted, signed in or uploaded on your relay today.',
    normal: 'It depends on your community. Watch the trend rather than the number.',
    unit: 'people',
    options: [CHARTS],
    technical: 'HyperLogLog (p=12, ±1.6%) of active pubkeys for the current UTC day',
  },
  {
    id: 'active-users.weekly',
    title: 'Active this week',
    plain: 'Different people active in the last 7 days.',
    normal: 'Usually 2–4× the daily number in a healthy community.',
    unit: 'people',
    options: [CHARTS],
    technical: 'union of the last 7 daily HyperLogLogs',
  },
  {
    id: 'active-users.monthly',
    title: 'Active this month',
    plain: 'Different people active in the last 30 days.',
    normal:
      'If this keeps growing while the daily number stays flat, people try your relay but do not stay.',
    unit: 'people',
    options: [CHARTS, { label: 'Share your relay', screen: '/launch' }],
    technical: 'union of the last 30 daily HyperLogLogs',
  },
  {
    id: 'retention',
    title: 'People who come back',
    plain:
      'Of the people who first showed up in a given week, how many were active again in later weeks.',
    normal:
      'Losing half after the first week is common. Steady rows further right mean a sticky community.',
    unit: 'ratio',
    options: [CHARTS, { label: 'Share your relay', screen: '/launch' }],
    technical:
      'weekly first-seen cohorts (insights.cohorts); retained[n] = active in week n after joining',
  },
  {
    id: 'blobs.uploaded',
    title: 'Uploads per minute',
    plain: 'Files uploaded to your relay per minute.',
    normal: 'Bursty — someone sharing an album can cause a spike.',
    unit: 'perMinute',
    options: [CHARTS, { label: 'Open Media', screen: '/media' }],
    technical: 'counter `blobs.uploaded` rate × 60 (BUD-02 PUT /upload)',
    current: relayField('blobUploadsPerMinute'),
  },
];

const METRIC_ALIASES: Record<string, string> = {
  conn: 'connections',
  'connections.open': 'connections',
  events: 'events.accepted',
  eventsPerSecond: 'events.accepted',
  'events-per-second': 'events.accepted',
  'events.per_second': 'events.accepted',
  posts: 'events.accepted',
  rejected: 'events.rejected',
  rejectedPerSecond: 'events.rejected',
  rejections: 'events.rejected',
  acceptRatio: 'accept-ratio',
  'accept.ratio': 'accept-ratio',
  'accept-reject': 'accept-ratio',
  errorsPerMinute: 'errors',
  'errors.per_minute': 'errors',
  errorRate: 'error-rate',
  'errors.rate': 'error-rate',
  p50: 'latency.p50',
  p50Ms: 'latency.p50',
  'latency.median': 'latency.p50',
  p95: 'latency.p95',
  p95Ms: 'latency.p95',
  latency: 'latency.p95',
  reqPerSecond: 'req.served',
  reads: 'req.served',
  'storage.bytes': 'db.size',
  dbSize: 'db.size',
  'db.bytes': 'db.size',
  database: 'db.size',
  storage: 'storage.used',
  storageBytes: 'storage.used',
  'storage-used': 'storage.used',
  'blobs.storage': 'blobs.bytes',
  blobBytes: 'blobs.bytes',
  media: 'blobs.bytes',
  'storage.files': 'blobs.bytes',
  'storage.blobs': 'blobs.bytes',
  hot: 'storage.hot',
  cold: 'storage.cold',
  disk: 'disk.free',
  diskFree: 'disk.free',
  health: 'health.score',
  score: 'health.score',
  dau: 'active-users.daily',
  'active-users': 'active-users.daily',
  'users.daily': 'active-users.daily',
  activeUsers: 'active-users.daily',
  wau: 'active-users.weekly',
  'users.weekly': 'active-users.weekly',
  mau: 'active-users.monthly',
  'users.monthly': 'active-users.monthly',
  cohorts: 'retention',
  uploads: 'blobs.uploaded',
  blobUploadsPerMinute: 'blobs.uploaded',
};

export function metricInfo(id: string): MetricInfo | undefined {
  const canon = METRIC_ALIASES[id] ?? id;
  return METRIC_INFO.find((m) => m.id === canon);
}

export function formatBytesPlain(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

export function formatMetric(unit: MetricUnit, v: number): string {
  const r = (n: number) => String(Math.round(n * 100) / 100);
  switch (unit) {
    case 'bytes':
      return formatBytesPlain(v);
    case 'ratio':
      return `${Math.round(v * 1000) / 10}%`;
    case 'ms':
      return `${r(v)} ms`;
    case 'perSecond':
      return `${r(v)} per second`;
    case 'perMinute':
      return `${r(v)} per minute`;
    case 'score':
      return `${Math.round(v)} out of 100`;
    case 'people':
      return plural(Math.round(v), 'person', 'people');
    default:
      return r(v);
  }
}

export function explainMetric(
  kernel: Kernel,
  relayId: RelayId | null,
  metric: string,
  value?: number,
): WhyAnswer {
  const info = metricInfo(metric);
  if (!info)
    return notFound(
      'This number',
      `There is no explanation for “${metric}” yet. The charts show how it changed over time.`,
      [CHARTS],
    );
  const now = kernel.ports.clock.now();
  const insights = kernel.use<InsightsLike>('insights');
  let current = value;
  let source = value === undefined ? 'unknown' : 'shown in the app';
  if (current === undefined && info.current && insights?.live) {
    try {
      current = info.current(insights.live(relayId ?? undefined), relayId);
      if (current !== undefined) source = 'insights.live()';
    } catch {
      current = undefined;
    }
  }
  const technical = [
    `metric ${info.id}${info.id !== metric ? ` (asked as “${metric}”)` : ''}`,
    info.technical,
  ];
  if (current !== undefined) technical.push(`value = ${current} (${source})`);

  // "What's normal": a learned baseline (alerts module) beats the generic sentence.
  let normal = info.normal;
  const rid = relayId ?? kernel.config().relays[0]?.id;
  const alerts = kernel.use<AlertsLike>('alerts');
  if (info.baseline && rid && typeof alerts?.engine?.baseline === 'function') {
    try {
      const exp = alerts.engine.baseline(rid, info.baseline.signal).expected(now);
      if (exp.n >= 30) {
        const s = info.baseline.scale;
        const mean = exp.mean * s;
        const lo = Math.max(0, (exp.mean - 2 * exp.std) * s);
        const hi = (exp.mean + 2 * exp.std) * s;
        const when = exp.seasonal ? 'at this time of the week' : 'lately';
        normal = `Usually about ${formatMetric(info.unit, mean)} ${when} (normal range ${formatMetric(info.unit, lo)} to ${formatMetric(info.unit, hi)}).`;
        if (current !== undefined) {
          if (current > hi) normal += ' Right now it is higher than usual.';
          else if (current < lo) normal += ' Right now it is lower than usual.';
          else normal += ' Right now it is within the normal range.';
        }
        technical.push(
          `baseline alerts.${info.baseline.signal}: mean=${Math.round(exp.mean * 1000) / 1000} std=${Math.round(exp.std * 1000) / 1000} n=${exp.n} seasonal=${exp.seasonal} (×${Math.round(s * 10000) / 10000})`,
        );
      }
    } catch {
      // no baseline: keep the generic sentence
    }
  }
  const now_ = current !== undefined ? ` Right now: ${formatMetric(info.unit, current)}.` : '';
  return {
    title: info.title,
    cause: `${info.plain}${now_} ${normal}`,
    options: info.options,
    technical,
    found: true,
  };
}

// ───────────────────────────── blocked people ─────────────────────────────

/** Duck-typed `kernel.use('policy')` (subset of PolicyService). */
interface PolicyLike {
  state?: {
    getBan?(
      relayId: RelayId,
      pubkey: string,
    ): Promise<{ at: number; by: string; reason?: string } | undefined>;
    getMute?(
      relayId: RelayId,
      pubkey: string,
    ): Promise<{ at: number; by: string; until?: number } | undefined>;
    getAllow?(
      relayId: RelayId,
      pubkey: string,
    ): Promise<{ addedAt: number; by: string; via: string } | undefined>;
  };
  resolveTier?(relayId: RelayId, pubkey: string): Promise<string>;
  wotMember?(
    relayId: RelayId,
    pubkey: string,
  ): Promise<{ depth: number; followers: number } | undefined>;
}

function who(by: string, principal?: Principal): string {
  if (principal && by === principal.id) return 'you';
  if (by === 'system') return 'Beamhop automatically';
  if (by.startsWith('file:')) return 'the settings file';
  return 'an admin';
}

const ACCESS_TEXT: Record<string, { cause: string; options: (pk: string) => WhyOption[] }> = {
  'policy.allowlist': {
    cause: 'Only members can post on your relay, and this person is not a member.',
    options: (pk) => [
      {
        label: 'Add this person as a member',
        actionId: 'access.add-allowlist',
        input: { pubkeys: [pk] },
      },
      { label: 'Create an invite', actionId: 'access.create-invite', input: {} },
      { label: 'Change who can post', screen: '/settings/access' },
    ],
  },
  'policy.wot': {
    cause:
      'Your relay lets in people trusted by your network (people you follow, and people they follow). This person is not connected closely enough.',
    options: (pk) => [
      {
        label: 'Let this person in anyway',
        actionId: 'access.add-allowlist',
        input: { pubkeys: [pk] },
      },
      { label: 'Change who can post', screen: '/settings/access' },
    ],
  },
};

export async function explainBlock(
  kernel: Kernel,
  relayId: RelayId | null,
  rawPubkey: string,
  ring: RejectionRing,
  principal?: Principal,
): Promise<WhyAnswer> {
  const raw = rawPubkey.trim();
  const pubkey = raw.startsWith('npub1') ? (npubToHex(raw) ?? '') : raw.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey))
    return notFound(
      'This person',
      'That does not look like a person’s key, so there is nothing to check.',
    );
  const rid = relayId ?? kernel.config().relays[0]?.id;
  const relay: RelayConfig | undefined = rid ? kernel.relay(rid) : undefined;
  if (!rid || !relay) return notFound('This person', 'There is no relay yet.');
  const now = kernel.ports.clock.now();
  const policy = kernel.use<PolicyLike>('policy');
  const technical: string[] = [`pubkey ${pubkey}`, `relay ${rid} access.mode=${relay.access.mode}`];
  const reasons: string[] = [];
  const options: WhyOption[] = [];
  let title = '';

  const ban = await policy?.state?.getBan?.(rid, pubkey);
  if (ban) {
    title = 'Blocked';
    reasons.push(
      `This person is blocked on your relay — ${who(ban.by, principal)} blocked them on ${plainDate(ban.at)}${ban.reason ? ` (“${ban.reason}”)` : ''}. Their posts are refused.`,
    );
    options.push({
      label: 'Unblock',
      actionId: 'moderation.unban-pubkey',
      input: { pubkeys: [pubkey] },
    });
    technical.push(
      `policy.bans: at=${isoTime(ban.at)} by=${ban.by}${ban.reason ? ` reason=${ban.reason}` : ''}`,
    );
  }

  const mute = await policy?.state?.getMute?.(rid, pubkey);
  if (mute && (mute.until === undefined || mute.until > now)) {
    title ||= 'Muted';
    reasons.push(
      `This person is muted — ${who(mute.by, principal)} muted them on ${plainDate(mute.at)}${mute.until ? `, until ${plainDate(mute.until)}` : ''}. Their posts look sent to them, but nobody else sees them.`,
    );
    options.push({
      label: 'Unmute',
      actionId: 'moderation.unmute-pubkey',
      input: { pubkeys: [pubkey] },
    });
    technical.push(
      `policy.mutes: at=${isoTime(mute.at)} by=${mute.by} until=${mute.until ? isoTime(mute.until) : '∞'}`,
    );
  }

  // Who-can-post chain (allowlist, web of trust, SSO binding, plugins…): first answer wins.
  if (!ban) {
    for (const r of kernel.access) {
      if (!r.canWrite) continue;
      let v: boolean | undefined;
      try {
        v = await r.canWrite(rid, pubkey);
      } catch {
        v = undefined;
      }
      if (v === undefined) continue;
      technical.push(`access chain: ${r.id} → canWrite=${v}`);
      if (v === false) {
        title ||= 'Not allowed to post';
        const known = ACCESS_TEXT[r.id];
        reasons.push(
          known?.cause ??
            'A sign-in rule on your relay does not allow this person to post (for example, company sign-in).',
        );
        options.push(
          ...(known?.options(pubkey) ?? [
            { label: 'Change who can post', screen: '/settings/access' },
          ]),
        );
        if (r.id === 'policy.wot' && policy?.wotMember) {
          const m = await policy.wotMember(rid, pubkey).catch(() => undefined);
          technical.push(
            `wot: ${m ? `depth=${m.depth} followers=${m.followers}` : 'not in graph'}`,
          );
        }
      }
      break;
    }
  }

  if (policy?.resolveTier) {
    const tier = await policy.resolveTier(rid, pubkey).catch(() => undefined);
    if (tier) technical.push(`tier = ${tier}`);
  }

  // Their latest refused post, if any (in-memory, since restart).
  const last = ring.recent(500, rid).find((x) => x.pubkey === pubkey);
  if (last) {
    technical.push(
      `last refusal: ${last.by ?? 'unknown'} → "${last.reason}" at ${isoTime(last.at)} (event ${last.eventId})`,
    );
    if (!reasons.length) {
      title = last.decision === 'hold' ? 'Post held for review' : 'Post refused';
      reasons.push(
        `Nothing blocks this person as such, but their latest post was ${last.decision === 'hold' ? 'held for review' : 'refused'} ${ago(now, last.at)}.`,
      );
      options.push({ label: 'Why was it refused?', screen: '/activity/stream' });
    }
  }

  if (!reasons.length)
    return {
      ...notFound(
        'Not blocked',
        'Nothing is stopping this person right now: they are not blocked or muted, and your who-can-post rules let them in.',
      ),
      technical,
    };
  return { title, cause: reasons.join(' '), options, technical, found: true };
}
