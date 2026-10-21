// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Blossom domain logic shared by the HTTP routes, admin actions and the GC job.
 * Bytes live in the shared, content-addressed `ports.blobs` (deduped across
 * virtual relays); who owns what, per relay, lives in `ports.blobIndex`.
 */
import type { BlobOwnership, Decision, Kernel, Ports, RelayConfig, RelayId } from '@beamhop/core';
import {
  BlossomError,
  DEFAULT_TYPE,
  extFor,
  formatBytes,
  hashMismatch,
  hashingStream,
  readLimited,
  sha256Hex,
  typeAllowed,
  xTagMismatch,
} from './util.ts';

export const HOLDS_SERVICE = 'lifecycle.holds';

/** Structural view of lifecycle's legal-hold registry. */
export interface LegalHoldsLike {
  isHeld(relayId: RelayId, subject: { pubkey?: string; sha256?: string }): Promise<boolean>;
  active?(): boolean;
}

export interface BlossomOptions {
  /** fetch used for BUD-04 mirroring (tests inject a mock remote). Default global fetch. */
  fetch?: (req: Request) => Promise<Response>;
  /** Allow mirroring from localhost / private network addresses. Default false. */
  allowPrivateMirrorHosts?: boolean;
  /** Orphan GC interval. Default 3600 s. */
  gcIntervalSeconds?: number;
  /** Max blobs inspected per GC run (the sweep resumes where it stopped). Default 5000. */
  gcMaxScan?: number;
  /** Tolerated clock skew for auth `created_at`. Default 60 s. */
  authSkewSeconds?: number;
  /** Mirror download timeout. Default 60 s. */
  mirrorTimeoutMs?: number;
}

/** BUD-02 blob descriptor. */
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

export interface RelayCtx {
  relay: RelayConfig;
  /** Public base URL without trailing slash. */
  publicUrl: string;
  host: string;
}

export interface UploadLimits {
  tier: string;
  maxBlobBytes: number;
  quotaBytes: number;
  usedBytes: number;
  /** True when the quota comes from an admin override. */
  quotaOverridden: boolean;
}

export interface IngestParams {
  ctx: RelayCtx;
  pubkey: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
  type: string;
  /** Hash the client says the bytes have (X-SHA-256 or a single auth `x` tag). Verified. */
  declaredSha?: string;
  /** Exact size if known (Content-Length). Enables streaming straight into the store. */
  declaredSize?: number;
  /** Where `declaredSha` came from: a mismatch is a bad upload (header) or an auth problem (auth). */
  shaSource?: 'header' | 'auth';
  /** Auth `x` tags; when non-empty the computed hash must be one of them. */
  allowedHashes?: string[];
}

export interface IngestResult {
  descriptor: BlobDescriptor;
  /** Bytes were newly written to the blob store (false = deduplicated). */
  stored: boolean;
  quarantined: boolean;
}

/** Owner recorded for uploads made without auth when `blossom.requireAuth` is off. */
export const ANONYMOUS = 'anonymous';

export const QUOTAS = 'blossom.quotas';
export const QUARANTINE = 'blossom.quarantine';
export const STATE = 'blossom.state';

export interface QuarantineRecord {
  reason: string;
  relayId: RelayId;
  by?: string;
  at: number;
}

/** Optional view of `kernel.use('media')` (media module): the thumbnail of a blob. */
export interface MediaThumbnailsLike {
  thumbnailOf?(sha256: string): Promise<{ sha256: string; type: string } | null>;
}

export class BlossomService {
  /** Public base URL per relay, learned from routed requests (`route.publicUrl`). */
  private readonly publicUrls = new Map<RelayId, string>();

  constructor(
    readonly kernel: Kernel,
    readonly opts: BlossomOptions = {},
  ) {}

  /** Remember the relay's public URL as the runtime resolved it for a request. */
  notePublicUrl(relayId: RelayId, publicUrl: string): void {
    if (/^https?:\/\//.test(publicUrl)) this.publicUrls.set(relayId, publicUrl.replace(/\/+$/, ''));
  }

  /** The last `route.publicUrl` seen for a relay (no config fallback), or null. */
  learnedPublicUrl(relayId: RelayId): string | null {
    return this.publicUrls.get(relayId) ?? null;
  }

  /**
   * Absolute public base URL of a relay's media server (no trailing slash), for links
   * built outside a request (admin actions): the last `route.publicUrl` seen for the
   * relay, else derived from config (`hosts[0]`, `node.tls`, `pathPrefix`).
   */
  publicUrlFor(relayId: RelayId): string | null {
    const learned = this.publicUrls.get(relayId);
    if (learned) return learned;
    const relay = this.kernel.relay(relayId);
    const host = relay?.hosts.find((h) => h && !h.includes('*'));
    if (!relay || !host) return null;
    const secure = this.kernel.config().node.tls.mode !== 'off';
    const prefix = (relay.pathPrefix ?? '').replace(/\/+$/, '');
    return `${secure ? 'https' : 'http'}://${host}${prefix}`;
  }

  /** Absolute URL of a blob on a relay (`<publicUrl>/<sha256>.<ext>`), or null. */
  blobUrl(relayId: RelayId, sha256: string, type: string): string | null {
    const base = this.publicUrlFor(relayId);
    return base ? `${base}/${sha256}${extFor(type)}` : null;
  }

  /** Absolute URL of the blob's thumbnail (media module variants), or null. */
  async thumbUrl(relayId: RelayId, sha256: string): Promise<string | null> {
    const media = this.kernel.use<MediaThumbnailsLike>('media');
    if (!media?.thumbnailOf) return null;
    const t = await media.thumbnailOf(sha256);
    return t ? this.blobUrl(relayId, t.sha256, t.type) : null;
  }

  get ports(): Ports {
    return this.kernel.ports;
  }

  // ───────────── limits / tiers / quotas ─────────────

  async tierOf(relay: RelayConfig, pubkey: string): Promise<string> {
    for (const a of this.kernel.access) {
      const t = await a.tierOf?.(relay.id, pubkey);
      if (t !== undefined) return t;
    }
    return relay.defaultTier;
  }

  async quotaOverride(relayId: RelayId, pubkey: string): Promise<number | undefined> {
    const v = await this.ports.docs.get<{ quotaBytes: number }>(QUOTAS, `${relayId}:${pubkey}`);
    return v?.quotaBytes;
  }

  async setQuotaOverride(relayId: RelayId, pubkey: string, quotaBytes: number | null) {
    const key = `${relayId}:${pubkey}`;
    if (quotaBytes === null) await this.ports.docs.delete(QUOTAS, key);
    else await this.ports.docs.put(QUOTAS, key, { quotaBytes });
  }

  /** Effective storage limit: admin override → tier → relay media setting → goals. */
  async quotaFor(
    relay: RelayConfig,
    pubkey: string,
    tier?: string,
  ): Promise<{ tier: string; quotaBytes: number; overridden: boolean }> {
    const t = tier ?? (await this.tierOf(relay, pubkey));
    const lim = this.kernel.limits(relay.id, t);
    const tierDef = relay.tiers.find((x) => x.id === t);
    const override = await this.quotaOverride(relay.id, pubkey);
    return {
      tier: t,
      quotaBytes:
        override ??
        tierDef?.blobQuotaBytes ??
        relay.blossom.defaultQuotaBytes ??
        lim.defaultBlobQuotaBytes,
      overridden: override !== undefined,
    };
  }

  async limitsFor(relay: RelayConfig, pubkey: string): Promise<UploadLimits> {
    const q = await this.quotaFor(relay, pubkey);
    const lim = this.kernel.limits(relay.id, q.tier);
    const tierDef = relay.tiers.find((t) => t.id === q.tier);
    return {
      tier: q.tier,
      maxBlobBytes: tierDef?.maxBlobBytes ?? relay.blossom.maxBlobBytes ?? lim.maxBlobBytes,
      quotaBytes: q.quotaBytes,
      usedBytes: await this.ports.blobIndex.usage(relay.id, pubkey),
      quotaOverridden: q.overridden,
    };
  }

  /** BUD-06 style pre-flight checks shared by HEAD /upload and the upload itself. */
  checkUpload(
    relay: RelayConfig,
    limits: UploadLimits,
    info: { size?: number; type?: string; alreadyOwned?: boolean },
  ): void {
    if (info.type && !typeAllowed(info.type, relay.blossom.allowedTypes)) {
      throw new BlossomError(415, `This server does not accept ${info.type} files`);
    }
    if (info.size !== undefined && info.size > limits.maxBlobBytes) {
      throw new BlossomError(413, `File is too large (limit ${formatBytes(limits.maxBlobBytes)})`);
    }
    if (
      info.size !== undefined &&
      !info.alreadyOwned &&
      limits.usedBytes + info.size > limits.quotaBytes
    ) {
      throw new BlossomError(
        413,
        `Storage quota exceeded (${formatBytes(limits.usedBytes)} of ${formatBytes(limits.quotaBytes)} used)`,
      );
    }
  }

  // ───────────── quarantine / policy ─────────────

  async quarantined(sha256: string): Promise<QuarantineRecord | null> {
    return this.ports.docs.get<QuarantineRecord>(QUARANTINE, sha256);
  }

  async quarantine(relayId: RelayId, sha256: string, reason: string, by?: string): Promise<void> {
    await this.ports.docs.put<QuarantineRecord>(QUARANTINE, sha256, {
      reason,
      relayId,
      by,
      at: this.ports.clock.now(),
    });
    this.kernel.bus.emit('blob.quarantined', { relayId, sha256, reason });
  }

  async uploadPolicy(
    relay: RelayConfig,
    tier: string,
    info: { sha256: string; size: number; type: string; pubkey: string },
  ): Promise<Decision & { by?: string }> {
    const d = await this.kernel.policy.run('onUpload', [
      info,
      { relayId: relay.id, now: this.ports.clock.now(), tier },
    ]);
    if (d.action === 'reject') throw new BlossomError(403, d.message || 'Upload refused');
    return d;
  }

  // ───────────── ingest ─────────────

  descriptor(publicUrl: string, o: Pick<BlobOwnership, 'sha256' | 'size' | 'type' | 'uploadedAt'>) {
    return {
      url: `${publicUrl}/${o.sha256}${extFor(o.type)}`,
      sha256: o.sha256,
      size: o.size,
      type: o.type,
      uploaded: o.uploadedAt,
    } satisfies BlobDescriptor;
  }

  /**
   * Verify, dedupe and store an upload, then record per-relay ownership.
   * Ownership is written *before* bytes so the orphan GC can never collect a
   * blob that is mid-upload; it is rolled back if the upload fails.
   */
  async ingest(p: IngestParams): Promise<IngestResult> {
    const { relay } = p.ctx;
    const limits = await this.limitsFor(relay, p.pubkey);
    const allowed = p.allowedHashes ?? [];
    if (p.declaredSha && allowed.length && !allowed.includes(p.declaredSha)) {
      throw xTagMismatch();
    }
    this.checkUpload(relay, limits, { type: p.type });
    if (p.declaredSize !== undefined && p.declaredSize > limits.maxBlobBytes) {
      this.checkUpload(relay, limits, { size: p.declaredSize });
    }

    // Streaming path: hash + size known up front, verify while writing.
    if (p.declaredSha && p.declaredSize !== undefined && !(p.body instanceof Uint8Array)) {
      const sha = p.declaredSha;
      const prep = await this.prepare(p, limits, sha, p.declaredSize);
      const hs = hashingStream({
        limit: limits.maxBlobBytes,
        limitReason: `File is too large (limit ${formatBytes(limits.maxBlobBytes)})`,
        expectedSha: sha,
        expectedSize: p.declaredSize,
        mismatch: p.shaSource === 'auth' ? xTagMismatch() : hashMismatch(),
      });
      try {
        const verified = p.body.pipeThrough(hs.stream);
        if (prep.existing) await verified.pipeTo(new WritableStream());
        else
          await this.ports.blobs.put(
            { sha256: sha, size: p.declaredSize, type: prep.own.type },
            verified,
          );
        if (!hs.result()) throw new BlossomError(400, 'Upload incomplete');
      } catch (err) {
        await this.rollback(prep);
        throw hs.error() ?? toBlossomError(err);
      }
      return this.finish(p, prep);
    }

    // Buffered path: hash first, then store.
    const bytes =
      p.body instanceof Uint8Array
        ? p.body
        : await readLimited(
            p.body,
            limits.maxBlobBytes,
            `File is too large (limit ${formatBytes(limits.maxBlobBytes)})`,
          );
    if (bytes.length > limits.maxBlobBytes) this.checkUpload(relay, limits, { size: bytes.length });
    const sha = sha256Hex(bytes);
    if (allowed.length && !allowed.includes(sha)) throw xTagMismatch();
    if (p.declaredSha && sha !== p.declaredSha) {
      throw p.shaSource === 'auth' ? xTagMismatch() : hashMismatch();
    }
    const prep = await this.prepare(p, limits, sha, bytes.length);
    if (!prep.existing) {
      try {
        await this.ports.blobs.put({ sha256: sha, size: bytes.length, type: prep.own.type }, bytes);
      } catch (err) {
        await this.rollback(prep);
        throw toBlossomError(err);
      }
    }
    return this.finish(p, prep);
  }

  private async prepare(p: IngestParams, limits: UploadLimits, sha: string, size: number) {
    const { relay } = p.ctx;
    const prior = (await this.ports.blobIndex.owners(relay.id, sha)).find(
      (o) => o.pubkey === p.pubkey,
    );
    this.checkUpload(relay, limits, { size, alreadyOwned: !!prior });
    const decision = await this.uploadPolicy(relay, limits.tier, {
      sha256: sha,
      size,
      type: p.type,
      pubkey: p.pubkey,
    });
    const existing = await this.ports.blobs.head(sha);
    const own: BlobOwnership = prior ?? {
      relayId: relay.id,
      sha256: sha,
      pubkey: p.pubkey,
      size,
      type: existing?.type ?? p.type,
      uploadedAt: this.ports.clock.now(),
    };
    if (!prior) await this.ports.blobIndex.addOwner(own);
    return { prior, own, existing, decision };
  }

  private async rollback(prep: { prior?: BlobOwnership; own: BlobOwnership }): Promise<void> {
    if (prep.prior) return;
    await this.ports.blobIndex
      .removeOwner(prep.own.relayId, prep.own.sha256, prep.own.pubkey)
      .catch(() => false);
  }

  private async finish(
    p: IngestParams,
    prep: {
      own: BlobOwnership;
      existing: unknown;
      decision: Decision & { by?: string };
    },
  ): Promise<IngestResult> {
    const { relay } = p.ctx;
    let quarantined = false;
    if (prep.decision.action === 'hold' || prep.decision.action === 'shadow') {
      quarantined = true;
      await this.quarantine(
        relay.id,
        prep.own.sha256,
        prep.decision.message ?? 'Held for review',
        prep.decision.by,
      );
    }
    this.kernel.bus.emit('blob.uploaded', {
      relayId: relay.id,
      sha256: prep.own.sha256,
      size: prep.own.size,
      type: prep.own.type,
      pubkey: p.pubkey,
    });
    return {
      descriptor: this.descriptor(p.ctx.publicUrl, prep.own),
      stored: !prep.existing,
      quarantined,
    };
  }

  // ───────────── deletion / GC ─────────────

  /**
   * Legal hold (§12.7, `kernel.use('lifecycle.holds')`): bytes are shared by all
   * virtual relays, so they are frozen when any relay holds the hash (or the
   * last owner, when known). Errors count as held (fail safe).
   */
  async bytesHeld(sha256: string, owner?: { relayId: RelayId; pubkey: string }): Promise<boolean> {
    const holds = this.kernel.use<LegalHoldsLike>(HOLDS_SERVICE);
    if (!holds || (typeof holds.active === 'function' && !holds.active())) return false;
    try {
      if (owner && (await holds.isHeld(owner.relayId, { sha256, pubkey: owner.pubkey })))
        return true;
      for (const r of this.kernel.config().relays)
        if (await holds.isHeld(r.id, { sha256 })) return true;
      return false;
    } catch {
      return true;
    }
  }

  /** Is this relay's ownership row frozen by a legal hold? Errors count as held. */
  async ownershipHeld(o: { relayId: RelayId; sha256: string; pubkey: string }): Promise<boolean> {
    const holds = this.kernel.use<LegalHoldsLike>(HOLDS_SERVICE);
    if (!holds || (typeof holds.active === 'function' && !holds.active())) return false;
    try {
      return await holds.isHeld(o.relayId, { sha256: o.sha256, pubkey: o.pubkey });
    } catch {
      return true;
    }
  }

  /** Delete bytes when no relay owns the blob any more (and no legal hold freezes them). */
  async collect(sha256: string, owner?: { relayId: RelayId; pubkey: string }): Promise<boolean> {
    if ((await this.ports.blobIndex.refCount(sha256)) > 0) return false;
    if (await this.bytesHeld(sha256, owner)) return false;
    const erased = await this.ports.blobs.delete(sha256);
    await this.ports.docs.delete(QUARANTINE, sha256);
    return erased;
  }

  async removeOwnership(
    relayId: RelayId,
    sha256: string,
    pubkey: string,
    cause: string,
  ): Promise<{ removed: boolean; erased: boolean }> {
    const removed = await this.ports.blobIndex.removeOwner(relayId, sha256, pubkey);
    if (!removed) return { removed, erased: false };
    this.kernel.bus.emit('blob.deleted', { relayId, sha256, pubkey, cause });
    return { removed, erased: await this.collect(sha256, { relayId, pubkey }) };
  }

  /** One GC pass: drop expired ownerships, then sweep orphaned bytes. */
  async gc(): Promise<{ expired: number; erased: number; scanned: number }> {
    const now = this.ports.clock.now();
    let expired = 0;
    let erased = 0;
    for (;;) {
      const batch = await this.ports.blobIndex.expired(now, 200);
      if (batch.length === 0) break;
      let progressed = false;
      for (const o of batch) {
        // Legal hold (§12.7): a held ownership is not expired; check again tomorrow.
        if (await this.ownershipHeld(o)) {
          await this.ports.blobIndex.addOwner({ ...o, expiresAt: now + 86_400 });
          progressed = true;
          continue;
        }
        const r = await this.removeOwnership(o.relayId, o.sha256, o.pubkey, 'expired');
        if (r.removed) {
          progressed = true;
          expired++;
        }
        if (r.erased) erased++;
      }
      if (!progressed) break;
    }

    const max = this.opts.gcMaxScan ?? 5000;
    const state = (await this.ports.docs.get<{ cursor?: string }>(STATE, 'gc')) ?? {};
    let cursor = state.cursor;
    let scanned = 0;
    while (scanned < max) {
      const page = await this.ports.blobs.list({ cursor, limit: Math.min(200, max - scanned) });
      for (const b of page.items) {
        scanned++;
        if (await this.collect(b.sha256)) erased++;
      }
      cursor = page.cursor;
      if (!cursor) break;
    }
    await this.ports.docs.put(STATE, 'gc', { cursor, lastRun: now });
    return { expired, erased, scanned };
  }
}

export function toBlossomError(err: unknown): BlossomError {
  if (err instanceof BlossomError) return err;
  return new BlossomError(500, 'Storage error');
}

export { DEFAULT_TYPE };
