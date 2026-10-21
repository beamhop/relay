// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Goals engine (§6.7). Pure functions that turn the five 0..100 goal sliders
 * into concrete limits, then apply the subject's tier, then the admin's
 * explicit `limits` overrides (recorded in `overridden`).
 *
 * Every mapping is a 5-anchor table (slider 0, 25, 50, 75, 100) interpolated
 * linearly, so each value is monotonic in its slider by construction.
 */
import type { EffectiveLimits, Goals, LimitsOverride, RelayConfig } from '@beamhop/core';
import { formatBytes, formatDuration } from './util.ts';

export type GoalName = keyof Goals;
export type Anchors = readonly [number, number, number, number, number];

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** Piecewise-linear interpolation over anchors at 0/25/50/75/100. */
export function interpolate(anchors: Anchors, x: number): number {
  const c = Math.min(100, Math.max(0, Number.isFinite(x) ? x : 0));
  const seg = Math.min(3, Math.floor(c / 25));
  const t = (c - seg * 25) / 25;
  const a = anchors[seg] as number;
  const b = anchors[seg + 1] as number;
  return a + (b - a) * t;
}

type Rounder = (v: number) => number;
const int: Rounder = (v) => Math.round(v);
const kb: Rounder = (v) => Math.round(v / KB) * KB;
const mb: Rounder = (v) => Math.round(v / MB) * MB;
const hundredth: Rounder = (v) => Math.round(v * 100) / 100;
/** Puzzles under 4 bits stop no one but still break clients without PoW support: treat as off. */
const pow: Rounder = (v) => (v < 4 ? 0 : Math.round(v));

export interface GoalMapping {
  goal: GoalName;
  anchors: Anchors;
  round: Rounder;
  /** Plain-language explanation of what the value means. */
  plain: (v: number) => string;
  technical: string;
}

/** Fields of EffectiveLimits that are derived from goals. */
export type GoalDrivenField =
  | 'eventsPerMinute'
  | 'reqPerMinute'
  | 'minPowDifficulty'
  | 'newKeyPowDifficulty'
  | 'maxCreatedAtFutureSeconds'
  | 'spamThreshold'
  | 'maxEventBytes'
  | 'defaultBlobQuotaBytes'
  | 'maxBlobBytes'
  | 'maxSubscriptions'
  | 'maxFilters'
  | 'maxLimit';

/**
 * The mapping tables. Direction per goal:
 * - openness 0 = strict → 100 = open (more posts allowed, less PoW)
 * - spamTolerance 0 = aggressive → 100 = relaxed (higher spam score needed to flag)
 * - storage 0 = lean → 100 = keep everything
 * - media 0 = basic → 100 = rich
 * - speedVsCost 0 = cheapest → 100 = fastest
 */
export const GOAL_TABLE: Record<GoalDrivenField, GoalMapping> = {
  eventsPerMinute: {
    goal: 'openness',
    anchors: [6, 20, 60, 120, 300],
    round: int,
    plain: (v) => `Each person can post up to ${v} times a minute`,
    technical: 'Token bucket per pubkey (and ×4 per hashed IP) on EVENT',
  },
  reqPerMinute: {
    goal: 'openness',
    anchors: [30, 60, 120, 240, 600],
    round: int,
    plain: (v) => `Each connection can ask for data up to ${v} times a minute`,
    technical: 'Token bucket per hashed IP on REQ/COUNT',
  },
  minPowDifficulty: {
    goal: 'openness',
    anchors: [12, 4, 0, 0, 0],
    round: pow,
    plain: (v) =>
      v === 0 ? 'No proof-of-work puzzle for posts' : `Every post must solve a puzzle (level ${v})`,
    technical: 'NIP-13 minimum leading zero bits of the event id',
  },
  newKeyPowDifficulty: {
    goal: 'openness',
    anchors: [24, 16, 8, 0, 0],
    round: pow,
    plain: (v) =>
      v === 0
        ? 'New accounts are treated like everyone else'
        : `New accounts must solve a harder puzzle (level ${v})`,
    technical: 'NIP-13 leading zero bits for pubkeys first seen recently',
  },
  maxCreatedAtFutureSeconds: {
    goal: 'openness',
    anchors: [60, 300, 600, 900, 3600],
    round: int,
    plain: (v) => `Posts dated more than ${formatDuration(v)} in the future are refused`,
    technical: 'created_at upper bound relative to relay clock',
  },
  spamThreshold: {
    goal: 'spamTolerance',
    anchors: [0.5, 0.65, 0.8, 0.9, 0.97],
    round: hundredth,
    plain: (v) => `Content is treated as spam when it looks ${Math.round(v * 100)}% suspicious`,
    technical: 'Spam score threshold (0..1) used by content heuristics and plugins',
  },
  maxEventBytes: {
    goal: 'storage',
    anchors: [32 * KB, 64 * KB, 96 * KB, 128 * KB, 512 * KB],
    round: kb,
    plain: (v) => `A single post can be up to ${formatBytes(v)}`,
    technical: 'Max serialized event size in bytes',
  },
  defaultBlobQuotaBytes: {
    goal: 'storage',
    anchors: [100 * MB, 500 * MB, 1 * GB, 5 * GB, 20 * GB],
    round: mb,
    plain: (v) => `Each person can store ${formatBytes(v)} of media`,
    technical: 'Blossom per-pubkey quota (BUD-02 uploads)',
  },
  maxBlobBytes: {
    goal: 'media',
    anchors: [5 * MB, 20 * MB, 50 * MB, 200 * MB, 1 * GB],
    round: mb,
    plain: (v) => `A single file can be up to ${formatBytes(v)}`,
    technical: 'Blossom max blob size (BUD-06 upload requirements)',
  },
  maxSubscriptions: {
    goal: 'speedVsCost',
    anchors: [10, 20, 40, 80, 150],
    round: int,
    plain: (v) => `Each connection can follow ${v} live feeds at once`,
    technical: 'Max concurrent REQ subscriptions per connection (NIP-11 max_subscriptions)',
  },
  maxFilters: {
    goal: 'speedVsCost',
    anchors: [5, 8, 10, 15, 20],
    round: int,
    plain: (v) => `Each request can contain ${v} searches`,
    technical: 'Max filters per REQ (NIP-11 max_filters)',
  },
  maxLimit: {
    goal: 'speedVsCost',
    anchors: [100, 250, 500, 1000, 2000],
    round: int,
    plain: (v) => `Each search returns at most ${v} posts`,
    technical: 'Max `limit` per filter (NIP-11 max_limit)',
  },
};

/** Retention: storage slider ≥ KEEP_FOREVER_AT means "keep forever" (undefined). */
export const RETENTION_ANCHORS: Anchors = [30, 90, 365, 1095, 3650];
export const KEEP_FOREVER_AT = 95;

export function retentionDaysFor(storage: number): number | undefined {
  if (storage >= KEEP_FOREVER_AT) return undefined;
  return Math.round(interpolate(RETENTION_ANCHORS, storage));
}

/** Spam/abuse settings derived from goals (policy-internal; not part of EffectiveLimits). */
export interface SpamSettings {
  /** Exact-duplicate memory window. */
  duplicateWindowSeconds: number;
  /** SimHash Hamming distance treated as near-duplicate (0 = off). */
  nearDuplicateDistance: number;
  /** Links allowed per post. */
  maxLinks: number;
  /** A pubkey counts as "new" for this many days after it is first seen. */
  newKeyDays: number;
}

export const SPAM_TABLE: Record<
  keyof SpamSettings,
  GoalMapping & { goal: 'spamTolerance' | 'openness' }
> = {
  duplicateWindowSeconds: {
    goal: 'spamTolerance',
    anchors: [3600, 1800, 900, 300, 60],
    round: int,
    plain: (v) => `The same text posted again within ${formatDuration(v)} is refused`,
    technical: 'Exact normalized-content hash sliding window',
  },
  nearDuplicateDistance: {
    goal: 'spamTolerance',
    anchors: [8, 6, 4, 2, 0],
    round: int,
    plain: (v) =>
      v === 0
        ? 'Near-copies of recent posts are allowed'
        : 'Near-copies of recent posts are held for review',
    technical: '64-bit SimHash over word 3-shingles; Hamming distance threshold',
  },
  maxLinks: {
    goal: 'spamTolerance',
    anchors: [2, 3, 5, 10, 25],
    round: int,
    plain: (v) => `A post can contain up to ${v} links`,
    technical: 'Count of http(s) URLs in content',
  },
  newKeyDays: {
    goal: 'openness',
    anchors: [14, 7, 3, 1, 0],
    round: int,
    plain: (v) =>
      v === 0 ? 'New accounts get no extra checks' : `Accounts count as new for ${v} days`,
    technical: 'Window after first-seen during which newKeyPowDifficulty applies',
  },
};

const spamMemo = new WeakMap<RelayConfig, SpamSettings>();

export function deriveSpamSettings(relay: RelayConfig): SpamSettings {
  const hit = spamMemo.get(relay);
  if (hit) return hit;
  const out = {} as SpamSettings;
  for (const [field, m] of Object.entries(SPAM_TABLE) as Array<[keyof SpamSettings, GoalMapping]>) {
    out[field] = m.round(interpolate(m.anchors, relay.goals[m.goal]));
  }
  spamMemo.set(relay, out);
  return out;
}

/** Limits from goals alone (no blossom settings, tier or overrides). */
export function limitsFromGoals(goals: Goals): Omit<EffectiveLimits, 'overridden'> {
  const v = (f: GoalDrivenField) => {
    const m = GOAL_TABLE[f];
    return m.round(interpolate(m.anchors, goals[m.goal]));
  };
  return {
    maxEventBytes: v('maxEventBytes'),
    maxSubscriptions: v('maxSubscriptions'),
    maxFilters: v('maxFilters'),
    maxLimit: v('maxLimit'),
    eventsPerMinute: v('eventsPerMinute'),
    reqPerMinute: v('reqPerMinute'),
    minPowDifficulty: v('minPowDifficulty'),
    newKeyPowDifficulty: Math.max(v('newKeyPowDifficulty'), v('minPowDifficulty')),
    maxCreatedAtFutureSeconds: v('maxCreatedAtFutureSeconds'),
    // 0 = no lower bound on age; old notes are legitimately re-broadcast.
    maxCreatedAtPastSeconds: 0,
    blockedKinds: [],
    spamThreshold: v('spamThreshold'),
    defaultRetentionDays: retentionDaysFor(goals.storage),
    maxBlobBytes: v('maxBlobBytes'),
    defaultBlobQuotaBytes: v('defaultBlobQuotaBytes'),
  };
}

export type LimitSource = 'goal' | 'setting' | 'tier' | 'override';

interface Derived {
  limits: EffectiveLimits;
  sources: Partial<Record<keyof EffectiveLimits, LimitSource>>;
}

function derive(relay: RelayConfig, tierId?: string): Derived {
  const base = limitsFromGoals(relay.goals);
  const sources: Derived['sources'] = {};
  for (const k of Object.keys(base) as Array<keyof EffectiveLimits>) sources[k] = 'goal';
  const out: EffectiveLimits = { ...base, overridden: [] };

  // Explicit relay-level settings (media section).
  if (relay.blossom.maxBlobBytes !== undefined) {
    out.maxBlobBytes = relay.blossom.maxBlobBytes;
    sources.maxBlobBytes = 'setting';
  }
  if (relay.blossom.defaultQuotaBytes !== undefined) {
    out.defaultBlobQuotaBytes = relay.blossom.defaultQuotaBytes;
    sources.defaultBlobQuotaBytes = 'setting';
  }

  // Tier values.
  const tier =
    relay.tiers.find((t) => t.id === (tierId ?? relay.defaultTier)) ??
    relay.tiers.find((t) => t.id === relay.defaultTier);
  if (tier) {
    const set = <K extends keyof EffectiveLimits>(k: K, v: EffectiveLimits[K] | undefined) => {
      if (v === undefined) return;
      out[k] = v;
      sources[k] = 'tier';
    };
    set('eventsPerMinute', tier.eventsPerMinute);
    set('maxEventBytes', tier.maxEventBytes);
    set('allowedKinds', tier.allowedKinds);
    set('defaultBlobQuotaBytes', tier.blobQuotaBytes);
    set('maxBlobBytes', tier.maxBlobBytes);
    set('defaultRetentionDays', tier.retentionDays);
  }

  // Advanced overrides win and are recorded.
  const ov = relay.limits as LimitsOverride;
  for (const k of Object.keys(ov) as Array<keyof LimitsOverride>) {
    const v = ov[k];
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    sources[k] = 'override';
    out.overridden.push(k);
  }
  out.overridden.sort();
  return { limits: out, sources };
}

const limitsMemo = new WeakMap<RelayConfig, Map<string, EffectiveLimits>>();

/**
 * Effective limits for a relay (+ optional tier): goals → media settings → tier → overrides.
 * Pure; memoized per relay config object (config objects are replaced on change).
 */
export function deriveLimits(relay: RelayConfig, tier?: string): EffectiveLimits {
  let byTier = limitsMemo.get(relay);
  if (!byTier) {
    byTier = new Map();
    limitsMemo.set(relay, byTier);
  }
  const key = tier ?? '';
  const hit = byTier.get(key);
  if (hit) return hit;
  const { limits } = derive(relay, tier);
  byTier.set(key, limits);
  return limits;
}

export interface LimitExplanation {
  field: keyof EffectiveLimits | keyof SpamSettings;
  value: number | number[] | null;
  /** Plain language. */
  text: string;
  /** Technical lens. */
  technical: string;
  source: LimitSource;
  /** Goal that produced the value (when source = goal). */
  goal?: GoalName;
}

const GOAL_LABEL: Record<GoalName, string> = {
  openness: 'Openness',
  spamTolerance: 'Spam tolerance',
  storage: 'Storage',
  media: 'Media',
  speedVsCost: 'Speed vs cost',
};

const SOURCE_TEXT: Record<Exclude<LimitSource, 'goal'>, string> = {
  setting: 'set in media settings',
  tier: 'set by the tier',
  override: 'overridden by you',
};

/** Plain-language + technical explanation for every effective value. */
export function explainLimits(relay: RelayConfig, tier?: string): LimitExplanation[] {
  const { limits, sources } = derive(relay, tier);
  const lines: LimitExplanation[] = [];
  const why = (src: LimitSource, goal?: GoalName) =>
    src === 'goal' && goal
      ? `from your ${GOAL_LABEL[goal]} goal (${relay.goals[goal]})`
      : SOURCE_TEXT[src as Exclude<LimitSource, 'goal'>];
  for (const [field, m] of Object.entries(GOAL_TABLE) as Array<[GoalDrivenField, GoalMapping]>) {
    const value = limits[field];
    const src = sources[field] ?? 'goal';
    lines.push({
      field,
      value,
      text: `${m.plain(value)} — ${why(src, m.goal)}`,
      technical: `${field} = ${value}; ${m.technical}; goals.${m.goal} = ${relay.goals[m.goal]}`,
      source: src,
      ...(src === 'goal' ? { goal: m.goal } : {}),
    });
  }
  const retSrc = sources.defaultRetentionDays ?? 'goal';
  lines.push({
    field: 'defaultRetentionDays',
    value: limits.defaultRetentionDays ?? null,
    text: `${
      limits.defaultRetentionDays === undefined
        ? 'Posts are kept forever'
        : `Posts are kept for ${limits.defaultRetentionDays} days`
    } — ${why(retSrc, 'storage')}`,
    technical: `defaultRetentionDays = ${limits.defaultRetentionDays ?? '∞'}; per-kind rules in retention[] still apply`,
    source: retSrc,
    ...(retSrc === 'goal' ? { goal: 'storage' as const } : {}),
  });
  lines.push({
    field: 'maxCreatedAtPastSeconds',
    value: limits.maxCreatedAtPastSeconds,
    text:
      limits.maxCreatedAtPastSeconds === 0
        ? 'Old posts can be imported (no age limit)'
        : `Posts older than ${formatDuration(limits.maxCreatedAtPastSeconds)} are refused`,
    technical: `maxCreatedAtPastSeconds = ${limits.maxCreatedAtPastSeconds} (0 = unbounded)`,
    source: sources.maxCreatedAtPastSeconds ?? 'goal',
  });
  lines.push({
    field: 'allowedKinds',
    value: limits.allowedKinds ?? null,
    text: limits.allowedKinds
      ? `Only ${limits.allowedKinds.length} kinds of content are accepted`
      : 'All kinds of content are accepted',
    technical: `allowedKinds = ${limits.allowedKinds ? `[${limits.allowedKinds.join(',')}]` : 'any'}`,
    source: sources.allowedKinds ?? 'goal',
  });
  lines.push({
    field: 'blockedKinds',
    value: limits.blockedKinds,
    text: limits.blockedKinds.length
      ? `${limits.blockedKinds.length} kinds of content are blocked`
      : 'No kinds of content are blocked',
    technical: `blockedKinds = [${limits.blockedKinds.join(',')}]`,
    source: sources.blockedKinds ?? 'goal',
  });
  const spam = deriveSpamSettings(relay);
  for (const [field, m] of Object.entries(SPAM_TABLE) as Array<[keyof SpamSettings, GoalMapping]>) {
    lines.push({
      field,
      value: spam[field],
      text: `${m.plain(spam[field])} — ${why('goal', m.goal)}`,
      technical: `${field} = ${spam[field]}; ${m.technical}; goals.${m.goal} = ${relay.goals[m.goal]}`,
      source: 'goal',
      goal: m.goal,
    });
  }
  return lines;
}
