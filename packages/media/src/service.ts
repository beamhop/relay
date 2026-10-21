// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Media pipeline service: abuse scanning (perceptual hashes vs. configured
 * lists) and derivative variants (thumbnail + responsive sizes, video
 * transcode + poster), driven by `blob.uploaded` and run on a bounded queue
 * so uploads are never blocked.
 *
 * Storage (DocStore):
 * - `media.hashes`     sha256 → HashRecord (pHash, dHash, dims, BlurHash)
 * - `media.variants`   original sha256 → VariantRecord
 * - `media.variant-of` variant sha256 → { original }
 * - `media.pending`    `${relayId}:${sha256}` → scans not finished (re-queued after a restart)
 * - `media.matches`    `${at}:${sha256}` → MatchRecord (audit trail of list matches)
 *
 * Variant bytes are ordinary content-addressed blobs owned (BlobIndex) by the
 * synthetic owner `media-variant` in each relay that owns the original, so they
 * are served by BUD-01, survive the orphan GC, and do not count against quotas.
 */
import {
  ACCEPT,
  type AppEvents,
  type Kernel,
  type MediaOp,
  type MediaProcessor,
  type PolicyHooks,
  type RelayConfig,
  type RelayId,
  reject,
} from '@beamhop/core';
import { processorAccepts } from './composite.ts';
import { type MediaConfig, MediaConfigSchema } from './config.ts';
import { HashListCache, type ListLoaderOptions, type ListMatch, matchHashes } from './lists.ts';
import { WorkQueue } from './queue.ts';

export const HASHES = 'media.hashes';
export const VARIANTS = 'media.variants';
export const VARIANT_OF = 'media.variant-of';
export const PENDING = 'media.pending';
export const MATCHES = 'media.matches';
/** BlobIndex owner of derivative variants. */
export const VARIANT_OWNER = 'media-variant';
/** Blossom's quarantine collection (fallback when the blossom service is absent). */
const BLOSSOM_QUARANTINE = 'blossom.quarantine';

export type VariantRole = 'thumbnail' | 'responsive' | 'transcode' | 'poster';

export interface VariantInfo {
  sha256: string;
  type: string;
  size: number;
  width?: number;
  height?: number;
  role: VariantRole;
}

export interface VariantRecord {
  sha256: string;
  type: string;
  width?: number;
  height?: number;
  blurhash?: string;
  variants: VariantInfo[];
  at: number;
}

export interface HashRecord {
  phash?: string;
  dhash?: string;
  width?: number;
  height?: number;
  blurhash?: string;
  type: string;
  at: number;
}

export interface MatchRecord extends ListMatch {
  relayId: RelayId;
  sha256: string;
  at: number;
}

export interface MediaOptions extends Pick<ListLoaderOptions, 'fetch' | 'readFile'> {
  /** Processor override (default `kernel.ports.media`). */
  processor?: MediaProcessor;
}

/** The subset of `@beamhop/blossom`'s BlossomService the media module uses. */
interface BlossomLike {
  quarantine(relayId: RelayId, sha256: string, reason: string, by?: string): Promise<void>;
  quarantined(sha256: string): Promise<unknown | null>;
  collect?(sha256: string): Promise<boolean>;
}

export const SCAN_HOOK_ID = 'media.scan';
export const MATCH_REASON = 'Matched a known-abuse image list';

export function mediaKind(type: string): 'image' | 'video' | null {
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image';
  if (type.startsWith('video/')) return 'video';
  return null;
}

/** True when uploads to this relay must pass an abuse scan before being served. */
export function scanGated(relay: RelayConfig): boolean {
  return (
    relay.blossom.enabled &&
    relay.blossom.scanning.enabled &&
    relay.blossom.scanning.lists.length > 0
  );
}

export class MediaService {
  readonly queue: WorkQueue;
  readonly lists: HashListCache;
  /** sha256 → completion of an in-flight gated scan. */
  readonly pending = new Map<string, Promise<void>>();
  private scanErrors = 0;

  constructor(
    readonly kernel: Kernel,
    readonly opts: MediaOptions = {},
  ) {
    const cfg = this.config();
    this.queue = new WorkQueue({
      concurrency: cfg.concurrency,
      maxQueued: cfg.maxQueued,
      onError: (err, key) =>
        kernel.ports.logger.log('warn', 'media job failed', { job: key, error: String(err) }),
    });
    this.lists = new HashListCache({
      fetch: opts.fetch,
      readFile: opts.readFile,
      now: () => kernel.ports.clock.now(),
    });
  }

  get processor(): MediaProcessor | undefined {
    return this.opts.processor ?? this.kernel.ports.media;
  }

  config(): MediaConfig {
    return this.kernel.moduleConfig<MediaConfig>('media') ?? MediaConfigSchema.parse({});
  }

  /** Apply queue tuning after a config change. */
  reconfigure(): void {
    const cfg = this.config();
    this.queue.concurrency = cfg.concurrency;
    this.queue.maxQueued = cfg.maxQueued;
  }

  get failedScans(): number {
    return this.scanErrors;
  }

  can(op: MediaOp['op'], type: string): boolean {
    return processorAccepts(this.processor, { op }, type);
  }

  private get blossom(): BlossomLike | undefined {
    return this.kernel.use<BlossomLike>('blossom');
  }

  async isQuarantined(sha256: string): Promise<boolean> {
    const b = this.blossom;
    const rec = b
      ? await b.quarantined(sha256)
      : await this.kernel.ports.docs.get(BLOSSOM_QUARANTINE, sha256);
    return rec !== null && rec !== undefined;
  }

  /** All list sources configured across relays. */
  listSources(): string[] {
    const out = new Set<string>();
    for (const r of this.kernel.config().relays) {
      if (r.blossom.enabled && r.blossom.scanning.enabled) {
        for (const s of r.blossom.scanning.lists) out.add(s);
      }
    }
    return [...out];
  }

  async refreshLists(): Promise<void> {
    await this.lists.refresh(this.listSources());
  }

  // ───────────── event handlers ─────────────

  onUploaded(e: AppEvents['blob.uploaded']): void {
    const relay = this.kernel.relay(e.relayId);
    if (!relay?.blossom.enabled || e.pubkey === VARIANT_OWNER) return;
    const kind = mediaKind(e.type);
    if (kind === 'image' && this.can('perceptual-hash', e.type)) {
      this.enqueueScan(relay, e.sha256, e.type);
    } else if (kind) {
      this.enqueueVariants(relay.id, e.sha256, e.type);
    }
  }

  private readonly cleanups = new Set<Promise<void>>();

  onDeleted(e: AppEvents['blob.deleted']): void {
    if (e.pubkey === VARIANT_OWNER) return;
    const p: Promise<void> = this.cleanupVariants(e.relayId, e.sha256)
      .catch((err) =>
        this.kernel.ports.logger.log('warn', 'media variant cleanup failed', {
          sha256: e.sha256,
          error: String(err),
        }),
      )
      .finally(() => this.cleanups.delete(p));
    this.cleanups.add(p);
  }

  /** Resolves once pending variant clean-ups (after deletions, e.g. a vanish) are done. */
  async cleanupsSettled(): Promise<void> {
    while (this.cleanups.size) await Promise.allSettled([...this.cleanups]);
  }

  // ───────────── scanning ─────────────

  /** Queue a (high-priority) scan; when the relay is scan-gated, serving waits for it. */
  enqueueScan(relay: RelayConfig, sha256: string, type: string): Promise<void> {
    const gated = scanGated(relay);
    const docs = this.kernel.ports.docs;
    const pendingKey = `${relay.id}:${sha256}`;
    const r = this.queue.push(
      async () => {
        try {
          const match = await this.scan(relay.id, sha256, type);
          // Queued from inside the job so `onIdle()` also covers the follow-up work.
          if (!match) this.enqueueVariants(relay.id, sha256, type);
        } catch (err) {
          this.scanErrors++;
          throw err;
        } finally {
          if (gated) await docs.delete(PENDING, pendingKey).catch(() => false);
        }
      },
      { priority: 'high', key: `scan:${relay.id}:${sha256}` },
    );
    if (gated) {
      this.pending.set(sha256, r.done);
      void docs
        .put(PENDING, pendingKey, { type, at: this.kernel.ports.clock.now() })
        .catch(() => {});
      void r.done.then(() => {
        if (this.pending.get(sha256) === r.done) this.pending.delete(sha256);
      });
    }
    return r.done;
  }

  /** Re-queue scans that were interrupted by a restart. */
  async sweepPending(): Promise<number> {
    let n = 0;
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<{ type: string }>(PENDING, {
        cursor,
        limit: 200,
      });
      for (const { key, value } of page.items) {
        const i = key.indexOf(':');
        const relay = this.kernel.relay(key.slice(0, i));
        const sha = key.slice(i + 1);
        if (!relay || this.pending.has(sha)) {
          if (!relay) await this.kernel.ports.docs.delete(PENDING, key);
          continue;
        }
        void this.enqueueScan(relay, sha, value.type);
        n++;
      }
      cursor = page.cursor;
    } while (cursor);
    return n;
  }

  /**
   * Hash `sha256` (cached) and compare with the relay's lists; quarantine on a match.
   * Returns the match, or null.
   */
  async scan(
    relayId: RelayId,
    sha256: string,
    type: string,
    o: { force?: boolean } = {},
  ): Promise<ListMatch | null> {
    const relay = this.kernel.relay(relayId);
    if (!relay) return null;
    const rec = await this.hashesFor(sha256, type, o.force);
    if (!rec || !scanGated(relay)) return null;
    const lists = await this.lists.get(relay.blossom.scanning.lists);
    const m = matchHashes(rec, lists, this.config().matchThreshold);
    if (m) await this.quarantineMatch(relayId, sha256, m);
    return m;
  }

  /** Perceptual hashes of a stored blob (cached in `media.hashes`). */
  async hashesFor(sha256: string, type: string, force = false): Promise<HashRecord | null> {
    const docs = this.kernel.ports.docs;
    if (!force) {
      const cached = await docs.get<HashRecord>(HASHES, sha256);
      if (cached) return cached;
    }
    const proc = this.processor;
    if (!proc || !this.can('perceptual-hash', type)) return null;
    const bytes = await this.read(sha256);
    if (!bytes) return null;
    const [p, d] = await proc.process(bytes, type, [
      { op: 'perceptual-hash', format: 'phash' },
      { op: 'perceptual-hash', format: 'dhash' },
    ]);
    const rec: HashRecord = {
      phash: p?.hash,
      dhash: d?.hash && d.hash !== p?.hash ? d.hash : undefined,
      width: p?.width,
      height: p?.height,
      blurhash: p?.blurhash,
      type,
      at: this.kernel.ports.clock.now(),
    };
    await docs.put(HASHES, sha256, rec);
    return rec;
  }

  async quarantineMatch(relayId: RelayId, sha256: string, m: ListMatch): Promise<void> {
    const { ports, bus } = this.kernel;
    const now = ports.clock.now();
    const blossom = this.blossom;
    if (blossom) await blossom.quarantine(relayId, sha256, MATCH_REASON, SCAN_HOOK_ID);
    else {
      await ports.docs.put(BLOSSOM_QUARANTINE, sha256, {
        reason: MATCH_REASON,
        relayId,
        by: SCAN_HOOK_ID,
        at: now,
      });
      bus.emit('blob.quarantined', { relayId, sha256, reason: MATCH_REASON });
    }
    const record: MatchRecord = { ...m, relayId, sha256, at: now };
    await ports.docs.put(MATCHES, `${String(now).padStart(12, '0')}:${sha256}`, record);
    const summary = `Blocked a file that matched a known-abuse list (${m.algo}, distance ${m.distance})`;
    // Audit trail: system-originated entry on the admin action stream.
    bus.emit('admin.action', {
      relayId,
      actionId: 'media.scan-match',
      principalId: 'system:media',
      input: { sha256, source: m.source, algo: m.algo, distance: m.distance },
      summary,
      ok: true,
    });
    ports.logger.log('warn', 'media scan match: blob quarantined', {
      relayId,
      sha256,
      algo: m.algo,
      distance: m.distance,
    });
    try {
      await this.kernel.notify({
        severity: 'critical',
        category: 'safety',
        title: 'A blocked image was uploaded',
        body: 'An upload matched a known-abuse image list. It was blocked and is never shown to anyone. Review it in Moderation.',
        relayId,
      });
    } catch (err) {
      ports.logger.log('error', 'media scan notify failed', { error: String(err) });
    }
  }

  /** Policy hook: hold fresh uploads until scanned; never serve variants of blocked files. */
  serveHook(): PolicyHooks {
    return {
      id: SCAN_HOOK_ID,
      priority: 210,
      onBlobServe: async (sha256) => {
        const pending = this.pending.get(sha256);
        if (pending) {
          const settled = await settleWithin(pending, this.config().scanWaitMs);
          if (!settled) return { action: 'hold', message: 'This file is still being checked' };
          if (await this.isQuarantined(sha256))
            return reject('blocked', 'This file is unavailable');
        }
        const v = await this.kernel.ports.docs.get<{ original: string }>(VARIANT_OF, sha256);
        if (v && (await this.isQuarantined(v.original))) {
          return reject('blocked', 'This file is unavailable');
        }
        return ACCEPT;
      },
    };
  }

  // ───────────── variants ─────────────

  variantOps(relay: RelayConfig, type: string): Array<{ op: MediaOp; role: VariantRole }> {
    const opt = relay.blossom.optimize;
    const cfg = this.config();
    const out: Array<{ op: MediaOp; role: VariantRole }> = [];
    const kind = mediaKind(type);
    if (kind === 'image') {
      const thumb: MediaOp = {
        op: 'thumbnail',
        width: cfg.thumbnailSize,
        height: cfg.thumbnailSize,
        format: cfg.format,
        quality: Math.min(cfg.quality, 75),
      };
      if (opt.thumbnails && this.can('thumbnail', type)) out.push({ op: thumb, role: 'thumbnail' });
      if (opt.resize && this.can('resize', type)) {
        for (const width of [...new Set(cfg.sizes)].sort((a, b) => a - b)) {
          out.push({
            op: { op: 'resize', width, format: cfg.format, quality: cfg.quality },
            role: 'responsive',
          });
        }
      }
    } else if (kind === 'video' && opt.transcode) {
      if (this.can('transcode', type)) {
        out.push({ op: { op: 'transcode', width: 1280, quality: cfg.quality }, role: 'transcode' });
      }
      if (this.can('thumbnail', type)) {
        out.push({ op: { op: 'thumbnail', width: 640 }, role: 'poster' });
      }
    }
    return out;
  }

  enqueueVariants(relayId: RelayId, sha256: string, type: string): boolean {
    const relay = this.kernel.relay(relayId);
    if (!relay || this.variantOps(relay, type).length === 0) return false;
    const r = this.queue.push(() => this.generateVariants(relayId, sha256, type).then(() => {}), {
      key: `variants:${relayId}:${sha256}`,
    });
    if (!r.accepted) {
      this.kernel.ports.logger.log('warn', 'media queue full: skipped variants', { sha256 });
    }
    return r.accepted;
  }

  /** Generate (or re-own) variants of `sha256` for `relayId`. */
  async generateVariants(
    relayId: RelayId,
    sha256: string,
    type: string,
    o: { force?: boolean } = {},
  ): Promise<VariantRecord | null> {
    const { ports } = this.kernel;
    const relay = this.kernel.relay(relayId);
    if (!relay) return null;
    if (await this.isQuarantined(sha256)) return null;
    if ((await ports.blobIndex.owners(relayId, sha256)).length === 0) return null;
    const proc = this.processor;
    const existing = o.force ? null : await ports.docs.get<VariantRecord>(VARIANTS, sha256);
    if (existing) {
      let intact = true;
      for (const v of existing.variants) {
        if (!(await ports.blobs.head(v.sha256))) intact = false;
      }
      if (intact) {
        for (const v of existing.variants) await this.own(relayId, v);
        return existing;
      }
    }
    const ops = this.variantOps(relay, type);
    if (!proc || ops.length === 0) return null;
    const bytes = await this.read(sha256);
    if (!bytes) return null;
    const hashes = await ports.docs.get<HashRecord>(HASHES, sha256);
    const variants: VariantInfo[] = [];
    for (const { op, role } of ops) {
      let res: Awaited<ReturnType<MediaProcessor['process']>>[number] | undefined;
      try {
        [res] = await proc.process(bytes, type, [op]);
      } catch (err) {
        ports.logger.log('warn', 'media variant failed', { sha256, op: op.op, error: String(err) });
        continue;
      }
      if (!res?.data) continue;
      // A "smaller copy" that is not smaller than the original is pointless.
      if (role === 'responsive' && hashes?.width && res.width && res.width >= hashes.width)
        continue;
      if (variants.some((v) => v.role === role && v.width === res.width)) continue;
      const vsha = await ports.crypto.sha256Hex(res.data);
      if (vsha === sha256 || variants.some((v) => v.sha256 === vsha)) continue;
      const info: VariantInfo = {
        sha256: vsha,
        type: res.type ?? type,
        size: res.data.byteLength,
        width: res.width,
        height: res.height,
        role,
      };
      await this.own(relayId, info);
      if (!(await ports.blobs.head(vsha))) {
        await ports.blobs.put({ sha256: vsha, size: info.size, type: info.type }, res.data);
      }
      await ports.docs.put(VARIANT_OF, vsha, { original: sha256 });
      variants.push(info);
    }
    const rec: VariantRecord = {
      sha256,
      type,
      width: hashes?.width,
      height: hashes?.height,
      blurhash: hashes?.blurhash,
      variants,
      at: ports.clock.now(),
    };
    await ports.docs.put(VARIANTS, sha256, rec);
    return rec;
  }

  private async own(relayId: RelayId, v: VariantInfo): Promise<void> {
    const { blobIndex, clock } = this.kernel.ports;
    const owners = await blobIndex.owners(relayId, v.sha256);
    if (owners.some((o) => o.pubkey === VARIANT_OWNER)) return;
    await blobIndex.addOwner({
      relayId,
      sha256: v.sha256,
      pubkey: VARIANT_OWNER,
      size: v.size,
      type: v.type,
      uploadedAt: clock.now(),
    });
  }

  /** Drop this relay's variant ownerships once nobody in the relay owns the original. */
  async cleanupVariants(relayId: RelayId, sha256: string): Promise<void> {
    const { docs, blobIndex, blobs } = this.kernel.ports;
    if ((await blobIndex.owners(relayId, sha256)).length > 0) return;
    const rec = await docs.get<VariantRecord>(VARIANTS, sha256);
    for (const v of rec?.variants ?? []) {
      await blobIndex.removeOwner(relayId, v.sha256, VARIANT_OWNER);
      const b = this.blossom;
      if (b?.collect) await b.collect(v.sha256);
      else if ((await blobIndex.refCount(v.sha256)) === 0) await blobs.delete(v.sha256);
    }
    if ((await blobIndex.refCount(sha256)) === 0) {
      for (const v of rec?.variants ?? []) await docs.delete(VARIANT_OF, v.sha256);
      await docs.delete(VARIANTS, sha256);
      await docs.delete(HASHES, sha256);
    }
  }

  async variants(sha256: string): Promise<VariantRecord | null> {
    return this.kernel.ports.docs.get<VariantRecord>(VARIANTS, sha256);
  }

  /** The thumbnail (images) or poster (videos) variant of a blob, if one was made. */
  async thumbnailOf(sha256: string): Promise<VariantInfo | null> {
    const rec = await this.variants(sha256);
    return rec?.variants.find((v) => v.role === 'thumbnail' || v.role === 'poster') ?? null;
  }

  isProcessing(relayId: RelayId, sha256: string): boolean {
    return (
      this.queue.has(`scan:${relayId}:${sha256}`) || this.queue.has(`variants:${relayId}:${sha256}`)
    );
  }

  /** Read a stored blob fully, or null if missing / larger than `maxProcessBytes`. */
  private async read(sha256: string): Promise<Uint8Array | null> {
    const max = this.config().maxProcessBytes;
    const meta = await this.kernel.ports.blobs.head(sha256);
    if (!meta || meta.size > max) return null;
    const body = await this.kernel.ports.blobs.get(sha256);
    if (!body) return null;
    const buf = new Uint8Array(await new Response(body.body).arrayBuffer());
    return buf.byteLength > max ? null : buf;
  }
}

/** true if `p` settled within `ms`. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
