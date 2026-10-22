import { fileTypeFromBuffer } from "file-type";
import type { BlobRecord, BlobStatus, BlossomService, CoreDeps, Logger, UserRecord } from "@beamhop/sdk";
import { domainsFromPublicUrl } from "./auth";
import { createBlobDriver, type BlobDriver } from "./driver";
import { BlossomError, sha256Hex } from "./http";
import { createImageProcessor, type ImageProcessor } from "./image";
import { DEFAULT_MIME, extFromMime, isMimeAllowed, normalizeMime, topLevelType } from "./mime";
import { BlobRepo, type BlobRow } from "./repo";

export interface BlossomOptions {
  /** custom blob driver (default: createBlobDriver(config.blossom)) */
  driver?: BlobDriver;
  /** set false to disable sharp even if installed (pure-JS EXIF stripping, no thumbnails) */
  useSharp?: boolean;
  /** fetch used for BUD-04 mirroring */
  fetch?: typeof fetch;
  /** allow mirroring from loopback/private addresses (default false; SSRF protection) */
  allowPrivateMirror?: boolean;
  /** mirror fetch timeout (default 30s) */
  mirrorTimeoutMs?: number;
}

/** BUD-02 blob descriptor */
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  nip94?: string[][];
}

export interface IngestInput {
  data: Uint8Array;
  /** sha256 of `data` as received */
  sha256: string;
  pubkey: string;
  declaredType?: string | null;
  ip?: string;
  /** apply EXIF stripping (when enabled in settings) */
  strip: boolean;
}

const now = () => Math.floor(Date.now() / 1000);

/** Shared state + business logic used by both the HTTP routes and the admin service methods. */
export class BlossomCore {
  readonly repo: BlobRepo;
  readonly log: Logger;
  readonly domains: string[];
  readonly baseUrl: string;

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
  }

  get settings() {
    return this.deps.settings.get().blossom;
  }

  blobUrl(sha256: string, type: string) {
    return `${this.baseUrl}/${sha256}.${extFromMime(type)}`;
  }
  thumbnailUrl(sha256: string) {
    return `${this.baseUrl}/${sha256}.thumb.webp`;
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
      hasThumbnail: row.hasThumbnail,
      url: this.blobUrl(row.sha256, row.type),
      thumbnailUrl: row.hasThumbnail ? this.thumbnailUrl(row.sha256) : undefined,
    };
  }

  // ------------------------------------------------------------ permissions

  isConfigOwner(pubkey: string) {
    return this.deps.config.admin.owners.includes(pubkey);
  }

  /** Any admin-panel role (incl. viewer) may view pending/blocked blobs. */
  async isStaff(pubkey: string, user?: UserRecord): Promise<boolean> {
    if (this.isConfigOwner(pubkey)) return true;
    const u = user ?? (await this.deps.stores.users.get(pubkey));
    return !!u?.role;
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

  async quotaFor(pubkey: string, user?: UserRecord): Promise<number> {
    const u = user ?? (await this.deps.stores.users.get(pubkey));
    return u?.blossomQuota ?? this.settings.defaultQuotaBytes;
  }

  /** Throws 413 when adding `size` bytes would exceed the pubkey's quota (0 = unlimited). */
  async assertQuota(pubkey: string, size: number, user?: UserRecord): Promise<void> {
    const quota = await this.quotaFor(pubkey, user);
    if (!quota || quota <= 0) return;
    const { bytes } = await this.repo.usage(pubkey);
    if (bytes + size > quota) throw new BlossomError(413, `storage quota exceeded (${bytes}/${quota} bytes used)`);
  }

  async assertNotBlocked(sha256: string): Promise<void> {
    if (await this.repo.isBlocked(sha256)) throw new BlossomError(403, "blob is blocked on this server");
  }

  assertAllowedType(type: string) {
    if (!isMimeAllowed(type, this.settings.allowedMimeTypes)) throw new BlossomError(415, `type ${type} is not allowed`);
  }

  // ------------------------------------------------------------ ingest pipeline

  async detectType(data: Uint8Array, declared?: string | null): Promise<string> {
    try {
      const ft = await fileTypeFromBuffer(data);
      if (ft?.mime) return ft.mime;
    } catch {
      /* fall back to header */
    }
    return normalizeMime(declared) ?? DEFAULT_MIME;
  }

  /**
   * Shared upload/mirror pipeline: blocklist → type sniff + allowlist → EXIF strip → quota → plugin hooks →
   * store bytes + thumbnail → metadata + ownership → bus. Returns the descriptor of the *stored* blob.
   */
  async ingest(input: IngestInput, user?: UserRecord): Promise<{ row: BlobRow; descriptor: BlobDescriptor; created: boolean }> {
    const settings = this.settings;
    const originalSha = input.sha256;
    await this.assertNotBlocked(originalSha);
    const type = await this.detectType(input.data, input.declaredType);
    this.assertAllowedType(type);

    let data = input.data;
    let sha256 = originalSha;
    if (input.strip && settings.stripExif) {
      const res = await this.images.stripMetadata(data, type);
      if (res.stripped) {
        data = res.data;
        sha256 = sha256Hex(data);
        if (sha256 !== originalSha) await this.assertNotBlocked(sha256);
      }
    }

    const existing = await this.repo.get(sha256);
    if (existing?.status === "blocked") throw new BlossomError(403, "blob is blocked on this server");
    const alreadyOwner = existing ? await this.repo.isOwner(sha256, input.pubkey) : false;
    if (!alreadyOwner) await this.assertQuota(input.pubkey, data.byteLength, user);

    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      verdict = await this.deps.hooks.runBlobUpload({ sha256, size: data.byteLength, type, pubkey: input.pubkey, ip: input.ip }, data);
    } catch (err) {
      this.log.error("blob upload hook failed", { error: String(err) });
      throw new BlossomError(500, "error: upload policy failed");
    }
    if (!verdict.ok) throw new BlossomError(403, verdict.reason || "rejected by policy");

    const at = now();
    let row: BlobRow;
    let created = false;
    if (existing) {
      row = existing;
      if (!(await this.driver.has(sha256))) await this.driver.put(sha256, data, existing.type);
    } else {
      await this.driver.put(sha256, data, type);
      let hasThumbnail = false;
      if (settings.thumbnails) {
        const thumb = await this.images.thumbnail(data, type);
        if (thumb) {
          try {
            await this.driver.putThumbnail(sha256, thumb);
            hasThumbnail = true;
          } catch (err) {
            this.log.warn("storing thumbnail failed", { sha256, error: String(err) });
          }
        }
      }
      row = { sha256, size: data.byteLength, type, createdAt: at, status: settings.requireApproval ? "pending" : "approved", hasThumbnail };
      await this.repo.insert(row);
      // a concurrent upload may have inserted first; read back the canonical row
      row = (await this.repo.get(sha256)) ?? row;
      created = true;
    }
    await this.repo.addOwner(sha256, input.pubkey, at);
    this.deps.bus.emit("blob.uploaded", { sha256, size: row.size, type: row.type, pubkey: input.pubkey });
    const extra = sha256 !== originalSha ? [["ox", originalSha]] : [];
    return { row, descriptor: this.descriptor(row, row.createdAt, extra), created };
  }

  /** Removes record + data. */
  async purge(sha256: string, actor: string): Promise<void> {
    await this.repo.remove(sha256);
    try {
      await this.driver.delete(sha256);
    } catch (err) {
      this.log.error("deleting blob data failed", { sha256, error: String(err) });
    }
    this.deps.bus.emit("blob.deleted", { sha256, actor });
  }

  /** Removes one owner; purges the blob when no owners remain. Returns true if ownership was removed. */
  async releaseOwnership(sha256: string, pubkey: string, actor: string): Promise<boolean> {
    const removed = await this.repo.removeOwner(sha256, pubkey);
    if (removed && (await this.repo.ownerCount(sha256)) === 0) await this.purge(sha256, actor);
    return removed;
  }
}

export type BlossomServiceImpl = BlossomService & {
  readonly driver: BlobDriver;
  /** whether sharp is available (thumbnails / re-encoding) */
  readonly sharp: boolean;
  block(sha256: string, reason: string, actor: string): Promise<void>;
  unblock(sha256: string, actor: string): Promise<boolean>;
  blocklist(): Promise<{ sha256: string; reason: string; createdAt: number }[]>;
};

export async function buildService(deps: CoreDeps, options: BlossomOptions, createApp: (core: BlossomCore) => BlossomService["app"]): Promise<BlossomServiceImpl> {
  const driver = options.driver ?? createBlobDriver(deps.config.blossom);
  const images = await createImageProcessor({ useSharp: options.useSharp, logger: deps.logger.child("blossom") });
  const core = new BlossomCore(deps, driver, images, options);
  await core.repo.migrate();
  if (!images.sharp) core.log.info("sharp not available: thumbnails disabled, using pure-js EXIF stripping");
  const audit = (actor: string, action: string, target: string, details: Record<string, unknown> = {}) =>
    deps.stores.audit.record({ actor, action, target, details, ip: null }).catch((err) => core.log.warn("audit failed", { error: String(err) }));

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
      const obj = opts?.thumbnail ? await driver.getThumbnail(sha256) : await driver.get(sha256);
      if (!obj) return undefined;
      return { body: obj.body, size: obj.size, type: opts?.thumbnail ? "image/webp" : row.type };
    },

    async setStatus(sha256: string, status: BlobStatus, actor: string) {
      if (!(await core.repo.setStatus(sha256, status))) throw new Error(`blob ${sha256} not found`);
      await audit(actor, "blob.status", sha256, { status });
    },

    async delete(sha256, actor, opts) {
      const row = await core.repo.get(sha256);
      if (opts?.block) await core.repo.block(sha256, "deleted by admin", now());
      if (row) await core.purge(sha256, actor);
      else await driver.delete(sha256).catch(() => {});
      await audit(actor, opts?.block ? "blob.block" : "blob.delete", sha256, { size: row?.size, type: row?.type, block: !!opts?.block });
    },

    async deleteByPubkey(pubkey, actor) {
      const shas = await core.repo.shasOwnedBy(pubkey);
      let n = 0;
      for (const sha of shas) if (await core.releaseOwnership(sha, pubkey, actor)) n++;
      if (n) await audit(actor, "blob.deleteByPubkey", pubkey, { count: n });
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

    async block(sha256, reason, actor) {
      await core.repo.block(sha256, reason, now());
      if (await core.repo.get(sha256)) await core.purge(sha256, actor);
      await audit(actor, "blob.block", sha256, { reason });
    },

    async unblock(sha256, actor) {
      const ok = await core.repo.unblock(sha256);
      if (ok) await audit(actor, "blob.unblock", sha256);
      return ok;
    },

    blocklist: () => core.repo.blocklist(),
  };
}
