// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resource advisor (§6.7 "Speed vs cost → resource advice", §14): from live
 * insights (connections, events/s), database and media size, disk trend and
 * machine facts, recommend a machine size and settings. Every suggestion is a
 * card with an action to preview → apply → undo; nothing is applied here.
 *
 * `advise()` is pure (facts in, advice out) so the rules are easy to test.
 */
import type { BeamhopConfig, Kernel } from '@beamhop/core';
import { HOST_SERVICE, type HostInfo } from './types.ts';
import { mb } from './update.ts';

export interface AdvisorFacts {
  runtime: string;
  host?: { cpus: number; memoryBytes: number; rssBytes: number; verifyWorkers: number };
  /** `node.verifyWorkers` (undefined = automatic). */
  verifyWorkersSetting?: number;
  connections: number;
  eventsPerSecond: number;
  dbBytes?: number;
  events?: number;
  blobBytes?: number;
  blobFiles?: number;
  /** Media were only partly counted (very many files). */
  blobBytesPartial?: boolean;
  blobDriver: string;
  storageDriver: string;
  disk?: { freeBytes: number; totalBytes: number };
  /** Days until the disk is full at the recent rate (undefined: not shrinking / unknown). */
  diskDaysLeft?: number;
  backupsEnabled: boolean;
  /**
   * Hot/cold media tiering (media module), read duck-typed: whether cold
   * storage is set up and how much local media nobody opened for `days`.
   * Undefined when the media module is off.
   */
  coldStorage?: {
    enabled: boolean;
    days: number;
    staleBytes: number;
    staleFiles: number;
    /** Only part of the files were looked at (very many files). */
    partial?: boolean;
  };
}

export interface MachineSize {
  vcpus: number;
  memoryGb: number;
  diskGb: number;
}

export interface AdviceApply {
  label: string;
  actionId: string;
  input: Record<string, unknown>;
}

export interface Advice {
  id: string;
  severity: 'info' | 'suggestion' | 'warning';
  title: string;
  body: string;
  /** Technical lens lines. */
  lens: string[];
  apply?: AdviceApply;
}

export interface AdvisorReport {
  at: number;
  size: MachineSize;
  facts: AdvisorFacts;
  advice: Advice[];
}

/** Config changes `system.apply-advice` knows how to make. */
export const CONFIG_ADVICE = ['verify-workers-off', 'verify-workers-on'] as const;
export type ConfigAdviceId = (typeof CONFIG_ADVICE)[number];

const GB = 1024 ** 3;
/** "Not opened in" window of the cold-storage advice, in days. */
export const COLD_STALE_DAYS = 90;
/** Smallest amount of unopened media worth a cold-storage suggestion. */
export const COLD_MIN_BYTES = GB;
/** Action that turns cold storage on (preview → apply → undo). */
export const COLD_STORAGE_ACTION = 'system.cold-storage';
const MEMORY_STEPS = [1, 2, 4, 8, 16, 32, 64];

export function recommendSize(f: AdvisorFacts): MachineSize {
  const vcpus = Math.min(
    32,
    Math.max(1, Math.ceil(f.eventsPerSecond / 1000 + f.connections / 5000 - 1e-9)),
  );
  const memMb =
    256 +
    f.connections * 0.05 +
    f.eventsPerSecond * 0.5 +
    ((f.dbBytes ?? 0) / (1024 * 1024)) * 0.05;
  const memoryGb = MEMORY_STEPS.find((g) => g * 1024 * 0.75 >= memMb) ?? 64;
  const local = (f.dbBytes ?? 0) + (f.blobDriver === 'fs' ? (f.blobBytes ?? 0) : 0);
  const diskGb = Math.max(10, Math.ceil(((local * 2) / GB + 5) / 10) * 10);
  return { vcpus, memoryGb, diskGb };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function advise(f: AdvisorFacts): { size: MachineSize; advice: Advice[] } {
  const size = recommendSize(f);
  const out: Advice[] = [];
  const load = `${f.connections} connections · ${f.eventsPerSecond.toFixed(1)} events/s · database ${mb(f.dbBytes) || 'unknown'} · media ${mb(f.blobBytes) || 'unknown'}${f.blobBytesPartial ? ' (partly counted)' : ''}`;

  out.push({
    id: 'machine-size',
    severity: 'info',
    title: `Your relay would run comfortably on ${plural(size.vcpus, 'vCPU', 'vCPUs')} / ${size.memoryGb} GB`,
    body: `With today's traffic, a machine with ${size.vcpus} vCPU, ${size.memoryGb} GB of memory and ${size.diskGb} GB of disk leaves room to grow.`,
    lens: [
      load,
      'vCPU = ⌈ev/s ÷ 1000 + connections ÷ 5000⌉; memory = 256 MB + 50 KB/connection + 0.5 MB per ev/s + 5% of the database, at 75% use; disk = 2 × (database + local media) + 5 GB',
    ],
  });

  const h = f.host;
  if (h && f.runtime !== 'cloudflare') {
    const memGb = h.memoryBytes / GB;
    const lens = [
      `this machine: ${h.cpus} CPU cores, ${memGb.toFixed(1)} GB memory, process uses ${mb(h.rssBytes)}`,
    ];
    if (h.cpus < size.vcpus || memGb < size.memoryGb * 0.9)
      out.push({
        id: 'machine-too-small',
        severity: 'warning',
        title: 'This machine is small for your traffic',
        body: `Move to at least ${plural(size.vcpus, 'vCPU', 'vCPUs')} and ${size.memoryGb} GB of memory so the relay stays fast at busy times.`,
        lens,
      });
    else if (h.cpus >= size.vcpus * 4 && memGb >= size.memoryGb * 4 && h.cpus > 2)
      out.push({
        id: 'machine-too-big',
        severity: 'suggestion',
        title: 'You could save money on a smaller machine',
        body: `This machine has ${h.cpus} cores and ${Math.round(memGb)} GB of memory; ${plural(size.vcpus, 'vCPU', 'vCPUs')} and ${size.memoryGb} GB would do. Use \`beamhop move\` to switch.`,
        lens,
      });

    if (h.cpus <= 1 && h.verifyWorkers > 0)
      out.push({
        id: 'verify-workers-off',
        severity: 'suggestion',
        title: 'Check signatures on the main thread',
        body: 'This machine has one CPU core, so extra signature-checking threads only add overhead. Takes effect after the next restart.',
        lens: [
          `node.verifyWorkers: ${f.verifyWorkersSetting ?? 'auto'} → 0`,
          `running threads: ${h.verifyWorkers}`,
        ],
        apply: {
          label: 'Use the main thread',
          actionId: 'system.apply-advice',
          input: { id: 'verify-workers-off' },
        },
      });
    else if (h.cpus > 1 && h.verifyWorkers === 0 && f.eventsPerSecond >= 200) {
      const n = Math.min(8, h.cpus - 1);
      out.push({
        id: 'verify-workers-on',
        severity: 'suggestion',
        title: 'Check signatures in parallel',
        body: `Your relay receives many posts. Checking signatures on ${plural(n, 'extra thread')} keeps it responsive. Takes effect after the next restart.`,
        lens: [`node.verifyWorkers: 0 → ${n}`, `${h.cpus} CPU cores`],
        apply: {
          label: `Use ${plural(n, 'thread')}`,
          actionId: 'system.apply-advice',
          input: { id: 'verify-workers-on' },
        },
      });
    }
  }

  if (f.disk && f.disk.totalBytes > 0) {
    const usedPct = Math.round((1 - f.disk.freeBytes / f.disk.totalBytes) * 100);
    const lens = [
      `disk free ${mb(f.disk.freeBytes)} of ${mb(f.disk.totalBytes)} (${usedPct}% used)`,
      ...(f.diskDaysLeft !== undefined
        ? [`7-day trend: full in ${Math.round(f.diskDaysLeft)} days`]
        : []),
    ];
    const prune: AdviceApply = {
      label: 'Free up space',
      actionId: 'lifecycle.prune-storage',
      input: {},
    };
    if (f.diskDaysLeft !== undefined && f.diskDaysLeft < 30)
      out.push({
        id: 'disk-forecast',
        severity: 'warning',
        title: `The disk will be full in about ${plural(Math.max(1, Math.round(f.diskDaysLeft)), 'day')}`,
        body: 'Remove old reactions and reposts, keep posts for a shorter time, or move to a bigger disk.',
        lens,
        apply: prune,
      });
    else if (usedPct >= 85)
      out.push({
        id: 'disk-full',
        severity: 'warning',
        title: `The disk is ${usedPct}% full`,
        body: 'Free up space before it runs out, or move to a bigger disk.',
        lens,
        apply: prune,
      });
  }

  const cold = f.coldStorage;
  const coldAdvice =
    !!cold && !cold.enabled && f.runtime !== 'cloudflare' && cold.staleBytes >= COLD_MIN_BYTES;
  if (cold && coldAdvice) {
    const gb = Math.max(1, Math.round(cold.staleBytes / GB));
    out.push({
      id: 'cold-storage-on',
      severity: 'suggestion',
      title: `Turn on cold storage — ${gb} GB of files haven't been opened in ${cold.days} days`,
      body: 'Move files nobody opens any more to a cheaper storage bucket. They keep working, and the main storage keeps room for new uploads.',
      lens: [
        `${cold.staleFiles} files, ${mb(cold.staleBytes)} with last access older than ${cold.days} days${cold.partial ? ' (partly counted)' : ''}`,
        'last access: docs blossom.tiers[sha256].lastAccess, else newest BlobIndex uploadedAt',
        `modules.blossom.tiers.cold: none → { store, afterDays: ${cold.days} }`,
      ],
      apply: {
        label: 'Turn on cold storage',
        actionId: COLD_STORAGE_ACTION,
        input: { afterDays: cold.days },
      },
    });
  }

  // Cold storage (when available) is the better answer to a full media disk.
  if (f.blobDriver === 'fs' && (f.blobBytes ?? 0) > 20 * GB && !coldAdvice && !cold?.enabled)
    out.push({
      id: 'media-to-bucket',
      severity: 'suggestion',
      title: `Move ${mb(f.blobBytes)} of media to cloud storage`,
      body: 'Media files take most of this disk. A storage bucket (S3, R2 or Google Cloud) is cheaper per GB and grows by itself. Change it under Settings → Media.',
      lens: [`blobStorage.driver=fs · ${f.blobFiles ?? '?'} files`],
    });

  if (
    f.storageDriver === 'sqlite' &&
    (f.connections > 5000 || (f.dbBytes ?? 0) > 50 * GB || f.eventsPerSecond > 2000)
  )
    out.push({
      id: 'database-postgres',
      severity: 'suggestion',
      title: 'Consider a Postgres database',
      body: 'At this size a separate database server handles the load better. Use `beamhop move` to switch without losing posts.',
      lens: [`storage.driver=sqlite · ${load}`],
    });

  if (!f.backupsEnabled && f.runtime !== 'cloudflare')
    out.push({
      id: 'backups-off',
      severity: 'warning',
      title: 'Turn on daily backups',
      body: 'Updates make a backup first, but without a schedule recent posts are lost if the disk fails.',
      lens: ['backups.enabled=false'],
      apply: {
        label: 'Set up backups',
        actionId: 'backups.setup',
        input: { enabled: true, schedule: 'daily' },
      },
    });

  return { size, advice: out };
}

// ── facts from the running kernel ──

interface InsightsLike {
  live(): {
    relays: Array<{ connections: number; eventsPerSecond: number }>;
    storage: { events: number; bytes: number } | null;
    disk: { freeBytes: number; totalBytes: number } | null;
  };
  series?(q: {
    metric: string;
    from: number;
    to: number;
    stepSeconds?: number;
  }): Promise<Array<{ t: number; v: number }>>;
}

interface DiskLike {
  usage(): Promise<{ freeBytes: number; totalBytes: number }>;
}

/** Days until `free` reaches 0 from a series of free-space samples (undefined if not shrinking). */
export function daysLeft(points: Array<{ t: number; v: number }>): number | undefined {
  const pts = points.filter((p) => Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return undefined;
  const first = pts[0] as { t: number; v: number };
  const last = pts[pts.length - 1] as { t: number; v: number };
  const span = last.t - first.t;
  if (span < 86_400) return undefined;
  const perDay = ((first.v - last.v) / span) * 86_400;
  if (perDay <= 0) return undefined;
  return last.v / perDay;
}

const MAX_BLOB_SCAN = 20_000;

export async function gatherFacts(kernel: Kernel): Promise<AdvisorFacts> {
  const cfg: BeamhopConfig = kernel.config();
  const insights = kernel.use<InsightsLike>('insights');
  const live = insights?.live();
  const f: AdvisorFacts = {
    runtime: kernel.runtime,
    connections: live?.relays.reduce((a, r) => a + r.connections, 0) ?? 0,
    eventsPerSecond: live?.relays.reduce((a, r) => a + r.eventsPerSecond, 0) ?? 0,
    blobDriver: cfg.blobStorage.driver,
    storageDriver: cfg.storage.driver,
    backupsEnabled: cfg.backups.enabled,
  };
  if (cfg.node.verifyWorkers !== undefined) f.verifyWorkersSetting = cfg.node.verifyWorkers;
  if (live?.storage) {
    f.dbBytes = live.storage.bytes;
    f.events = live.storage.events;
  }
  const disk =
    live?.disk ??
    (await kernel
      .use<DiskLike>('runtime.disk')
      ?.usage()
      .catch(() => null));
  if (disk) f.disk = { freeBytes: disk.freeBytes, totalBytes: disk.totalBytes };
  if (insights?.series) {
    const now = kernel.ports.clock.now();
    const pts = await insights
      .series({ metric: 'disk.free', from: now - 7 * 86_400, to: now, stepSeconds: 3600 })
      .catch(() => []);
    const d = daysLeft(pts);
    if (d !== undefined) f.diskDaysLeft = d;
  }
  const host = kernel.use<HostInfo>(HOST_SERVICE);
  if (host)
    f.host = {
      cpus: host.cpus,
      memoryBytes: host.memoryBytes,
      rssBytes: host.rssBytes(),
      verifyWorkers: host.verifyWorkers,
    };
  const sizes = new Map<string, number>();
  try {
    let bytes = 0;
    let files = 0;
    let cursor: string | undefined;
    do {
      const page = await kernel.ports.blobs.list({ cursor, limit: 1000 });
      for (const b of page.items) {
        bytes += b.size;
        files++;
        sizes.set(b.sha256, b.size);
      }
      cursor = page.cursor;
    } while (cursor && files < MAX_BLOB_SCAN);
    f.blobBytes = bytes;
    f.blobFiles = files;
    if (cursor) f.blobBytesPartial = true;
  } catch {
    // media storage unreachable: leave unknown
  }
  const cold = await coldStorageFacts(kernel, sizes).catch(() => undefined);
  if (cold) f.coldStorage = { ...cold, ...(f.blobBytesPartial ? { partial: true } : {}) };
  return f;
}

/** DocStore collection where the media module keeps per-file access times (duck-typed). */
const TIERS_DOCS = 'blossom.tiers';

/** Is cold storage configured (`modules.blossom.tiers.cold`)? Read without importing the media module. */
export function coldStorageConfigured(cfg: BeamhopConfig): boolean {
  const blossom = cfg.modules?.blossom as { tiers?: { cold?: unknown } } | undefined;
  return !!blossom?.tiers?.cold;
}

/**
 * Unopened local media, for the cold-storage advice. Only when the media
 * module with storage tiers is on (`media.storage-tiers` action present).
 */
async function coldStorageFacts(
  kernel: Kernel,
  sizes: Map<string, number>,
): Promise<NonNullable<AdvisorFacts['coldStorage']> | undefined> {
  if (!kernel.actions.get('media.storage-tiers')) return undefined;
  const cfg = kernel.config();
  const days = COLD_STALE_DAYS;
  const enabled = coldStorageConfigured(cfg);
  if (enabled || !sizes.size) return { enabled, days, staleBytes: 0, staleFiles: 0 };
  const docs = kernel.ports.docs;
  const last = new Map<string, number>();
  const cold = new Set<string>();
  let cursor: string | undefined;
  let seen = 0;
  do {
    const page = await docs.list<{ lastAccess?: number; tier?: string }>(TIERS_DOCS, {
      cursor,
      limit: 1000,
    });
    for (const { key, value } of page.items) {
      if (value?.tier === 'cold') cold.add(key);
      if (typeof value?.lastAccess === 'number') last.set(key, value.lastAccess);
    }
    seen += page.items.length;
    cursor = page.cursor;
  } while (cursor && seen < MAX_BLOB_SCAN * 2);
  // Files without an access record: newest upload time on any relay.
  const uploaded = new Map<string, number>();
  for (const relay of cfg.relays) {
    let c: string | undefined;
    let n = 0;
    do {
      const page = await kernel.ports.blobIndex.list(relay.id, { cursor: c, limit: 1000 });
      for (const o of page.items)
        if (sizes.has(o.sha256) && !last.has(o.sha256))
          uploaded.set(o.sha256, Math.max(uploaded.get(o.sha256) ?? 0, o.uploadedAt));
      n += page.items.length;
      c = page.cursor;
    } while (c && n < MAX_BLOB_SCAN * 2);
  }
  for (const [sha, t] of uploaded) last.set(sha, t);
  const cutoff = kernel.ports.clock.now() - days * 86_400;
  let staleBytes = 0;
  let staleFiles = 0;
  for (const [sha, size] of sizes) {
    if (cold.has(sha)) continue;
    const t = last.get(sha);
    if (t === undefined || t > cutoff) continue;
    staleBytes += size;
    staleFiles++;
  }
  return { enabled, days, staleBytes, staleFiles };
}

export async function runAdvisor(kernel: Kernel): Promise<AdvisorReport> {
  const facts = await gatherFacts(kernel);
  const { size, advice } = advise(facts);
  return { at: kernel.ports.clock.now(), size, facts, advice };
}

/** The `node.verifyWorkers` value a config advice sets (null: advice not applicable). */
export function configAdviceValue(id: ConfigAdviceId, facts: AdvisorFacts): number | null {
  const a = advise(facts).advice.find((x) => x.id === id);
  if (!a) return null;
  if (id === 'verify-workers-off') return 0;
  return Math.min(8, Math.max(1, (facts.host?.cpus ?? 2) - 1));
}
