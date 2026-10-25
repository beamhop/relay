import { fileTypeFromBuffer } from "file-type";
import type { BlobRecord, BlobStatus, BlossomService, CoreDeps, Logger, UserRecord } from "@beamhop/sdk";
import { CREATED_AT_SKEW, domainsFromPublicUrl, MAX_AUTH_LIFETIME } from "./auth";
import { createBlobDriver, type BlobDriver } from "./driver";
import { BlossomError, sha256Hex, type ReadLimits } from "./http";
import { streamToBytes } from "./driver/types";
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
  /** GET /list requests per minute per client IP (IPv6: per /64); 0 = unlimited (default 120) */
  listsPerMinutePerIp?: number;
  /** how often blob bytes whose deletion failed are tried again, ms (default 10 min) */
  pendingDeleteRetryMs?: number;
}

const MiB = 1024 * 1024;
const UPLOAD_RATE_GRACE_MS = 30_000;
/** temp files of interrupted writes older than this are removed at startup (no write takes that long) */
const TEMP_FILE_MAX_AGE_MS = 60 * 60_000;
/** blobs released at once by `deleteByPubkey` (each is its own transaction + driver delete) */
const DELETE_CONCURRENCY = 4;

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
  /**
   * Early checks of the received hash the route already made: refusal (blocklist/blocked) and/or that the token
   * predates no deletion. Ingest then skips its own early copy; the authoritative re-checks under the lock still run.
   */
  checked?: { refused?: boolean; token?: boolean };
  /** reserves memory from the upload's byte budget (the stripped copy is held next to the received body) */
  reserve?: (bytes: number) => boolean;
}

const now = () => Math.floor(Date.now() / 1000);
/** Where used delete tokens and held statuses lived before they got tables (moved over once at startup). */
const LEGACY_USED_DELETE_TOKENS_NS = "blossom-used-delete-tokens";
const LEGACY_HELD_STATUS_NS = "blossom-held-status";

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
  private readonly listLimiter: WindowLimiter;
  /** caps ingests running at once (CPU: sniffing, stripping, thumbnails) */
  readonly uploadGate: Semaphore;
  /** caps request-body bytes held in memory at once across all uploads + mirrors */
  readonly uploadBytes: ByteBudget;
  private readonly uploadsPerIp: KeyedConcurrency;
  /**
   * BUD-11 delete tokens already used (replaying one could delete a blob the signer later re-uploaded).
   * Cached here and persisted (blossom_used_tokens) until the token expires, so a restart doesn't re-enable replays.
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
    this.listLimiter = new WindowLimiter(options.listsPerMinutePerIp ?? 120, 60_000);
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
  /** 429 when this IP (IPv6: /64) has listed too often this minute (one listing can be up to 10k rows). */
  assertListRate(ip: string) {
    if (ip !== "unknown" && !this.listLimiter.take(`ip:${ipBucket(ip)}`)) throw new BlossomError(429, "too many list requests, slow down");
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
        unreserve: (n) => lease.give(n),
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
    const exp = await this.repo.tokenUsed(key, Date.now()).catch(() => undefined);
    if (exp === undefined) return false;
    this.usedDeleteTokens.add(key, exp);
    return true;
  }

  /** Drops persisted delete-token ids whose tokens have expired. */
  async pruneUsedDeleteTokens(): Promise<void> {
    try {
      await this.repo.pruneUsedTokens(Date.now());
    } catch (err) {
      this.log.warn("pruning used delete tokens failed", { error: String(err) });
    }
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

  /**
   * An owner deleting their copy of a blob voids their upload tokens for it signed before then: upload tokens are
   * reusable, so anyone holding one (another server it was sent to, a proxy log) could otherwise put the blob back
   * in the signer's name. `at` is the delete token's created_at (the signer's clock, like the upload token's).
   * `repo`: the transaction's, when called inside one.
   */
  async recordDeletion(sha256: string, pubkey: string, at: number, repo = this.repo): Promise<number> {
    // a stripped blob's originals too: a mirror stores them byte-identical, so an old token for the EXIF-carrying
    // original must not bring the photo back (unstripped) either
    const shas = [sha256, ...(await repo.originalsOf(sha256))];
    for (const sha of shas) await repo.recordDeletion(sha, pubkey, at);
    return shas.length;
  }

  /** Counts deletion records written (after their transaction), pruning old ones every thousand. */
  private noteDeletions(n: number) {
    const before = this.deletionWrites;
    this.deletionWrites += n;
    if (Math.floor(before / 1000) !== Math.floor(this.deletionWrites / 1000)) void this.pruneDeletions();
  }

  /** Drops deletion records older than any upload token that could still be valid. */
  async pruneDeletions(): Promise<void> {
    try {
      await this.repo.pruneDeletions(now() - MAX_AUTH_LIFETIME - 2 * CREATED_AT_SKEW);
    } catch (err) {
      this.log.warn("pruning blob deletion records failed", { error: String(err) });
    }
  }

  /**
   * False when the upload token was signed before its signer deleted this blob (or the blob it was stripped into);
   * for several hashes, when that holds for any of them.
   */
  async tokenCurrent(sha256: string | string[], pubkey: string, tokenCreatedAt: number): Promise<boolean> {
    const deleted = await this.repo.lastDeletion(pubkey, Array.isArray(sha256) ? sha256 : [sha256]);
    return deleted === undefined || tokenCreatedAt >= deleted;
  }

  async assertTokenCurrent(sha256: string | string[], pubkey: string, tokenCreatedAt: number): Promise<void> {
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
  async isRefused(sha256: string | string[]): Promise<boolean> {
    return this.repo.refused(Array.isArray(sha256) ? sha256 : [sha256]);
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
    // uploader already owns, and both depend on the stripped bytes. The route may have run these two already.
    if (!input.checked?.refused && (await this.isRefused(originalSha))) throw new BlossomError(403, "blob is blocked on this server");
    if (!input.checked?.token) await this.assertTokenCurrent(originalSha, input.pubkey, input.tokenCreatedAt);
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
        // held next to the received body until the ingest is done: it comes out of the same byte budget
        if (input.reserve && !input.reserve(data.byteLength)) throw new BlossomError(503, "server busy, retry later");
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

    // The thumbnail (a decode + resize) is made before the blob lock, so a slow one doesn't hold up deletes and
    // moderation of this blob; only when no copy is stored yet (a re-upload keeps the stored one). Where it goes
    // (hidden or not) is decided under the lock, from the status the blob is stored with.
    let thumb: Uint8Array | undefined;
    let thumbTried = false;
    if (settings.thumbnails && !(await this.repo.get(sha256))) {
      thumb = await this.images.thumbnail(data, storedType);
      thumbTried = true;
    }

    // The blob lock keeps existing-row check → store → row/owner insert from interleaving with a purge of the same
    // blob. The owner lock is held only around the quota check → insert, so one client's parallel uploads of
    // different blobs store their bytes concurrently. Lock order is always blob → owner.
    return this.blobLock.run(sha256, async () => {
      const existing = await this.repo.get(sha256);
      // block()/delete({block}) and owner deletes take this lock too, so a block, or the signer deleting this blob,
      // that landed while the body was read or hooks ran (an admin, or the hook itself) is seen here and the blob
      // is never stored after it
      const hashes = sha256 !== originalSha ? [sha256, originalSha] : [sha256];
      if (await this.isRefused(hashes)) throw new BlossomError(403, "blob is blocked on this server");
      await this.assertTokenCurrent(hashes, input.pubkey, input.tokenCreatedAt);

      let wroteNew = false;
      let fresh: BlobRow | undefined;
      let held: { status: BlobStatus; by: string | null } | undefined;
      if (existing) {
        const hidden = existing.status !== "approved";
        // a copy of another size is a torn write: replace it
        if (!(await this.driver.has(sha256, { hidden, size: existing.size }))) await this.driver.put(sha256, data, existing.type, { hidden });
      } else {
        // deleting a blob held back for review and uploading it again doesn't skip the review
        held = await this.repo.held(sha256);
        const status: BlobStatus = held?.status ?? (settings.requireApproval ? "pending" : "approved");
        const hidden = status !== "approved";
        await this.driver.put(sha256, data, storedType, { hidden });
        wroteNew = true;
        // the blob was stored when we looked before the lock and has been purged since (rare)
        if (settings.thumbnails && !thumbTried) thumb = await this.images.thumbnail(data, storedType);
        let hasThumbnail = false;
        if (thumb) {
          try {
            await this.driver.putThumbnail(sha256, thumb, { hidden });
            hasThumbnail = true;
          } catch (err) {
            this.log.warn("storing thumbnail failed", { sha256, error: String(err) });
          }
        }
        fresh = { sha256, size: data.byteLength, type: storedType, createdAt: now(), status, moderatedBy: held?.by ?? null, hasThumbnail };
      }

      try {
        return await this.ownerLock.run(input.pubkey, async () => {
          const alreadyOwner = existing ? await this.repo.isOwner(sha256, input.pubkey) : false;
          if (!alreadyOwner) await this.assertQuota(input.pubkey, data.byteLength, user);
          const at = now();
          // all row changes commit together (or not at all): never a blob without its owner, or the reverse
          const { row, uploaded } = await this.repo.tx(async (r) => {
            let row: BlobRow;
            if (fresh) {
              await r.insert(fresh);
              // another process may have inserted first; read back the canonical row
              row = (await r.get(sha256)) ?? fresh;
              // the row carries the status now
              if (held) await r.clearHeld(sha256);
            } else row = existing!;
            await r.addOwner(sha256, input.pubkey, at);
            if (sha256 !== originalSha) await r.addStripped(originalSha, sha256, at);
            // `uploaded` is this owner's upload time, as in their /list
            const uploaded = (alreadyOwner && (await r.ownedAt(sha256, input.pubkey))) || at;
            return { row, uploaded };
          });
          this.deps.bus.emit("blob.uploaded", { sha256, size: row.size, type: row.type, pubkey: input.pubkey });
          const extra = sha256 !== originalSha ? [["ox", originalSha]] : [];
          return { row, descriptor: this.descriptor(row, uploaded, extra), created: !!fresh };
        });
      } catch (err) {
        // bytes stored for a blob that never got a row (quota refused, db error): don't leave orphans behind
        if (wroteNew) await this.discardIfUnreferenced(sha256);
        throw err;
      }
    });
  }

  /** Serializes `fn` with ingest/purge of the same blob. */
  lockBlob<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    return this.blobLock.run(sha256, fn);
  }

  /** Removes a blob's rows; inside the caller's transaction (`repo`), under the blob lock. */
  async removeRows(sha256: string, repo: BlobRepo): Promise<void> {
    await repo.remove(sha256);
    // its original → stored mappings only matter while the blob exists or one of the hashes is blocked
    await repo.pruneStripped(sha256);
  }

  /** Deletes the bytes of a blob whose rows are gone (committed) and announces it; under the blob lock. */
  async purgeBytes(sha256: string, actor: string): Promise<void> {
    await this.deleteBytes(sha256);
    this.deps.bus.emit("blob.deleted", { sha256, actor });
  }

  /** Driver delete; a failure is queued and retried (`retryPendingDeletes`) instead of leaving the bytes for good. */
  private async deleteBytes(sha256: string): Promise<void> {
    try {
      await this.driver.delete(sha256);
    } catch (err) {
      this.log.error("deleting blob data failed; will retry", { sha256, error: String(err) });
      await this.queueDelete(sha256);
    }
  }

  private async queueDelete(sha256: string): Promise<void> {
    await this.repo.addPendingDelete(sha256, now()).catch((err) =>
      this.log.warn("queueing blob data for deletion failed; the bytes stay until the blob is uploaded and deleted again", { sha256, error: String(err) }),
    );
  }

  /**
   * Bytes written for a blob whose rows didn't commit. They're deleted only when a lookup positively finds no row:
   * the commit may have gone through after all (an error on COMMIT, another instance inserting the same blob), and
   * deleting then would leave a row without data. When the lookup fails too, the retry queue looks again later.
   */
  private async discardIfUnreferenced(sha256: string): Promise<void> {
    let row: BlobRow | undefined;
    try {
      row = await this.repo.get(sha256);
    } catch {
      await this.queueDelete(sha256);
      return;
    }
    if (!row) await this.deleteBytes(sha256);
  }

  /**
   * Tries queued byte deletions again (oldest/least-tried first). Each is re-checked under the blob lock: bytes of a
   * blob uploaded again since are the blob's, and only leave the queue. Returns how many left the queue.
   */
  async retryPendingDeletes(limit = 100): Promise<number> {
    let items: { sha256: string }[];
    try {
      items = await this.repo.pendingDeletes(limit);
    } catch (err) {
      this.log.warn("reading queued blob deletions failed", { error: String(err) });
      return 0;
    }
    let done = 0;
    for (const { sha256 } of items) {
      await this.blobLock.run(sha256, async () => {
        try {
          if (!(await this.repo.get(sha256))) await this.driver.delete(sha256);
          await this.repo.clearPendingDelete(sha256);
          done++;
        } catch (err) {
          this.log.debug("queued blob deletion failed again", { sha256, error: String(err) });
          await this.repo.pendingDeleteFailed(sha256).catch(() => {});
        }
      });
    }
    return done;
  }

  /** Background upkeep: sweep stale temp files once, retry queued byte deletions periodically. */
  startMaintenance(): void {
    if (this.driver.sweepTempFiles) {
      void this.driver
        .sweepTempFiles(TEMP_FILE_MAX_AGE_MS)
        .then((n) => n && this.log.info("removed temp files left by interrupted writes", { count: n }))
        .catch((err) => this.log.warn("sweeping temp files failed", { error: String(err) }));
    }
    const timer = setInterval(() => void this.retryPendingDeletes(), this.options.pendingDeleteRetryMs ?? 10 * 60_000);
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * Removes one owner; purges the blob when no owners remain. Returns true if ownership was removed.
   * A moderation decision outlives that purge, so deleting and re-uploading can't undo it: a blocked blob's hash
   * goes on the blocklist (an admin can lift it there), and a pending one comes back pending. The owner's upload
   * tokens for the blob signed before `deletedAt` stop working: the delete token's created_at, so both sides are on
   * the signer's own clock (a client running slow can re-sign right away); without a token (an admin removing a
   * user's blobs) the server's clock minus the skew allowance.
   */
  async releaseOwnership(
    sha256: string,
    pubkey: string,
    actor: string,
    deletedAt?: number,
    /** the BUD-11 delete token used, marked used in the same transaction (`expiresAt` in ms) */
    token?: { key: string; expiresAt: number },
  ): Promise<boolean> {
    return this.blobLock.run(sha256, async () => {
      const at = deletedAt ?? now() - CREATED_AT_SKEW;
      // row changes commit together; the bytes go only after that
      const res = await this.repo.tx(async (r) => {
        if (!(await r.removeOwner(sha256, pubkey))) return undefined;
        if (token) await r.markTokenUsed(token.key, token.expiresAt);
        const records = await this.recordDeletion(sha256, pubkey, at, r);
        if ((await r.ownerCount(sha256)) > 0) return { records, purged: false };
        const row = await r.get(sha256);
        if (row?.status === "blocked") await r.block(sha256, "blocked by a moderator, then deleted by its owner", now(), row.moderatedBy);
        else if (row && row.status !== "approved") await r.setHeld(sha256, row.status, row.moderatedBy, now());
        await this.removeRows(sha256, r);
        return { records, purged: true };
      });
      if (!res) return false;
      if (token) {
        this.usedDeleteTokens.add(token.key, token.expiresAt);
        if (++this.usedTokenWrites % 1000 === 0) void this.pruneUsedDeleteTokens();
      }
      this.noteDeletions(res.records);
      if (res.purged) await this.purgeBytes(sha256, actor);
      return true;
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
  // before serving: re-uploads need the held statuses, deletes the used tokens
  await core.migrateLegacyKv();
  void core.pruneUsedDeleteTokens();
  void core.pruneDeletions();
  core.startMaintenance();
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
        const row = await core.repo.tx(async (r) => {
          const row = await r.get(sha256);
          if (opts?.block) await r.block(sha256, "deleted by admin", now(), actor);
          if (row) {
            // the owners' existing upload tokens mustn't put it back (a token signed within the clock-skew allowance
            // before now still works, so an owner re-signing right away isn't refused over a second of drift)
            const at = now() - CREATED_AT_SKEW;
            for (const pubkey of (await r.owners([sha256])).get(sha256) ?? []) await core.recordDeletion(sha256, pubkey, at, r);
            await core.removeRows(sha256, r);
          }
          return row;
        });
        if (row) await core.purgeBytes(sha256, actor);
        // no row (that committed lookup says so): stray bytes, if any
        else await driver.delete(sha256).catch(() => {});
        return row;
      });
      await audit(actor, opts?.block ? "blob.block" : "blob.delete", sha256, { size: row?.size, type: row?.type, block: !!opts?.block }, opts);
    },

    async deleteByPubkey(pubkey, actor, opts) {
      const shas = await core.repo.shasOwnedBy(pubkey);
      let n = 0;
      let failed = false;
      try {
        // a few at a time: each is a short transaction plus a driver delete (network round trips on S3)
        let next = 0;
        const worker = async () => {
          while (!failed && next < shas.length) {
            const sha = shas[next++];
            try {
              if (await core.releaseOwnership(sha, pubkey, actor)) n++;
            } catch (err) {
              failed = true;
              throw err;
            }
          }
        };
        const results = await Promise.allSettled(Array.from({ length: Math.min(DELETE_CONCURRENCY, shas.length) }, worker));
        const error = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (error) throw error.reason;
      } finally {
        // what was done is audited even when a later blob failed
        if (n) await audit(actor, "blob.deleteByPubkey", pubkey, failed ? { count: n, of: shas.length, incomplete: true } : { count: n }, opts);
      }
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
        const stored = await core.repo.tx(async (r) => {
          await r.block(sha256, reason, now(), actor);
          if (!(await r.get(sha256))) return false;
          await core.removeRows(sha256, r);
          return true;
        });
        if (stored) await core.purgeBytes(sha256, actor);
      });
      await audit(actor, "blob.block", sha256, { reason }, opts);
    },

    async unblock(sha256, actor, opts) {
      const ok = await core.repo.tx(async (r) => {
        if (!(await r.unblock(sha256))) return false;
        await r.pruneStripped(sha256);
        return true;
      });
      if (ok) await audit(actor, "blob.unblock", sha256, {}, opts);
      return ok;
    },

    blocklist: () => core.repo.blocklist(),
  };
}
