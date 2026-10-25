import type { BlobRecord, BlobStatus, BlossomService, CoreDeps, Logger, StopContext, UserRecord } from "@beamhop/sdk";
import { nowSec as now, TaskTracker } from "@beamhop/sdk";
import { type ActionOpts, createAdminOps, releaseOwnership, retryPendingDeletes } from "./admin-ops";
import { Admission } from "./admission";
import { domainsFromPublicUrl } from "./auth";
import { DeleteTokens } from "./delete-tokens";
import { createBlobDriver, type BlobDriver } from "./driver";
import { streamToBytes } from "./driver/types";
import { createImageProcessor, type ImageProcessor } from "./image";
import { ingest, type IngestInput, KeyedLock } from "./ingest";
import { extFromMime, servedType, topLevelType } from "./mime";
import { BlobRepo, type BlobRow, isHidden } from "./repo";
import { TypePolicy } from "./type-policy";

export interface BlossomOptions {
  /** custom blob driver (default: createBlobDriver(config.blossom)) */
  driver?: BlobDriver;
  /** set false to disable sharp even if installed (pure-JS EXIF stripping, no thumbnails) */
  useSharp?: boolean;
  /** fetch used for BUD-04 mirroring */
  fetch?: typeof fetch;
  /** allow mirroring from loopback/private addresses (default false; SSRF protection) */
  allowPrivateMirror?: boolean;
  /** whole BUD-04 mirror transfer (connect, redirects, body), ms (default 30 s) */
  mirrorTimeoutMs?: number;
  /** destination ports BUD-04 mirroring may connect to (default 80, 443) */
  mirrorPorts?: number[];
  /** PUT /upload + PUT /mirror requests per minute per client IP (IPv6: per /64); 0 = unlimited (default 60) */
  uploadsPerMinutePerIp?: number;
  /** PUT /upload + PUT /mirror requests per minute per pubkey; 0 = unlimited (default 60) */
  uploadsPerMinutePerPubkey?: number;
  /** uploads/mirrors ingested (type sniffing, stripping, thumbnails, storing) at once (default 8) */
  maxConcurrentUploads?: number;
  /** received bodies waiting for an ingest slot before new ones get 503 (default 32) */
  maxQueuedUploads?: number;
  /**
   * request bodies held in memory at once across all uploads + mirrors, in bytes (default 256 MiB, never less
   * than 2 × maxUploadBytes so one maximum-size chunked upload fits); beyond it uploads get 503
   */
  maxBufferedUploadBytes?: number;
  /** uploads + mirrors receiving a body at once per client IP (IPv6: per /64); 0 = unlimited (default 4) */
  maxConcurrentUploadsPerIp?: number;
  /** abort an upload body that sends nothing for this long, ms (default 15 s) */
  uploadStallMs?: number;
  /** after the first 30 s, abort upload bodies averaging below this many bytes/s (default 4 KiB/s; 0 = off) */
  minUploadBytesPerSec?: number;
  /** GET /list requests per minute per client IP (IPv6: per /64); 0 = unlimited (default 120) */
  listsPerMinutePerIp?: number;
  /** how often blob bytes whose deletion failed are tried again, ms (default 10 min) */
  pendingDeleteRetryMs?: number;
}

/** temp files of interrupted writes older than this are removed at startup (no write takes that long) */
const TEMP_FILE_MAX_AGE_MS = 60 * 60_000;

/** BUD-02 blob descriptor */
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  nip94?: string[][];
}

/** Where used delete tokens and held statuses lived before they got tables (moved over once at startup). */
const LEGACY_USED_DELETE_TOKENS_NS = "blossom-used-delete-tokens";
const LEGACY_HELD_STATUS_NS = "blossom-held-status";

/**
 * Shared state + business logic used by both the HTTP routes and the admin service methods. Composes upload
 * admission (rate limits, slots, byte budget, quota), delete tokens, the type/refusal policy, the ingest
 * pipeline (./ingest) and the purge/ownership operations (./admin-ops).
 */
export class BlossomCore {
  readonly repo: BlobRepo;
  readonly log: Logger;
  readonly domains: string[];
  readonly baseUrl: string;
  /** serializes ingest/purge of one blob (lock order: blob → owner) */
  readonly blobLock = new KeyedLock();
  /** serializes quota check → insert of one pubkey's uploads */
  readonly ownerLock = new KeyedLock();
  readonly admission: Admission;
  readonly tokens: DeleteTokens;
  readonly policy: TypePolicy;
  /** prunes, retries and sweeps running in the background (awaited at shutdown) */
  readonly tasks: TaskTracker;
  private maintenance: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly deps: CoreDeps,
    readonly driver: BlobDriver,
    readonly images: ImageProcessor,
    readonly options: BlossomOptions,
  ) {
    this.repo = new BlobRepo(deps.stores.db);
    this.log = deps.logger.child("blossom");
    this.tasks = deps.tasks ?? new TaskTracker({ logger: this.log });
    this.domains = domainsFromPublicUrl(deps.config.server.publicUrl);
    this.baseUrl = deps.config.server.publicUrl.replace(/\/+$/, "");
    this.admission = new Admission(deps, this.repo, this.log, options);
    this.tokens = new DeleteTokens(this.repo, this.log, this.tasks);
    this.policy = new TypePolicy(deps, this.repo);
  }

  get settings() {
    return this.deps.settings.get().blossom;
  }

  /**
   * Moves what older versions kept in kv (used delete tokens, held statuses) into blossom's own tables, so they're
   * written in the same transaction as the rows they belong to and pruned with one DELETE. A no-op once done.
   */
  async migrateLegacyKv(): Promise<void> {
    const kv = this.deps.stores.kv;
    try {
      const held = await kv.list<string | { status?: unknown; by?: unknown }>(LEGACY_HELD_STATUS_NS);
      for (const [sha256, v] of Object.entries(held)) {
        // the oldest entries are the bare status string
        const status = typeof v === "string" ? v : v?.status;
        const by = typeof v === "object" && typeof v?.by === "string" ? v.by : null;
        if (status === "pending" || status === "blocked") await this.repo.setHeld(sha256, status, by, now());
        await kv.delete(LEGACY_HELD_STATUS_NS, sha256);
      }
      const tokens = await kv.list<number>(LEGACY_USED_DELETE_TOKENS_NS);
      const t = Date.now();
      for (const [key, exp] of Object.entries(tokens)) {
        if (typeof exp === "number" && exp > t) await this.repo.markTokenUsed(key, exp);
        await kv.delete(LEGACY_USED_DELETE_TOKENS_NS, key);
      }
    } catch (err) {
      this.log.warn("moving blossom kv entries to tables failed", { error: String(err) });
    }
  }

  blobUrl(sha256: string, type: string) {
    return `${this.baseUrl}/${sha256}.${extFromMime(type)}`;
  }
  thumbnailUrl(sha256: string) {
    return `${this.baseUrl}/thumb/${sha256}.webp`;
  }

  descriptor(row: BlobRow, uploaded = row.createdAt, extra: string[][] = []): BlobDescriptor {
    const url = this.blobUrl(row.sha256, row.type);
    const nip94 = [["url", url], ["m", row.type], ["x", row.sha256], ["size", String(row.size)], ...extra];
    if (row.hasThumbnail) nip94.push(["thumb", this.thumbnailUrl(row.sha256)]);
    return { url, sha256: row.sha256, size: row.size, type: row.type, uploaded, nip94 };
  }

  toRecord(row: BlobRow, owners: string[]): BlobRecord {
    return {
      sha256: row.sha256,
      size: row.size,
      type: row.type,
      owners,
      createdAt: row.createdAt,
      status: row.status,
      moderatedBy: row.moderatedBy,
      hasThumbnail: row.hasThumbnail,
      url: this.blobUrl(row.sha256, row.type),
      thumbnailUrl: row.hasThumbnail ? this.thumbnailUrl(row.sha256) : undefined,
    };
  }

  /** See ./ingest. */
  ingest(input: IngestInput, user?: UserRecord): Promise<{ row: BlobRow; descriptor: BlobDescriptor; created: boolean }> {
    return ingest(this, input, user);
  }

  /** Serializes `fn` with ingest/purge of the same blob. */
  lockBlob<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    return this.blobLock.run(sha256, fn);
  }

  /** See ./admin-ops. */
  releaseOwnership(sha256: string, pubkey: string, actor: string, deletedAt?: number, token?: { key: string; expiresAt: number }): Promise<boolean> {
    return releaseOwnership(this, sha256, pubkey, actor, deletedAt, token);
  }

  /** Background upkeep: sweep stale temp files once, retry queued byte deletions periodically. */
  startMaintenance(): void {
    if (this.driver.sweepTempFiles) {
      const sweep = this.driver
        .sweepTempFiles(TEMP_FILE_MAX_AGE_MS)
        .then((n) => n && this.log.info("removed temp files left by interrupted writes", { count: n }))
        .catch((err) => this.log.warn("sweeping temp files failed", { error: String(err) }));
      this.tasks.track("blossom temp sweep", sweep);
    }
    clearInterval(this.maintenance);
    this.maintenance = setInterval(() => void this.tasks.run("blossom pending deletes", () => retryPendingDeletes(this)), this.options.pendingDeleteRetryMs ?? 10 * 60_000);
    (this.maintenance as { unref?: () => void }).unref?.();
  }

  /** Shutdown: refuse new uploads/mirrors, stop the upkeep timer, await background work until `ctx.deadline`. */
  async shutdown(ctx: StopContext): Promise<void> {
    this.admission.draining = true;
    clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.tasks.idle(ctx.signal);
  }
}

export type BlossomServiceImpl = Omit<BlossomService, "setStatus" | "delete" | "deleteByPubkey" | "block" | "unblock" | "blocklist"> & {
  readonly driver: BlobDriver;
  /** whether sharp is available (thumbnails / re-encoding) */
  readonly sharp: boolean;
  setStatus(sha256: string, status: BlobStatus, actor: string, opts?: ActionOpts): Promise<void>;
  /** Removes blob data + record; when `block` true adds hash to blocklist so it can't be re-uploaded. */
  delete(sha256: string, actor: string, opts?: ActionOpts & { block?: boolean }): Promise<void>;
  deleteByPubkey(pubkey: string, actor: string, opts?: ActionOpts): Promise<number>;
  block(sha256: string, reason: string, actor: string, opts?: ActionOpts): Promise<void>;
  unblock(sha256: string, actor: string, opts?: ActionOpts): Promise<boolean>;
  blocklist: NonNullable<BlossomService["blocklist"]>;
};

export async function buildService(deps: CoreDeps, options: BlossomOptions, createApp: (core: BlossomCore) => BlossomService["app"]): Promise<BlossomServiceImpl> {
  const blossomLog = deps.logger.child("blossom");
  const driver = options.driver ?? createBlobDriver(deps.config.blossom, { warn: (msg, meta) => blossomLog.warn(msg, meta) });
  const images = await createImageProcessor({ useSharp: options.useSharp, logger: deps.logger.child("blossom") });
  const core = new BlossomCore(deps, driver, images, options);
  await core.repo.migrate();
  // before serving: re-uploads need the held statuses, deletes the used tokens
  await core.migrateLegacyKv();
  void core.tasks.run("blossom token prune", () => core.tokens.pruneUsedDeleteTokens());
  void core.tasks.run("blossom deletion prune", () => core.tokens.pruneDeletions());
  core.startMaintenance();
  if (!images.sharp) core.log.info("sharp not available: thumbnails disabled, using pure-js EXIF stripping");

  const withOwners = async (rows: BlobRow[]) => {
    const owners = await core.repo.owners(rows.map((r) => r.sha256));
    return rows.map((r) => core.toRecord(r, owners.get(r.sha256) ?? []));
  };

  return {
    app: createApp(core),
    driver,
    sharp: images.sharp,
    drain: (ctx) => core.shutdown(ctx),
    stop: (ctx) => core.shutdown(ctx),
    ...createAdminOps(core),

    async list(q) {
      const { items, total } = await core.repo.list(q);
      return { items: await withOwners(items), total };
    },

    async get(sha256) {
      const row = await core.repo.get(sha256);
      return row ? (await withOwners([row]))[0] : undefined;
    },

    async read(sha256, opts) {
      const row = await core.repo.get(sha256);
      if (!row) return undefined;
      const hidden = isHidden(row);
      // the Content-Type to serve it with (admin previews come from the admin origin): JavaScript as text/plain
      if (!opts?.thumbnail) {
        const obj = await driver.get(sha256, undefined, { hidden });
        return obj && { body: obj.body, size: obj.size ?? row.size, type: servedType(row.type) };
      }
      const obj = await driver.getThumbnail(sha256, { hidden });
      if (!obj) return undefined;
      if (obj.size !== undefined) return { body: obj.body, size: obj.size, type: "image/webp" };
      // size not reported (chunked S3 response): thumbnails are small, read it to know
      const bytes = await streamToBytes(obj.body);
      return { body: new Response(bytes as BodyInit).body!, size: bytes.byteLength, type: "image/webp" };
    },

    usage: (pubkey) => core.repo.usage(pubkey),

    async stats() {
      const rows = await core.repo.statsByType();
      const groups = new Map<string, { type: string; count: number; bytes: number }>();
      let count = 0;
      let bytes = 0;
      for (const r of rows) {
        count += r.count;
        bytes += r.bytes;
        const key = topLevelType(r.type);
        const g = groups.get(key) ?? { type: key, count: 0, bytes: 0 };
        g.count += r.count;
        g.bytes += r.bytes;
        groups.set(key, g);
      }
      return { count, bytes, byType: [...groups.values()].sort((a, b) => b.bytes - a.bytes) };
    },

    blocklist: () => core.repo.blocklist(),
  };
}
