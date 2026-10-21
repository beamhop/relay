import { type Tier, type TieredBlobStore, createBlobStore, tierInPlace } from '@beamhop/blobs';
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hot/cold storage tiering and per-tier storage caps (§4.2, §6.7).
 *
 * `ports.blobs` is routed through a {@link TieredBlobStore} in place, so every
 * module reading or writing bytes (media, backups, compliance) sees one store:
 * reads try hot then cold, new bytes go hot (or cold when hot is full and the
 * config says so). A scheduled job (`blossom.tiering`, Bun and Workers alike)
 * moves blobs nobody has read for `afterDays` to the cold store, never moving
 * quarantined or legally held bytes. It is resumable (cursor in docs) and
 * idempotent (moves copy, verify, then delete).
 *
 * Storage (DocStore):
 * - `blossom.tiers`  sha256 → TierRecord (last access, current tier, when moved)
 * - `blossom.state`  key `tiering` → TieringState (cursor, last run, usage per tier)
 */
import type { BlobStore, Kernel, Ports } from '@beamhop/core';
import { type BlossomConfig, BlossomConfigSchema, type TiersConfig } from './config.ts';
import { type BlossomService, STATE } from './service.ts';
import { BlossomError, formatBytes } from './util.ts';

export const TIERS = 'blossom.tiers';
export const TIERING_JOB = 'blossom.tiering';
const STATE_KEY = 'tiering';
const DAY = 86_400;
/** Access times are written at most this often per blob (seconds). */
const TOUCH_EVERY = DAY;

export interface TierRecord {
  /** Unix seconds of the last read (throttled to once a day). */
  lastAccess?: number;
  tier?: Tier;
  movedAt?: number;
}

export interface TierUsage {
  bytes: number;
  count: number;
}

export interface TieringState {
  lastRun?: number;
  nextRun?: number;
  /** Results of the last run. */
  moved: number;
  movedBytes: number;
  failed: number;
  lastError?: string;
  /** Since tiering was first used. */
  totalMoved: number;
  totalFailed: number;
  /** Resumable sweep position. */
  phase: Tier;
  cursor?: string;
  /** Counts of the sweep in progress. */
  pass: Record<Tier, TierUsage>;
  /** Counts of the last complete sweep. */
  usage?: Record<Tier, TierUsage> & { at: number };
}

export interface TieringOptions {
  /** Cold store override (tests, runtimes with bindings). Beats `kernel.use('blobs.cold')`. */
  coldStore?: BlobStore;
  /** Job interval. Default 3600 s. */
  intervalSeconds?: number;
  /** Max blobs inspected per run. Default 2000. */
  maxScan?: number;
  /** Max blobs moved per run. Default 200. */
  maxMoves?: number;
}

/** Service name a runtime may `provide` with a ready cold BlobStore (e.g. an R2 binding). */
export const COLD_STORE_SERVICE = 'blobs.cold';

/** Share of a cap from which the tier counts as nearly full (health warn / card). */
export const TIER_WARN = 0.8;
export const TIER_CRITICAL = 0.95;

const emptyState = (): TieringState => ({
  moved: 0,
  movedBytes: 0,
  failed: 0,
  totalMoved: 0,
  totalFailed: 0,
  phase: 'hot',
  pass: { hot: { bytes: 0, count: 0 }, cold: { bytes: 0, count: 0 } },
});

export interface TierStatus {
  tier: Tier;
  /** Plain name. */
  label: string;
  configured: boolean;
  usedBytes: number | null;
  count: number | null;
  maxBytes: number | null;
  /** used / max, when both are known. */
  fraction: number | null;
  /** Technical lens: driver/bucket. */
  technical: string;
}

export interface TieringStatusOutput {
  enabled: boolean;
  tiers: TierStatus[];
  afterDays: number | null;
  whenHotFull: TiersConfig['whenHotFull'];
  job: {
    lastRun: number | null;
    nextRun: number | null;
    moved: number;
    movedBytes: number;
    failed: number;
    lastError: string | null;
    totalMoved: number;
    totalFailed: number;
    /** True while a sweep is part-way through the stores. */
    inProgress: boolean;
  };
  /** When the usage numbers were counted (end of the last full sweep), or null. */
  countedAt: number | null;
  error: string | null;
}

export class TieringService {
  readonly store: TieredBlobStore;
  private readonly restoreFn: () => void;
  private cold: BlobStore | null = null;
  private coldKey = '';
  private coldError: string | null = null;
  private readonly touched = new Map<string, number>();
  private readonly promoting = new Set<string>();
  /** Bytes/count written or removed in this process since the last full sweep. */
  private delta: Record<Tier, TierUsage> = {
    hot: { bytes: 0, count: 0 },
    cold: { bytes: 0, count: 0 },
  };
  private running: Promise<TieringState> | null = null;

  constructor(
    readonly kernel: Kernel,
    readonly svc: BlossomService,
    readonly opts: TieringOptions = {},
  ) {
    const { tiered, restore } = tierInPlace(kernel.ports.blobs, {
      cold: () => this.cold,
      placement: (meta) => this.placement(meta.size),
      onRead: (sha, tier) => this.onRead(sha, tier),
      onChange: (tier, bytes, count) => {
        this.delta[tier].bytes += bytes;
        this.delta[tier].count += count;
      },
    });
    this.store = tiered;
    this.restoreFn = restore;
  }

  get ports(): Ports {
    return this.kernel.ports;
  }

  get intervalSeconds(): number {
    return this.opts.intervalSeconds ?? 3600;
  }

  config(): TiersConfig {
    return (this.kernel.moduleConfig<BlossomConfig>('blossom') ?? BlossomConfigSchema.parse({}))
      .tiers;
  }

  /** Put `ports.blobs` back the way it was (module stop). */
  restore(): void {
    this.restoreFn();
  }

  /** (Re)build the cold store from config. Errors are kept for health/status. */
  async ensureCold(): Promise<BlobStore | null> {
    const cfg = this.config().cold;
    if (!cfg) {
      this.cold = null;
      this.coldKey = '';
      this.coldError = null;
      return null;
    }
    if (this.opts.coldStore) {
      this.cold = this.opts.coldStore;
      return this.cold;
    }
    const provided = this.kernel.use<BlobStore>(COLD_STORE_SERVICE);
    if (provided) {
      this.cold = provided;
      return provided;
    }
    const key = JSON.stringify(cfg.store);
    if (this.cold && key === this.coldKey) return this.cold;
    try {
      const dataDir = this.kernel.config().node.dataDir ?? './data';
      const store = await createBlobStore({
        ...cfg.store,
        // Never share the hot store's default folder.
        path:
          cfg.store.driver === 'fs'
            ? (cfg.store.path ?? `${dataDir.replace(/\/$/, '')}/blobs-cold`)
            : cfg.store.path,
        dataDir,
      });
      await store.init();
      this.cold = store;
      this.coldKey = key;
      this.coldError = null;
      return store;
    } catch (err) {
      this.cold = null;
      this.coldKey = '';
      this.coldError = String(err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ───────────── usage / capacity ─────────────

  async state(): Promise<TieringState> {
    return {
      ...emptyState(),
      ...((await this.ports.docs.get<TieringState>(STATE, STATE_KEY)) ?? {}),
    };
  }

  /** Best-known usage per tier: last full count + changes made since by this process. */
  async usage(): Promise<Record<Tier, TierUsage> & { at: number | null }> {
    const st = await this.state();
    const base = st.usage;
    const add = (t: Tier): TierUsage => ({
      bytes: Math.max(0, (base?.[t].bytes ?? 0) + this.delta[t].bytes),
      count: Math.max(0, (base?.[t].count ?? 0) + this.delta[t].count),
    });
    return { hot: add('hot'), cold: add('cold'), at: base?.at ?? null };
  }

  /** Count a tier now (bounded), used before the first full sweep finished. */
  private async quickCount(tier: Tier, max = 5000): Promise<TierUsage | null> {
    let cursor: string | undefined;
    const u: TierUsage = { bytes: 0, count: 0 };
    do {
      const page = await this.store.listTier(tier, { cursor, limit: 500 });
      for (const b of page.items) {
        u.bytes += b.size;
        u.count++;
      }
      cursor = page.cursor;
      if (u.count >= max && cursor) return null;
    } while (cursor);
    return u;
  }

  /**
   * Where a new blob of `size` bytes goes, or a plain refusal when there is
   * no room. Only consulted when a cap is configured.
   */
  async placement(size: number): Promise<Tier> {
    const cfg = this.config();
    const hotMax = cfg.hot.maxBytes;
    if (!hotMax) return 'hot';
    const u = await this.usage();
    if (u.hot.bytes + size <= hotMax) return 'hot';
    const coldMax = cfg.cold?.maxBytes;
    if (
      cfg.cold &&
      this.cold &&
      cfg.whenHotFull === 'cold' &&
      (!coldMax || u.cold.bytes + size <= coldMax)
    ) {
      return 'cold';
    }
    throw new BlossomError(
      507,
      `This server's storage is full (${formatBytes(u.hot.bytes)} of ${formatBytes(hotMax)} used). Try again later.`,
    );
  }

  /** Pre-flight: refuse early when a new upload of `size` bytes cannot be stored. */
  async checkCapacity(size: number): Promise<void> {
    await this.placement(size);
  }

  // ───────────── access tracking / promote-back ─────────────

  onRead(sha256: string, tier: Tier): void {
    const now = this.ports.clock.now();
    const last = this.touched.get(sha256);
    if (last === undefined || now - last >= TOUCH_EVERY) {
      this.touched.set(sha256, now);
      if (this.touched.size > 50_000) this.touched.clear();
      this.svc.track('blossom.tiers.touch', () =>
        this.update(sha256, (r) => ({ ...r, lastAccess: now })),
      );
    }
    const cold = this.config().cold;
    if (tier === 'cold' && cold?.promoteOnAccess && !this.promoting.has(sha256)) {
      this.promoting.add(sha256);
      this.svc.track('blossom.tiers.promote', () =>
        this.promote(sha256).finally(() => this.promoting.delete(sha256)),
      );
    }
  }

  /** Copy a cold blob back to hot storage (when there is room). */
  async promote(sha256: string): Promise<boolean> {
    const meta = await this.store.cold?.head(sha256);
    if (!meta) return false;
    const hotMax = this.config().hot.maxBytes;
    if (hotMax && (await this.usage()).hot.bytes + meta.size > hotMax) return false;
    await this.store.move(sha256, 'hot');
    const now = this.ports.clock.now();
    await this.update(sha256, (r) => ({ ...r, tier: 'hot', lastAccess: now, movedAt: now }));
    return true;
  }

  private async update(sha256: string, fn: (r: TierRecord) => TierRecord): Promise<void> {
    const prev = (await this.ports.docs.get<TierRecord>(TIERS, sha256)) ?? {};
    await this.ports.docs.put(TIERS, sha256, fn(prev));
  }

  async tierOf(sha256: string): Promise<Tier> {
    const rec = await this.ports.docs.get<TierRecord>(TIERS, sha256);
    return rec?.tier ?? 'hot';
  }

  // ───────────── the job ─────────────

  /** Newest upload time of a hash on any relay, or null when nobody owns it. */
  private async newestUpload(sha256: string): Promise<number | null> {
    let newest: number | null = null;
    for (const r of this.kernel.config().relays) {
      for (const o of await this.ports.blobIndex.owners(r.id, sha256)) {
        if (newest === null || o.uploadedAt > newest) newest = o.uploadedAt;
      }
    }
    return newest;
  }

  /** Why a hot blob stays where it is (null → move it). */
  private async keepReason(
    b: { sha256: string; size: number },
    now: number,
  ): Promise<string | null> {
    const cold = this.config().cold;
    if (!cold) return 'tiering off';
    if (b.size < cold.minSizeBytes) return 'small';
    if (await this.svc.quarantined(b.sha256)) return 'quarantined';
    if ((await this.ports.blobIndex.refCount(b.sha256)) === 0) return 'orphan';
    if (await this.svc.bytesHeld(b.sha256)) return 'legal hold';
    if (await this.svc.heldAfterRemoval(b.sha256)) return 'legal hold';
    const rec = await this.ports.docs.get<TierRecord>(TIERS, b.sha256);
    let last = rec?.lastAccess ?? (await this.newestUpload(b.sha256));
    if (last === null) {
      // No history: start the clock now.
      await this.ports.docs.put(TIERS, b.sha256, { ...rec, lastAccess: now });
      last = now;
    }
    if (now - last < cold.afterDays * DAY) return 'recently used';
    return null;
  }

  /** One run of the job; concurrent calls share the run in progress. */
  run(): Promise<TieringState> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<TieringState> {
    const ports = this.ports;
    const cfg = this.config();
    const now = ports.clock.now();
    const st = await this.state();
    const next: TieringState = {
      ...st,
      moved: 0,
      movedBytes: 0,
      failed: 0,
      lastRun: now,
      nextRun: now + this.intervalSeconds,
    };
    next.lastError = undefined;
    if (!cfg.cold && !cfg.hot.maxBytes) {
      // Nothing configured: keep the record of the last run only.
      await ports.docs.put(STATE, STATE_KEY, { ...next, phase: 'hot', cursor: undefined });
      return next;
    }
    const cold = cfg.cold ? await this.ensureCold() : null;
    if (cfg.cold && !cold) {
      next.lastError = `Cheaper storage is not reachable: ${this.coldError ?? 'unknown error'}`;
      await ports.docs.put(STATE, STATE_KEY, next);
      return next;
    }
    const maxScan = this.opts.maxScan ?? 2000;
    const maxMoves = this.opts.maxMoves ?? 200;
    let scanned = 0;
    const passUsage = next.pass;
    while (scanned < maxScan && next.moved < maxMoves) {
      const tier = next.phase;
      if (tier === 'cold' && !cold) {
        next.phase = 'hot';
        next.cursor = undefined;
        this.finishPass(next, now);
        break;
      }
      const page = await this.store.listTier(tier, {
        cursor: next.cursor,
        limit: Math.min(200, maxScan - scanned),
      });
      for (const b of page.items) {
        scanned++;
        passUsage[tier].bytes += b.size;
        passUsage[tier].count++;
        if (tier !== 'hot' || !cold || next.moved >= maxMoves) continue;
        const reason = await this.keepReason(b, now);
        if (reason) continue;
        try {
          const r = await this.store.move(b.sha256, 'cold');
          if (r === 'moved') {
            next.moved++;
            next.movedBytes += b.size;
            passUsage.hot.bytes -= b.size;
            passUsage.hot.count--;
            await this.update(b.sha256, (x) => ({ ...x, tier: 'cold', movedAt: now }));
          }
        } catch (err) {
          next.failed++;
          next.lastError = String(err instanceof Error ? err.message : err);
          ports.logger.log('warn', 'blossom tiering move failed', {
            sha256: b.sha256,
            error: next.lastError,
          });
        }
      }
      next.cursor = page.cursor;
      if (!page.cursor) {
        if (tier === 'hot' && cold) {
          next.phase = 'cold';
          next.cursor = undefined;
        } else {
          this.finishPass(next, now);
          break;
        }
      }
    }
    next.totalMoved = st.totalMoved + next.moved;
    next.totalFailed = st.totalFailed + next.failed;
    await ports.docs.put(STATE, STATE_KEY, next);
    if (next.moved || next.failed) {
      ports.logger.log('info', 'blossom tiering', {
        moved: next.moved,
        movedBytes: next.movedBytes,
        failed: next.failed,
      });
    }
    return next;
  }

  private finishPass(st: TieringState, now: number): void {
    st.usage = { hot: { ...st.pass.hot }, cold: { ...st.pass.cold }, at: now };
    st.pass = { hot: { bytes: 0, count: 0 }, cold: { bytes: 0, count: 0 } };
    st.phase = 'hot';
    st.cursor = undefined;
    this.delta = { hot: { bytes: 0, count: 0 }, cold: { bytes: 0, count: 0 } };
    void this.ports.metrics
      .record([
        { metric: 'storage.hot', labels: {}, t: now, v: st.usage.hot.bytes },
        { metric: 'storage.cold', labels: {}, t: now, v: st.usage.cold.bytes },
      ])
      .catch(() => {});
  }

  // ───────────── status (action, health, cards) ─────────────

  async status(): Promise<TieringStatusOutput> {
    const cfg = this.config();
    if (cfg.cold) await this.ensureCold();
    const st = await this.state();
    const u = await this.usage();
    let hot: TierUsage | null = st.usage ? u.hot : null;
    let cold: TierUsage | null = st.usage ? u.cold : null;
    if (!st.usage) {
      hot = await this.quickCount('hot');
      cold = this.cold ? await this.quickCount('cold') : null;
    }
    const frac = (used: TierUsage | null, max?: number) =>
      used && max ? Math.min(1, used.bytes / max) : null;
    const hotStore = this.kernel.config().blobStorage;
    const tiers: TierStatus[] = [
      {
        tier: 'hot',
        label: 'Main storage',
        configured: true,
        usedBytes: hot?.bytes ?? null,
        count: hot?.count ?? null,
        maxBytes: cfg.hot.maxBytes ?? null,
        fraction: frac(hot, cfg.hot.maxBytes),
        technical: `hot: ${this.store.hot.kind} (blobStorage.driver=${hotStore.driver})${cfg.hot.maxBytes ? `, maxBytes=${cfg.hot.maxBytes}` : ''}`,
      },
    ];
    if (cfg.cold) {
      tiers.push({
        tier: 'cold',
        label: 'Cheaper storage',
        configured: true,
        usedBytes: cold?.bytes ?? null,
        count: cold?.count ?? null,
        maxBytes: cfg.cold.maxBytes ?? null,
        fraction: frac(cold, cfg.cold.maxBytes),
        technical: `cold: ${this.cold?.kind ?? 'unavailable'} (driver=${cfg.cold.store.driver}${cfg.cold.store.bucket ? `, bucket=${cfg.cold.store.bucket}` : ''}), afterDays=${cfg.cold.afterDays}, minSizeBytes=${cfg.cold.minSizeBytes}, promoteOnAccess=${cfg.cold.promoteOnAccess}`,
      });
    }
    return {
      enabled: !!cfg.cold,
      tiers,
      afterDays: cfg.cold?.afterDays ?? null,
      whenHotFull: cfg.whenHotFull,
      job: {
        lastRun: st.lastRun ?? null,
        nextRun: st.nextRun ?? null,
        moved: st.moved,
        movedBytes: st.movedBytes,
        failed: st.failed,
        lastError: st.lastError ?? null,
        totalMoved: st.totalMoved,
        totalFailed: st.totalFailed,
        inProgress: st.phase !== 'hot' || !!st.cursor,
      },
      countedAt: st.usage?.at ?? null,
      error: cfg.cold && !this.cold ? (this.coldError ?? 'Cheaper storage is not reachable') : null,
    };
  }
}
