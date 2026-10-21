// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hot/cold tiering over two BlobStores (§4.2). New bytes go to the hot store
 * (fast disk / bucket); a background job (`@beamhop/blossom`) moves blobs
 * nobody has read for a while to the cheaper cold store. Reads are
 * transparent: hot first, then cold. The cold store is resolved lazily so it
 * can be configured (or removed) while running; without one this is a plain
 * pass-through to the hot store.
 *
 * Runtime-agnostic (Web streams only). Passes the BlobStore contract suite.
 */
import type { BlobBody, BlobMeta, BlobStore, ByteRange } from '@beamhop/core';

export type Tier = 'hot' | 'cold';

export interface TieredBlobStoreOptions {
  /** The cold store, or null when tiering is off. Called on every operation (cache it). */
  cold?: () => BlobStore | null;
  /**
   * Where a new blob goes. Default `'hot'`. May throw (e.g. "storage is full")
   * to refuse the write; the error reaches the caller of `put`.
   */
  placement?: (meta: BlobMeta) => Tier | Promise<Tier>;
  /** Called after a blob was read (`get`) from a tier (access tracking, promote-back). */
  onRead?: (sha256: string, tier: Tier) => void;
  /** Called after bytes were written to / removed from a tier (usage accounting). */
  onChange?: (tier: Tier, deltaBytes: number, deltaCount: number) => void;
}

/** Cursor prefix per tier: `h:<hot cursor>` / `c:<cold cursor>`. */
const HOT = 'h:';
const COLD = 'c:';

export class TieredBlobStore implements BlobStore {
  constructor(
    readonly hot: BlobStore,
    private readonly opts: TieredBlobStoreOptions = {},
  ) {}

  get kind(): string {
    return this.hot.kind;
  }

  /** The configured cold store, or null. */
  get cold(): BlobStore | null {
    return this.opts.cold?.() ?? null;
  }

  async init(): Promise<void> {
    await this.hot.init();
    await this.cold?.init();
  }

  /** Which tier holds the bytes (hot wins while a move is in flight), or null. */
  async tierOf(sha256: string): Promise<Tier | null> {
    if (await this.hot.head(sha256)) return 'hot';
    const cold = this.cold;
    if (cold && (await cold.head(sha256))) return 'cold';
    return null;
  }

  async put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    // Idempotent across tiers: never keep a second copy of bytes we already have.
    if (await this.tierOf(meta.sha256)) {
      if (!(data instanceof Uint8Array)) await data.cancel().catch(() => {});
      return;
    }
    const cold = this.cold;
    const tier = cold ? ((await this.opts.placement?.(meta)) ?? 'hot') : 'hot';
    if (!cold && this.opts.placement) await this.opts.placement(meta);
    const target = tier === 'cold' && cold ? cold : this.hot;
    await target.put(meta, data);
    this.opts.onChange?.(target === this.hot ? 'hot' : 'cold', meta.size, 1);
  }

  async get(sha256: string, range?: ByteRange): Promise<BlobBody | null> {
    const h = await this.hot.get(sha256, range);
    if (h) {
      this.opts.onRead?.(sha256, 'hot');
      return h;
    }
    const cold = this.cold;
    const c = cold ? await cold.get(sha256, range) : null;
    if (c) this.opts.onRead?.(sha256, 'cold');
    return c;
  }

  async head(sha256: string): Promise<BlobMeta | null> {
    const h = await this.hot.head(sha256);
    if (h) return h;
    return (await this.cold?.head(sha256)) ?? null;
  }

  async delete(sha256: string): Promise<boolean> {
    let any = false;
    for (const [tier, store] of this.stores()) {
      const meta = this.opts.onChange ? await store.head(sha256) : null;
      if (await store.delete(sha256)) {
        any = true;
        if (meta) this.opts.onChange?.(tier, -meta.size, -1);
      }
    }
    return any;
  }

  /** Hot items first, then cold. Old plain (un-prefixed) cursors continue the hot listing. */
  async list(opts: { cursor?: string; limit?: number } = {}): Promise<{
    items: BlobMeta[];
    cursor?: string;
  }> {
    const limit = opts.limit ?? 100;
    const cold = this.cold;
    let cur = opts.cursor;
    const items: BlobMeta[] = [];
    if (!cur || !cur.startsWith(COLD)) {
      const hotCursor = cur?.startsWith(HOT) ? cur.slice(HOT.length) || undefined : cur;
      const page = await this.hot.list({ cursor: hotCursor, limit });
      items.push(...page.items);
      if (page.cursor) return { items, cursor: HOT + page.cursor };
      if (!cold) return { items };
      if (items.length >= limit) return { items, cursor: COLD };
      cur = COLD;
    }
    if (!cold) return { items };
    const coldCursor = cur.slice(COLD.length) || undefined;
    const page = await cold.list({ cursor: coldCursor, limit: limit - items.length });
    items.push(...page.items);
    return page.cursor ? { items, cursor: COLD + page.cursor } : { items };
  }

  /** List one tier only (raw cursor of that store). */
  listTier(
    tier: Tier,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: BlobMeta[]; cursor?: string }> {
    const store = tier === 'hot' ? this.hot : this.cold;
    return store ? store.list(opts) : Promise.resolve({ items: [] });
  }

  /**
   * Move a blob to `to`: copy, verify the copy, then delete the source.
   * Idempotent and safe to interrupt (a crash leaves a copy in both tiers,
   * which reads tolerate and the next move cleans up).
   */
  async move(sha256: string, to: Tier): Promise<'moved' | 'already' | 'missing'> {
    const cold = this.cold;
    if (!cold) throw new Error('No cold storage is configured');
    const [src, dst] = to === 'cold' ? [this.hot, cold] : [cold, this.hot];
    const from: Tier = to === 'cold' ? 'hot' : 'cold';
    const meta = await src.head(sha256);
    if (!meta) return (await dst.head(sha256)) ? 'already' : 'missing';
    const existing = await dst.head(sha256);
    if (!existing) {
      const body = await src.get(sha256);
      if (!body) return 'missing';
      await dst.put(meta, body.body);
      const copied = await dst.head(sha256);
      if (!copied || copied.size !== meta.size) {
        await dst.delete(sha256).catch(() => false);
        throw new Error(`copy of ${sha256} to ${to} storage is incomplete`);
      }
      this.opts.onChange?.(to, meta.size, 1);
    }
    if (await src.delete(sha256)) this.opts.onChange?.(from, -meta.size, -1);
    return 'moved';
  }

  private stores(): Array<[Tier, BlobStore]> {
    const cold = this.cold;
    return cold
      ? [
          ['hot', this.hot],
          ['cold', cold],
        ]
      : [['hot', this.hot]];
  }
}

/**
 * Route an existing BlobStore object through tiering *in place* (every holder
 * of the object sees it), like `encryptInPlace`. Returns a function restoring
 * the original methods, and the TieredBlobStore whose `hot` is the original.
 */
export function tierInPlace(
  store: BlobStore,
  opts: TieredBlobStoreOptions,
): { tiered: TieredBlobStore; restore: () => void } {
  const target = store as unknown as Record<string, unknown>;
  const names = ['init', 'put', 'get', 'head', 'delete', 'list'] as const;
  const saved = names.map((n) => [n, Object.hasOwn(target, n), target[n]] as const);
  const inner: BlobStore = {
    kind: store.kind,
    init: store.init.bind(store),
    put: store.put.bind(store),
    get: store.get.bind(store),
    head: store.head.bind(store),
    delete: store.delete.bind(store),
    list: store.list.bind(store),
  };
  const tiered = new TieredBlobStore(inner, opts);
  for (const n of names) target[n] = (tiered[n] as (...a: unknown[]) => unknown).bind(tiered);
  return {
    tiered,
    restore() {
      for (const [n, own, fn] of saved) {
        if (own) target[n] = fn;
        else delete target[n];
      }
    },
  };
}
