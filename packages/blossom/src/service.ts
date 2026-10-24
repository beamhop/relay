import { fileTypeFromBuffer } from "file-type";
import type { BlobRecord, BlobStatus, BlossomService, CoreDeps, Logger, UserRecord } from "@beamhop/sdk";
import { CREATED_AT_SKEW, domainsFromPublicUrl, MAX_AUTH_LIFETIME } from "./auth";
import { createBlobDriver, type BlobDriver } from "./driver";
import { BlossomError, sha256Hex, type ReadLimits } from "./http";
import { createImageProcessor, type ImageProcessor } from "./image";
import { DEFAULT_MIME, extFromMime, isMimeAllowed, isSvgText, normalizeMime, servedType, topLevelType, typeOfUnrecognized } from "./mime";
import { BlobRepo, type BlobRow } from "./repo";
import { ByteBudget, ExpiringSet, ipBucket, KeyedConcurrency, Semaphore, WindowLimiter } from "./limits";
import { isPrivateAddress } from "./mirror";

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
}

const MiB = 1024 * 1024;
const UPLOAD_RATE_GRACE_MS = 30_000;

/** BUD-02 blob descriptor */
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  nip94?: string[][];
}

interface IngestInput {
  data: Uint8Array;
  /** sha256 of `data` as received */
  sha256: string;
  pubkey: string;
  /** `created_at` of the upload token: refused when the signer deleted this blob after signing it */
  tokenCreatedAt: number;
  declaredType?: string | null;
  /** trust `declaredType` over sniffing when it is a specific, valid mime (BUD-04 mirror origin Content-Type) */
  preferDeclaredType?: boolean;
  ip?: string;
  /** apply EXIF stripping (when enabled in settings; off by default since it deviates from BUD-02) */
  strip: boolean;
}

const now = () => Math.floor(Date.now() / 1000);
const USED_DELETE_TOKENS_NS = "blossom-used-delete-tokens";
/** sha256 → status of a non-approved blob purged because its last owner deleted it (see `releaseOwnership`) */
const HELD_STATUS_NS = "blossom-held-status";

/** Per-key async mutex (in-process): serializes ingest/purge of one blob and quota checks of one pubkey. */
class KeyedLock {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Shared state + business logic used by both the HTTP routes and the admin service methods. */
export class BlossomCore {
  readonly repo: BlobRepo;
  readonly log: Logger;
  readonly domains: string[];
  readonly baseUrl: string;
  private readonly blobLock = new KeyedLock();
  private readonly ownerLock = new KeyedLock();
  private readonly ipLimiter: WindowLimiter;
  private readonly pubkeyLimiter: WindowLimiter;
  /** caps ingests running at once (CPU: sniffing, stripping, thumbnails) */
  readonly uploadGate: Semaphore;
  /** caps request-body bytes held in memory at once across all uploads + mirrors */
  readonly uploadBytes: ByteBudget;
  private readonly uploadsPerIp: KeyedConcurrency;
  /**
   * BUD-11 delete tokens already used (replaying one could delete a blob the signer later re-uploaded).
   * Cached here and persisted in kv until the token expires, so a restart doesn't re-enable replays.
   */
  readonly usedDeleteTokens = new ExpiringSet(100_000);
  private usedTokenWrites = 0;
  private deletionWrites = 0;

  constructor(
    readonly deps: CoreDeps,
    readonly driver: BlobDriver,
    readonly images: ImageProcessor,
    readonly options: BlossomOptions,
  ) {
    this.repo = new BlobRepo(deps.stores.db);
    this.log = deps.logger.child("blossom");
    this.domains = domainsFromPublicUrl(deps.config.server.publicUrl);
    this.baseUrl = deps.config.server.publicUrl.replace(/\/+$/, "");
    this.ipLimiter = new WindowLimiter(options.uploadsPerMinutePerIp ?? 60, 60_000);
    this.pubkeyLimiter = new WindowLimiter(options.uploadsPerMinutePerPubkey ?? 60, 60_000);
    this.uploadGate = new Semaphore(options.maxConcurrentUploads ?? 8, options.maxQueuedUploads ?? 32);
    this.uploadBytes = new ByteBudget(() => Math.max(options.maxBufferedUploadBytes ?? 256 * MiB, 2 * this.settings.maxUploadBytes + MiB));
    this.uploadsPerIp = new KeyedConcurrency(options.maxConcurrentUploadsPerIp ?? 4);
  }

  private warnedProxy = false;
  /**
   * One-time hint: uploads arriving from a private/loopback address with trustProxy off usually mean a reverse
   * proxy in front of us, so every client shares the proxy's address — and one set of per-IP upload limits.
   */
  noteClientIp(ip: string) {
    if (this.warnedProxy || this.deps.config.server.trustProxy || ip === "unknown" || !isPrivateAddress(ip)) return;
    this.warnedProxy = true;
    this.log.warn(
      "uploads arrive from a private address while server.trustProxy is off; behind a reverse proxy every client shares one set of per-IP upload limits (set BEAMHOP_TRUST_PROXY=true there)",
      { ip },
    );
  }

  /** 429 when this IP (IPv6: /64) has made too many upload/mirror requests this minute. */
  assertIpRate(ip: string) {
    this.noteClientIp(ip);
    if (!this.ipLimiter.take(`ip:${ipBucket(ip)}`)) throw new BlossomError(429, "too many uploads, slow down");
  }
  assertPubkeyRate(pubkey: string) {
    if (!this.pubkeyLimiter.take(`pk:${pubkey}`)) throw new BlossomError(429, "too many uploads, slow down");
  }

  /**
   * Receiving an upload/mirror body: at most `maxConcurrentUploadsPerIp` per client, memory reserved from the
   * shared byte budget as bytes arrive (released when `fn` is done, i.e. after ingest), and stalled or
   * trickling bodies are cut off. Body reads don't hold an ingest slot, so slow clients can't starve others.
   */
  async withUploadBody<T>(ip: string, fn: (limits: ReadLimits) => Promise<T>): Promise<T> {
    if (!this.uploadGate.canEnter()) throw new BlossomError(503, "server busy, retry later");
    // "unknown" = no adapter-provided address (embedded/tests): can't attribute, the byte budget still applies
    const releaseIp = ip === "unknown" ? () => {} : this.uploadsPerIp.tryAcquire(ipBucket(ip));
    if (!releaseIp) throw new BlossomError(429, "too many uploads in progress, slow down");
    const lease = this.uploadBytes.lease();
    try {
      return await fn({
        reserve: (n) => lease.take(n),
        admit: (n) => this.uploadBytes.fits(n),
        stallMs: this.options.uploadStallMs ?? 15_000,
        minBytesPerSec: this.options.minUploadBytesPerSec ?? 4 * 1024, // low enough for poor mobile links; the byte budget bounds memory
        rateGraceMs: UPLOAD_RATE_GRACE_MS,
      });
    } finally {
      lease.release();
      releaseIp();
    }
  }

  /** Runs an ingest under the global gate; 503 when the queue is full. */
  withUploadSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.uploadGate.canEnter()) throw new BlossomError(503, "server busy, retry later");
    return this.uploadGate.run(fn);
  }

  get settings() {
    return this.deps.settings.get().blossom;
  }

  async isDeleteTokenUsed(key: string): Promise<boolean> {
    if (this.usedDeleteTokens.has(key)) return true;
    const exp = await this.deps.stores.kv.get<number>(USED_DELETE_TOKENS_NS, key).catch(() => undefined);
    if (typeof exp !== "number" || exp <= Date.now()) return false;
    this.usedDeleteTokens.add(key, exp);
    return true;
  }

  /** `expiresAt` in ms (the token's own expiration) */
  async markDeleteTokenUsed(key: string, expiresAt: number): Promise<void> {
    this.usedDeleteTokens.add(key, expiresAt);
    await this.deps.stores.kv.set(USED_DELETE_TOKENS_NS, key, expiresAt).catch((err) => this.log.warn("persisting used delete token failed", { error: String(err) }));
    if (++this.usedTokenWrites % 1000 === 0) void this.pruneUsedDeleteTokens();
  }

  /** Drops persisted delete-token ids whose tokens have expired. */
  async pruneUsedDeleteTokens(): Promise<void> {
    try {
      const all = await this.deps.stores.kv.list<number>(USED_DELETE_TOKENS_NS);
      const t = Date.now();
      for (const [k, exp] of Object.entries(all)) if (typeof exp !== "number" || exp <= t) await this.deps.stores.kv.delete(USED_DELETE_TOKENS_NS, k);
    } catch (err) {
      this.log.warn("pruning used delete tokens failed", { error: String(err) });
    }
  }

  /**
   * An owner deleting their copy of a blob voids their upload tokens for it signed before then: upload tokens are
   * reusable, so anyone holding one (another server it was sent to, a proxy log) could otherwise put the blob back
   * in the signer's name. `at` is the delete token's created_at (the signer's clock, like the upload token's).
   */
  async recordDeletion(sha256: string, pubkey: string, at: number): Promise<void> {
    // a stripped blob's originals too: a mirror stores them byte-identical, so an old token for the EXIF-carrying
    // original must not bring the photo back (unstripped) either
    for (const sha of [sha256, ...(await this.repo.originalsOf(sha256))]) await this.repo.recordDeletion(sha, pubkey, at);
    if (++this.deletionWrites % 1000 === 0) void this.pruneDeletions();
  }

  /** Drops deletion records older than any upload token that could still be valid. */
  async pruneDeletions(): Promise<void> {
    try {
      await this.repo.pruneDeletions(now() - MAX_AUTH_LIFETIME - 2 * CREATED_AT_SKEW);
    } catch (err) {
      this.log.warn("pruning blob deletion records failed", { error: String(err) });
    }
  }

  /** False when the upload token was signed before its signer deleted this blob (or the blob it was stripped into). */
  async tokenCurrent(sha256: string, pubkey: string, tokenCreatedAt: number): Promise<boolean> {
    const stripped = await this.repo.strippedTo(sha256);
    for (const sha of stripped && stripped !== sha256 ? [sha256, stripped] : [sha256]) {
      const deleted = await this.repo.deletedAt(sha, pubkey);
      if (deleted !== undefined && tokenCreatedAt < deleted) return false;
    }
    return true;
  }

  async assertTokenCurrent(sha256: string, pubkey: string, tokenCreatedAt: number): Promise<void> {
    if (!(await this.tokenCurrent(sha256, pubkey, tokenCreatedAt))) {
      throw new BlossomError(401, "auth token predates your deletion of this blob; sign a new one");
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

  // ------------------------------------------------------------ permissions

  isConfigOwner(pubkey: string) {
    return this.deps.config.admin.owners.includes(pubkey);
  }

  /**
   * Any admin-panel role (incl. viewer) may view pending/blocked blobs. A banned or deny-listed user has no admin
   * access (same rule as the admin API's role resolution), though the stored role is kept.
   */
  async isStaff(pubkey: string, user?: UserRecord): Promise<boolean> {
    if (this.isConfigOwner(pubkey)) return true;
    const u = user ?? (await this.deps.stores.users.get(pubkey));
    return !!u?.role && u.status !== "banned" && !u.denied;
  }

  /** Throws 403 when the pubkey may not upload under the current `uploadAccess` setting. */
  async assertCanUpload(pubkey: string): Promise<UserRecord | undefined> {
    const user = await this.deps.stores.users.get(pubkey);
    if (user && (user.status === "banned" || user.denied)) throw new BlossomError(403, "pubkey is banned");
    const isAdmin = this.isConfigOwner(pubkey) || (!!user?.role && user.role !== "viewer");
    const settings = this.deps.settings.get();
    switch (settings.blossom.uploadAccess) {
      case "anyone":
        return user;
      case "admins":
        if (isAdmin) return user;
        throw new BlossomError(403, "uploads are restricted to admins");
      case "members":
      default:
        if (isAdmin || user?.allowed || user?.role || settings.access.mode === "public") return user;
        throw new BlossomError(403, "uploads are restricted to members");
    }
  }

  /**
   * Bytes the pubkey may store (Infinity = unlimited). A per-user quota wins, and 0 there means no storage at all;
   * without one (null) the default applies, where 0 means unlimited.
   */
  async quotaFor(pubkey: string, user?: UserRecord): Promise<number> {
    const u = user ?? (await this.deps.stores.users.get(pubkey));
    if (u?.blossomQuota != null) return Math.max(0, u.blossomQuota);
    const fallback = this.settings.defaultQuotaBytes;
    return fallback > 0 ? fallback : Infinity;
  }

  /** Throws 413 when adding `size` bytes would exceed the pubkey's quota. */
  async assertQuota(pubkey: string, size: number, user?: UserRecord): Promise<void> {
    const quota = await this.quotaFor(pubkey, user);
    if (quota === Infinity) return;
    const { bytes } = await this.repo.usage(pubkey);
    if (bytes + size > quota) throw new BlossomError(413, `storage quota exceeded (${bytes}/${quota} bytes used)`);
  }

  /** Bytes the pubkey can still store (Infinity = unlimited quota). */
  async quotaRemaining(pubkey: string, user?: UserRecord): Promise<number> {
    const quota = await this.quotaFor(pubkey, user);
    if (quota === Infinity) return Infinity;
    return Math.max(0, quota - (await this.repo.usage(pubkey)).bytes);
  }

  async assertNotRefused(sha256: string): Promise<void> {
    if (await this.isRefused(sha256)) throw new BlossomError(403, "blob is blocked on this server");
  }

  /**
   * Blocklisted, moderated to "blocked" (the row's status), or bytes whose stripped form is one of those (a blocked
   * stripped upload can't come back byte-identical, e.g. through a mirror, which never strips).
   */
  async isRefused(sha256: string): Promise<boolean> {
    if ((await this.repo.isBlocked(sha256)) || (await this.repo.get(sha256))?.status === "blocked") return true;
    const stripped = await this.repo.strippedTo(sha256);
    return !!stripped && stripped !== sha256 && ((await this.repo.isBlocked(stripped)) || (await this.repo.get(stripped))?.status === "blocked");
  }

  /** Status (and moderator) a purged blob was held back with (see `releaseOwnership`); a re-upload starts out in it. */
  private async heldStatus(sha256: string): Promise<{ status: BlobStatus; by: string | null } | undefined> {
    // older entries are the bare status string
    const v = await this.deps.stores.kv.get<string | { status?: unknown; by?: unknown }>(HELD_STATUS_NS, sha256);
    const s = typeof v === "string" ? v : v?.status;
    const by = typeof v === "object" && typeof v?.by === "string" ? v.by : null;
    return s === "pending" || s === "blocked" ? { status: s, by } : undefined;
  }

  assertAllowedType(type: string) {
    if (!isMimeAllowed(type, this.settings.allowedMimeTypes)) throw new BlossomError(415, `type ${type} is not allowed`);
  }

  // ------------------------------------------------------------ ingest pipeline

  /** Type from magic bytes; an SVG with an XML prolog (which file-type calls application/xml) is image/svg+xml. */
  async sniffType(data: Uint8Array): Promise<string | undefined> {
    let mime: string | undefined;
    try {
      mime = (await fileTypeFromBuffer(data))?.mime;
    } catch {
      return undefined;
    }
    return mime === "application/xml" && isSvgText(data) ? "image/svg+xml" : mime;
  }

  /** Sniffed type, else (unrecognised bytes) a declared text type only when the bytes are text. */
  async detectType(data: Uint8Array, declared?: string | null): Promise<string> {
    return (await this.sniffType(data)) ?? typeOfUnrecognized(data, normalizeMime(declared));
  }

  /**
   * Shared upload/mirror pipeline: blocklist → type sniff + allowlist → EXIF strip → plugin hooks → quota →
   * store bytes + thumbnail → metadata + ownership → bus. Returns the descriptor of the *stored* blob.
   */
  async ingest(input: IngestInput, user?: UserRecord): Promise<{ row: BlobRow; descriptor: BlobDescriptor; created: boolean }> {
    const settings = this.settings;
    const originalSha = input.sha256;
    // Refused hashes are turned away before the type sniff and metadata strip (sharp may re-encode the image). The
    // early quota check below has to wait for the strip: it counts the stored size and is skipped for a blob the
    // uploader already owns, and both depend on the stripped bytes.
    if (await this.isRefused(originalSha)) throw new BlossomError(403, "blob is blocked on this server");
    await this.assertTokenCurrent(originalSha, input.pubkey, input.tokenCreatedAt);
    let type: string;
    const declared = input.preferDeclaredType ? normalizeMime(input.declaredType) : undefined;
    if (declared && declared !== DEFAULT_MIME) {
      // the declared type must not be a way around the allowlist: bytes recognised as something else have to be
      // allowed too, and text (incl. SVG, whatever it's labelled) keeps a declared type only when it's text too
      const sniffed = await this.sniffType(input.data);
      if (sniffed && sniffed !== "image/svg+xml") {
        type = declared;
        if (sniffed !== type) this.assertAllowedType(sniffed);
      } else type = typeOfUnrecognized(input.data, declared);
    } else {
      type = await this.detectType(input.data, input.declaredType);
    }
    this.assertAllowedType(type);

    let data = input.data;
    let sha256 = originalSha;
    let storedType = type;
    if (input.strip && settings.stripExif) {
      const res = await this.images.stripMetadata(data, type);
      if (res.unsafe) {
        throw new BlossomError(
          415,
          `this ${type} file carries metadata (EXIF/XMP, possibly location) that this server can't remove; convert it to JPEG, PNG or WebP before uploading`,
        );
      }
      if (res.stripped) {
        data = res.data;
        sha256 = sha256Hex(data);
        if (res.type) {
          storedType = res.type;
          this.assertAllowedType(storedType);
        }
        if (sha256 !== originalSha) {
          if (await this.isRefused(sha256)) throw new BlossomError(403, "blob is blocked on this server");
          // the signer deleted the stored (stripped) blob: an old token for the original mustn't bring it back
          await this.assertTokenCurrent(sha256, input.pubkey, input.tokenCreatedAt);
        }
      }
    }

    // Cheap early refusals (above and here) before plugin hooks run (a hook may be a paid remote scanner) and before
    // bytes are written; blocks and quota are re-checked authoritatively under the locks below.
    if (!(await this.repo.isOwner(sha256, input.pubkey))) await this.assertQuota(input.pubkey, data.byteLength, user);

    // Plugin hooks run before any lock is taken: a hook may act on this very blob (setStatus/delete/block take
    // the blob lock) without deadlocking the upload, and a slow hook doesn't hold up other uploads.
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      verdict = await this.deps.hooks.runBlobUpload({ sha256, size: data.byteLength, type: storedType, pubkey: input.pubkey, ip: input.ip }, data);
    } catch (err) {
      this.log.error("blob upload hook failed", { error: String(err) });
      throw new BlossomError(500, "error: upload policy failed");
    }
    if (!verdict.ok) throw new BlossomError(403, verdict.reason || "rejected by policy");

    // The blob lock keeps existing-row check → store → row/owner insert from interleaving with a purge of the same
    // blob. The owner lock is held only around the quota check → insert, so one client's parallel uploads of
    // different blobs store their bytes concurrently. Lock order is always blob → owner.
    return this.blobLock.run(sha256, async () => {
      const existing = await this.repo.get(sha256);
      // block()/delete({block}) take this lock too, so a block that landed while hooks ran (an admin, or the
      // hook itself) is seen here and the blob is never stored after being blocked
      if ((await this.isRefused(sha256)) || (sha256 !== originalSha && (await this.isRefused(originalSha)))) {
        throw new BlossomError(403, "blob is blocked on this server");
      }

      let wroteNew = false;
      let fresh: BlobRow | undefined;
      let held: { status: BlobStatus; by: string | null } | undefined;
      if (existing) {
        if (!(await this.driver.has(sha256, { hidden: existing.status !== "approved" }))) {
          await this.driver.put(sha256, data, existing.type, { hidden: existing.status !== "approved" });
        }
      } else {
        // deleting a blob held back for review and uploading it again doesn't skip the review
        held = await this.heldStatus(sha256);
        const status: BlobStatus = held?.status ?? (settings.requireApproval ? "pending" : "approved");
        const hidden = status !== "approved";
        await this.driver.put(sha256, data, storedType, { hidden });
        wroteNew = true;
        let hasThumbnail = false;
        if (settings.thumbnails) {
          const thumb = await this.images.thumbnail(data, storedType);
          if (thumb) {
            try {
              await this.driver.putThumbnail(sha256, thumb, { hidden });
              hasThumbnail = true;
            } catch (err) {
              this.log.warn("storing thumbnail failed", { sha256, error: String(err) });
            }
          }
        }
        fresh = { sha256, size: data.byteLength, type: storedType, createdAt: now(), status, moderatedBy: held?.by ?? null, hasThumbnail };
      }

      try {
        return await this.ownerLock.run(input.pubkey, async () => {
          const alreadyOwner = existing ? await this.repo.isOwner(sha256, input.pubkey) : false;
          if (!alreadyOwner) await this.assertQuota(input.pubkey, data.byteLength, user);
          const at = now();
          let row: BlobRow;
          let created = false;
          if (fresh) {
            await this.repo.insert(fresh);
            // another process may have inserted first; read back the canonical row
            row = (await this.repo.get(sha256)) ?? fresh;
            created = true;
            // the row carries the status now
            if (held) await this.deps.stores.kv.delete(HELD_STATUS_NS, sha256).catch((err) => this.log.warn("clearing held blob status failed", { sha256, error: String(err) }));
          } else row = existing!;
          await this.repo.addOwner(sha256, input.pubkey, at);
          if (sha256 !== originalSha) await this.repo.addStripped(originalSha, sha256, at);
          this.deps.bus.emit("blob.uploaded", { sha256, size: row.size, type: row.type, pubkey: input.pubkey });
          const extra = sha256 !== originalSha ? [["ox", originalSha]] : [];
          // `uploaded` is this owner's upload time, as in their /list
          const uploaded = (alreadyOwner && (await this.repo.ownedAt(sha256, input.pubkey))) || at;
          return { row, descriptor: this.descriptor(row, uploaded, extra), created };
        });
      } catch (err) {
        // bytes stored for a blob that never got a row (quota refused, db error): don't leave orphans behind
        if (wroteNew && !(await this.repo.get(sha256).catch(() => undefined))) await this.driver.delete(sha256).catch(() => {});
        throw err;
      }
    });
  }

  /** Serializes `fn` with ingest/purge of the same blob. */
  lockBlob<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    return this.blobLock.run(sha256, fn);
  }

  /** Removes record + data; the caller must hold the blob lock (`lockBlob`). */
  async purgeLocked(sha256: string, actor: string): Promise<void> {
    await this.repo.remove(sha256);
    // its original → stored mappings only matter while the blob exists or one of the hashes is blocked
    await this.repo.pruneStripped(sha256).catch((err) => this.log.warn("pruning stripped-hash mappings failed", { sha256, error: String(err) }));
    try {
      await this.driver.delete(sha256);
    } catch (err) {
      this.log.error("deleting blob data failed", { sha256, error: String(err) });
    }
    this.deps.bus.emit("blob.deleted", { sha256, actor });
  }

  /**
   * Removes one owner; purges the blob when no owners remain. Returns true if ownership was removed.
   * A moderation decision outlives that purge, so deleting and re-uploading can't undo it: a blocked blob's hash
   * goes on the blocklist (an admin can lift it there), and a pending one comes back pending. The owner's upload
   * tokens for the blob signed before `deletedAt` stop working: the delete token's created_at, so both sides are on
   * the signer's own clock (a client running slow can re-sign right away); without a token (an admin removing a
   * user's blobs) the server's clock minus the skew allowance.
   */
  async releaseOwnership(sha256: string, pubkey: string, actor: string, deletedAt?: number): Promise<boolean> {
    return this.blobLock.run(sha256, async () => {
      const removed = await this.repo.removeOwner(sha256, pubkey);
      if (removed) await this.recordDeletion(sha256, pubkey, deletedAt ?? now() - CREATED_AT_SKEW);
      if (removed && (await this.repo.ownerCount(sha256)) === 0) {
        const row = await this.repo.get(sha256);
        if (row?.status === "blocked") await this.repo.block(sha256, "blocked by a moderator, then deleted by its owner", now(), row.moderatedBy);
        else if (row && row.status !== "approved") await this.deps.stores.kv.set(HELD_STATUS_NS, sha256, { status: row.status, by: row.moderatedBy });
        await this.purgeLocked(sha256, actor);
      }
      return removed;
    });
  }
}

/** Who asked for an admin action, for the audit entry (the admin API passes the request's client IP). */
interface ActionOpts {
  ip?: string | null;
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
  void core.pruneUsedDeleteTokens();
  void core.pruneDeletions();
  if (!images.sharp) core.log.info("sharp not available: thumbnails disabled, using pure-js EXIF stripping");
  /** Audit entry + bus "admin.action", like the admin API's own audit helper. */
  const audit = async (actor: string, action: string, target: string, details: Record<string, unknown> = {}, opts?: ActionOpts) => {
    const at = now();
    const ip = opts?.ip ?? null;
    await deps.stores.audit.record({ actor, action, target, details, ip, at }).catch((err) => core.log.warn("audit failed", { error: String(err) }));
    deps.bus.emit("admin.action", { entry: { at, actor, action, target, details, ip } });
  };

  const withOwners = async (rows: BlobRow[]) => {
    const owners = await core.repo.owners(rows.map((r) => r.sha256));
    return rows.map((r) => core.toRecord(r, owners.get(r.sha256) ?? []));
  };

  return {
    app: createApp(core),
    driver,
    sharp: images.sharp,

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
      const hidden = row.status !== "approved";
      const obj = opts?.thumbnail ? await driver.getThumbnail(sha256, { hidden }) : await driver.get(sha256, undefined, { hidden });
      if (!obj) return undefined;
      // the Content-Type to serve it with (admin previews come from the admin origin): JavaScript as text/plain
      return { body: obj.body, size: obj.size, type: opts?.thumbnail ? "image/webp" : servedType(row.type) };
    },

    async setStatus(sha256, status, actor, opts) {
      await core.lockBlob(sha256, async () => {
        const row = await core.repo.get(sha256);
        if (!row) throw new Error(`blob ${sha256} not found`);
        // public object storage: move the bytes out of (or back into) public reach before the status flips
        await driver.setHidden?.(sha256, status !== "approved", { hasThumbnail: row.hasThumbnail });
        if (!(await core.repo.setStatus(sha256, status, actor))) throw new Error(`blob ${sha256} not found`);
      });
      await audit(actor, "blob.status", sha256, { status }, opts);
    },

    async delete(sha256, actor, opts) {
      // under the blob lock: an in-flight first upload of this sha can't slip its row/bytes in between
      const row = await core.lockBlob(sha256, async () => {
        const row = await core.repo.get(sha256);
        if (opts?.block) await core.repo.block(sha256, "deleted by admin", now(), actor);
        if (row) {
          // the owners' existing upload tokens mustn't put it back (a token signed within the clock-skew allowance
          // before now still works, so an owner re-signing right away isn't refused over a second of drift)
          const at = now() - CREATED_AT_SKEW;
          for (const pubkey of (await core.repo.owners([sha256])).get(sha256) ?? []) await core.recordDeletion(sha256, pubkey, at);
          await core.purgeLocked(sha256, actor);
        } else await driver.delete(sha256).catch(() => {});
        return row;
      });
      await audit(actor, opts?.block ? "blob.block" : "blob.delete", sha256, { size: row?.size, type: row?.type, block: !!opts?.block }, opts);
    },

    async deleteByPubkey(pubkey, actor, opts) {
      const shas = await core.repo.shasOwnedBy(pubkey);
      let n = 0;
      for (const sha of shas) if (await core.releaseOwnership(sha, pubkey, actor)) n++;
      if (n) await audit(actor, "blob.deleteByPubkey", pubkey, { count: n }, opts);
      return n;
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

    async block(sha256, reason, actor, opts) {
      await core.lockBlob(sha256, async () => {
        await core.repo.block(sha256, reason, now(), actor);
        if (await core.repo.get(sha256)) await core.purgeLocked(sha256, actor);
      });
      await audit(actor, "blob.block", sha256, { reason }, opts);
    },

    async unblock(sha256, actor, opts) {
      const ok = await core.repo.unblock(sha256);
      if (ok) await core.repo.pruneStripped(sha256).catch((err) => core.log.warn("pruning stripped-hash mappings failed", { sha256, error: String(err) }));
      if (ok) await audit(actor, "blob.unblock", sha256, {}, opts);
      return ok;
    },

    blocklist: () => core.repo.blocklist(),
  };
}
