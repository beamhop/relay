// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sandbox / dry-run (§6.10): replay recent stored traffic through the policy
 * pipeline twice — once with the current settings and once with a proposed
 * change — and report what would have been accepted, refused or held.
 *
 * Isolation: both runs use a *shadow kernel* (its own config, bus, policy
 * runtime and pipeline) over read-through ports whose writes land in a
 * throwaway overlay. Hooks also get `ctx.dryRun = true`. Nothing in the real
 * kernel, its stores, caches, rate-limit buckets or counters is touched.
 */
import {
  type AccessResolver,
  ActionRegistry,
  type BeamhopConfig,
  ConfigSchema,
  type DocStore,
  EventBus,
  type EventStore,
  type Kernel,
  type NostrEvent,
  PolicyPipeline,
  type Ports,
  type RelayConfig,
  type RelayId,
} from '@beamhop/core';
import {
  PolicyRuntime,
  allowlistResolver,
  createHooks,
  deriveLimits,
  tierResolver,
  wotResolver,
} from '@beamhop/policy';
import { type JsonPatchOp, applyPatch, mergePatch } from './patch.ts';
import { percent, plural } from './util.ts';

/** Same shape as the admin-api config proposal (`patch` / `merge`, relative to the relay when relay-scoped). */
export interface SimulateInput {
  patch?: JsonPatchOp[];
  merge?: unknown;
  /** `relay` (default): patch is relative to the relay object. `node`: relative to the whole config. */
  target?: 'relay' | 'node';
  /** How far back to replay. */
  hours?: number;
  /** Max events replayed. */
  limit?: number;
}

export const SIMULATE_MAX_HOURS = 168;
export const SIMULATE_MAX_EVENTS = 20_000;
const EXAMPLES = 5;

/** Plain labels for the built-in filters (technical id stays in `by`). */
export const HOOK_LABELS: Record<string, string> = {
  'policy.recycled': 'Removed by a moderator',
  'policy.banned': 'Blocked account',
  'policy.auth': 'Not signed in',
  'policy.access': 'Not a member',
  'policy.mute': 'Muted account (hidden quietly)',
  'policy.rate-limit': 'Posting too fast',
  'policy.event-size': 'Post too large',
  'policy.kinds': 'Content type not allowed',
  'policy.created-at': 'Wrong date on the post',
  'policy.pow': 'Puzzle (proof of work) too easy',
  'policy.upload-limits': 'File too large or over quota',
  'policy.duplicate': 'Duplicate post',
  'policy.content': 'Blocked link or phrase',
};

export interface ReasonCount {
  /** Plain label. */
  label: string;
  /** Hook id. */
  by: string;
  decision: 'reject' | 'hold' | 'shadow';
  count: number;
  /** One sample message (technical lens). */
  sample: string;
  /** Example event ids (ids only, never content). */
  examples: string[];
}

export interface Outcome {
  accepted: number;
  rejected: number;
  held: number;
  shadowed: number;
  byReason: ReasonCount[];
}

export interface SimulationResult {
  relayId: RelayId;
  window: { from: number; to: number; hours: number };
  replayed: number;
  /** True when more events existed than `limit`. */
  truncated: boolean;
  current: Outcome;
  proposed: Outcome;
  /** Events whose fate changes. */
  changes: {
    newlyBlocked: number;
    newlyAllowed: number;
    examplesBlocked: string[];
    examplesAllowed: string[];
  };
  /** Plain-language summary for the diff sheet. */
  summary: string;
  notes: string[];
}

// ───────────────────────────── read-only ports ─────────────────────────────

/** DocStore that reads through to `base` but keeps every write in memory. */
export class OverlayDocStore implements DocStore {
  private readonly over = new Map<string, Map<string, unknown>>();
  constructor(private readonly base: DocStore) {}
  private col(c: string) {
    let m = this.over.get(c);
    if (!m) {
      m = new Map();
      this.over.set(c, m);
    }
    return m;
  }
  async init() {}
  async get<T>(collection: string, key: string): Promise<T | null> {
    const m = this.over.get(collection);
    if (m?.has(key)) return (m.get(key) as T | undefined) ?? null;
    return this.base.get<T>(collection, key);
  }
  async put<T>(collection: string, key: string, value: T) {
    this.col(collection).set(key, structuredClone(value));
  }
  async delete(collection: string, key: string) {
    const had = (await this.get(collection, key)) !== null;
    this.col(collection).set(key, undefined);
    return had;
  }
  async list<T>(
    collection: string,
    opts?: { prefix?: string; cursor?: string; limit?: number; reverse?: boolean },
  ) {
    const page = await this.base.list<T>(collection, opts);
    const m = this.over.get(collection);
    if (!m) return page;
    const items = page.items
      .filter((i) => !m.has(i.key) || m.get(i.key) !== undefined)
      .map((i) => (m.has(i.key) ? { key: i.key, value: m.get(i.key) as T } : i));
    return { ...page, items };
  }
  async cas<T>(collection: string, key: string, expected: T | null, next: T) {
    const cur = await this.get<T>(collection, key);
    if (JSON.stringify(cur) !== JSON.stringify(expected)) return false;
    await this.put(collection, key, next);
    return true;
  }
}

function readOnlyEvents(base: EventStore): EventStore {
  const deny = async () => {
    throw new Error('sandbox: event store is read-only');
  };
  return {
    capabilities: base.capabilities,
    init: async () => {},
    save: deny,
    query: (r, f, o) => base.query(r, f, o),
    count: (r, f) => base.count(r, f),
    getById: (r, id) => base.getById(r, id),
    applyDeletion: deny,
    vanish: deny,
    deleteByIds: deny,
    deleteMatching: deny,
    deleteExpired: deny,
    stats: (r) => base.stats(r),
    close: async () => {},
  };
}

export function sandboxPorts(base: Ports): Ports {
  const deny = async () => {
    throw new Error('sandbox: read-only');
  };
  return {
    ...base,
    events: readOnlyEvents(base.events),
    docs: new OverlayDocStore(base.docs),
    blobs: { ...base.blobs, put: deny, delete: deny } as Ports['blobs'],
    blobIndex: {
      ...base.blobIndex,
      init: async () => {},
      addOwner: deny,
      removeOwner: deny,
      owners: (r, s) => base.blobIndex.owners(r, s),
      listByOwner: (r, p, o) => base.blobIndex.listByOwner(r, p, o),
      list: (r, o) => base.blobIndex.list(r, o),
      usage: (r, p) => base.blobIndex.usage(r, p),
      refCount: (s) => base.blobIndex.refCount(s),
      expired: (n, l) => base.blobIndex.expired(n, l),
    },
    metrics: { ...base.metrics, record: async () => {}, prune: async () => 0 },
    pubsub: { publish: async () => {}, subscribe: () => () => {} },
    scheduler: { every: () => {}, cancel: () => {} },
  };
}

// ───────────────────────────── shadow kernel ─────────────────────────────

/** A kernel look-alike with its own config, bus and policy pipeline over sandboxed ports. */
export function shadowKernel(base: Kernel, config: BeamhopConfig, ports: Ports): Kernel {
  const relay = (id: RelayId) => config.relays.find((r) => r.id === id);
  const access: AccessResolver[] = [];
  const policyEnabled = base.isEnabled('policy');
  const k: Kernel = {
    ...base,
    ports,
    bus: new EventBus(),
    policy: new PolicyPipeline(),
    actions: new ActionRegistry(),
    config: () => config,
    relay,
    limits(relayId, tier) {
      const r = relay(relayId);
      if (r && policyEnabled) return deriveLimits(r, tier);
      return base.limits(relayId, tier);
    },
    setLimitsResolver: () => {},
    applyConfig: async () => {},
    onConfigChange: () => () => {},
    moduleConfig: <T>(id: string) => config.modules[id] as T | undefined,
    access,
    health: [],
    cards: [],
    ui: [],
    playbooks: [],
    notify: async () => {},
    setNotifier: () => {},
    provide: () => {},
  };
  if (policyEnabled) {
    const rt = new PolicyRuntime(k);
    for (const h of createHooks(rt)) k.policy.add(h);
    access.push(allowlistResolver(rt), wotResolver(rt), tierResolver(rt));
  }
  // Other modules' resolvers and hooks (plugins, enterprise) evaluated as they are today.
  for (const r of base.access) if (!r.id.startsWith('policy.')) access.push(r);
  for (const h of base.policy.list()) if (!h.id.startsWith('policy.')) k.policy.add(h);
  return k;
}

// ───────────────────────────── simulation ─────────────────────────────

export function proposedConfig(
  current: BeamhopConfig,
  relayId: RelayId,
  input: SimulateInput,
): BeamhopConfig {
  let raw: unknown;
  if ((input.target ?? 'relay') === 'node') {
    raw = input.patch ? applyPatch(current, input.patch) : mergePatch(current, input.merge ?? {});
  } else {
    const idx = current.relays.findIndex((r) => r.id === relayId);
    if (idx < 0) throw new Error(`unknown relay ${relayId}`);
    const r = current.relays[idx] as RelayConfig;
    const next = input.patch ? applyPatch(r, input.patch) : mergePatch(r, input.merge ?? {});
    const relays = [...current.relays] as unknown[];
    relays[idx] = next;
    raw = { ...current, relays };
  }
  return ConfigSchema.parse(raw);
}

type Fate = { action: 'accept' | 'reject' | 'hold' | 'shadow'; by?: string; message?: string };

function tally(results: Array<{ id: string; fate: Fate }>): Outcome {
  const out: Outcome = { accepted: 0, rejected: 0, held: 0, shadowed: 0, byReason: [] };
  const reasons = new Map<string, ReasonCount>();
  for (const { id, fate } of results) {
    if (fate.action === 'accept') {
      out.accepted++;
      continue;
    }
    if (fate.action === 'reject') out.rejected++;
    else if (fate.action === 'hold') out.held++;
    else out.shadowed++;
    const by = fate.by ?? 'unknown';
    const key = `${fate.action}|${by}`;
    let r = reasons.get(key);
    if (!r) {
      r = {
        label: HOOK_LABELS[by] ?? by,
        by,
        decision: fate.action,
        count: 0,
        sample: fate.message ?? '',
        examples: [],
      };
      reasons.set(key, r);
    }
    r.count++;
    if (r.examples.length < EXAMPLES) r.examples.push(id);
  }
  out.byReason = [...reasons.values()].sort((a, b) => b.count - a.count);
  return out;
}

async function replay(k: Kernel, relayId: RelayId, events: NostrEvent[]) {
  const out: Array<{ id: string; fate: Fate }> = [];
  for (const e of events) {
    const d = await k.policy.run('onEvent', [e, { relayId, now: e.created_at, dryRun: true }]);
    const fate: Fate = { action: d.action };
    if (d.by) fate.by = d.by;
    if (d.action === 'reject') fate.message = `${d.prefix}: ${d.message}`;
    else if ('message' in d && d.message) fate.message = d.message;
    out.push({ id: e.id, fate });
  }
  return out;
}

export async function simulateChange(
  kernel: Kernel,
  relayId: RelayId,
  input: SimulateInput,
): Promise<SimulationResult> {
  const now = kernel.ports.clock.now();
  const hours = Math.min(Math.max(input.hours ?? 24, 1), SIMULATE_MAX_HOURS);
  const limit = Math.min(Math.max(input.limit ?? 5000, 1), SIMULATE_MAX_EVENTS);
  const current = kernel.config();
  if (!current.relays.some((r) => r.id === relayId)) throw new Error(`unknown relay ${relayId}`);
  const next = proposedConfig(current, relayId, input);
  const from = now - hours * 3600;

  const ports = sandboxPorts(kernel.ports);
  const fetched = await ports.events.query(
    relayId,
    [{ since: from, until: now, limit: limit + 1 }],
    {
      maxLimit: limit + 1,
    },
  );
  const truncated = fetched.length > limit;
  // Replay oldest first, like the original traffic.
  const events = fetched.slice(0, limit).reverse();

  const before = await replay(shadowKernel(kernel, current, ports), relayId, events);
  const after = await replay(
    shadowKernel(kernel, next, sandboxPorts(kernel.ports)),
    relayId,
    events,
  );

  const changes = {
    newlyBlocked: 0,
    newlyAllowed: 0,
    examplesBlocked: [] as string[],
    examplesAllowed: [] as string[],
  };
  for (let i = 0; i < events.length; i++) {
    const a = before[i]!.fate.action === 'accept';
    const b = after[i]!.fate.action === 'accept';
    if (a && !b) {
      changes.newlyBlocked++;
      if (changes.examplesBlocked.length < EXAMPLES) changes.examplesBlocked.push(events[i]!.id);
    } else if (!a && b) {
      changes.newlyAllowed++;
      if (changes.examplesAllowed.length < EXAMPLES) changes.examplesAllowed.push(events[i]!.id);
    }
  }

  const cur = tally(before);
  const prop = tally(after);
  const n = events.length;
  const notBlockedNow = n - cur.accepted;
  const notBlockedNext = n - prop.accepted;
  let summary: string;
  if (n === 0) summary = `There were no posts in the last ${plural(hours, 'hour')} to try this on.`;
  else if (changes.newlyBlocked === 0 && changes.newlyAllowed === 0)
    summary = `No difference: all ${plural(n, 'recent post')} would have been treated the same way.`;
  else
    summary = `Of ${plural(n, 'recent post')}, ${notBlockedNext} (${percent(notBlockedNext, n)}%) would have been stopped or held — now ${notBlockedNow} (${percent(notBlockedNow, n)}%).${
      changes.newlyBlocked
        ? ` ${plural(changes.newlyBlocked, 'post')} that got in would be stopped.`
        : ''
    }${changes.newlyAllowed ? ` ${plural(changes.newlyAllowed, 'post')} that were stopped would get in.` : ''}`;

  const notes = [
    'Only posts the relay stored are replayed; posts already refused at the time are not in the sample.',
    'Rate limits are checked without counting, so "posting too fast" is not simulated.',
  ];
  if (truncated) notes.push(`Only the newest ${plural(limit, 'post')} were replayed.`);
  if (!kernel.isEnabled('policy'))
    notes.push('The filters module is off, so limit changes have no effect here.');

  return {
    relayId,
    window: { from, to: now, hours },
    replayed: n,
    truncated,
    current: cur,
    proposed: prop,
    changes,
    summary,
    notes,
  };
}
