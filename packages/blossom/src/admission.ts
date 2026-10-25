import type { CoreDeps, Logger, UserRecord } from "@beamhop/sdk";
import { BlossomError, type ReadLimits } from "./http";
import { ByteBudget, ipBucket, KeyedConcurrency, Semaphore, WindowLimiter } from "./limits";
import { isPrivateAddress } from "./mirror";
import type { BlobRepo } from "./repo";
import type { BlossomOptions } from "./service";

const MiB = 1024 * 1024;
const UPLOAD_RATE_GRACE_MS = 30_000;

/** Who may upload and how much: request rate limits, ingest slots, the upload byte budget, upload access and quotas. */
export class Admission {
  private readonly ipLimiter: WindowLimiter;
  private readonly pubkeyLimiter: WindowLimiter;
  private readonly listLimiter: WindowLimiter;
  /** caps ingests running at once (CPU: sniffing, stripping, thumbnails) */
  readonly uploadGate: Semaphore;
  /** caps request-body bytes held in memory at once across all uploads + mirrors */
  readonly uploadBytes: ByteBudget;
  private readonly uploadsPerIp: KeyedConcurrency;
  /** shutting down: new uploads and mirrors get 503 */
  draining = false;

  constructor(
    private readonly deps: CoreDeps,
    private readonly repo: BlobRepo,
    private readonly log: Logger,
    private readonly options: BlossomOptions,
  ) {
    this.ipLimiter = new WindowLimiter(options.uploadsPerMinutePerIp ?? 60, 60_000);
    this.pubkeyLimiter = new WindowLimiter(options.uploadsPerMinutePerPubkey ?? 60, 60_000);
    this.listLimiter = new WindowLimiter(options.listsPerMinutePerIp ?? 120, 60_000);
    this.uploadGate = new Semaphore(options.maxConcurrentUploads ?? 8, options.maxQueuedUploads ?? 32);
    this.uploadBytes = new ByteBudget(() => Math.max(options.maxBufferedUploadBytes ?? 256 * MiB, 2 * this.settings.maxUploadBytes + MiB));
    this.uploadsPerIp = new KeyedConcurrency(options.maxConcurrentUploadsPerIp ?? 4);
  }

  private get settings() {
    return this.deps.settings.get().blossom;
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
    if (this.draining) throw new BlossomError(503, "server is shutting down, retry later");
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

  // ------------------------------------------------------------ quota

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
}
