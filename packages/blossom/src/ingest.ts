import type { BlobStatus, UserRecord } from "@beamhop/sdk";
import { nowSec as now } from "@beamhop/sdk";
import { discardIfUnreferenced } from "./admin-ops";
import { BlossomError, sha256Hex } from "./http";
import { DEFAULT_MIME, normalizeMime, typeOfUnrecognized } from "./mime";
import { type BlobRow, isHidden } from "./repo";
import type { BlobDescriptor, BlossomCore } from "./service";

export interface IngestInput {
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

/** Per-key async mutex (in-process): serializes ingest/purge of one blob and quota checks of one pubkey. */
export class KeyedLock {
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

/**
 * Shared upload/mirror pipeline: blocklist → type sniff + allowlist → EXIF strip → plugin hooks → quota →
 * store bytes + thumbnail → metadata + ownership → bus. Returns the descriptor of the *stored* blob.
 */
export async function ingest(core: BlossomCore, input: IngestInput, user?: UserRecord): Promise<{ row: BlobRow; descriptor: BlobDescriptor; created: boolean }> {
  const settings = core.settings;
  const originalSha = input.sha256;
  // Refused hashes are turned away before the type sniff and metadata strip (sharp may re-encode the image). The
  // early quota check below has to wait for the strip: it counts the stored size and is skipped for a blob the
  // uploader already owns, and both depend on the stripped bytes. The route may have run these two already.
  if (!input.checked?.refused && (await core.policy.isRefused(originalSha))) throw new BlossomError(403, "blob is blocked on this server");
  if (!input.checked?.token) await core.tokens.assertTokenCurrent(originalSha, input.pubkey, input.tokenCreatedAt);
  let type: string;
  const declared = input.preferDeclaredType ? normalizeMime(input.declaredType) : undefined;
  if (declared && declared !== DEFAULT_MIME) {
    // the declared type must not be a way around the allowlist: bytes recognised as something else have to be
    // allowed too, and text (incl. SVG, whatever it's labelled) keeps a declared type only when it's text too
    const sniffed = await core.policy.sniffType(input.data);
    if (sniffed && sniffed !== "image/svg+xml") {
      type = declared;
      if (sniffed !== type) core.policy.assertAllowedType(sniffed);
    } else type = typeOfUnrecognized(input.data, declared);
  } else {
    type = await core.policy.detectType(input.data, input.declaredType);
  }
  core.policy.assertAllowedType(type);

  let data = input.data;
  let sha256 = originalSha;
  let storedType = type;
  if (input.strip && settings.stripExif) {
    const res = await core.images.stripMetadata(data, type);
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
        core.policy.assertAllowedType(storedType);
      }
      if (sha256 !== originalSha) {
        if (await core.policy.isRefused(sha256)) throw new BlossomError(403, "blob is blocked on this server");
        // the signer deleted the stored (stripped) blob: an old token for the original mustn't bring it back
        await core.tokens.assertTokenCurrent(sha256, input.pubkey, input.tokenCreatedAt);
      }
    }
  }

  // Cheap early refusals (above and here) before plugin hooks run (a hook may be a paid remote scanner) and before
  // bytes are written; blocks and quota are re-checked authoritatively under the locks below.
  if (!(await core.repo.isOwner(sha256, input.pubkey))) await core.admission.assertQuota(input.pubkey, data.byteLength, user);

  // Plugin hooks run before any lock is taken: a hook may act on this very blob (setStatus/delete/block take
  // the blob lock) without deadlocking the upload, and a slow hook doesn't hold up other uploads.
  let verdict: { ok: true } | { ok: false; reason: string };
  try {
    verdict = await core.deps.hooks.runBlobUpload({ sha256, size: data.byteLength, type: storedType, pubkey: input.pubkey, ip: input.ip }, data);
  } catch (err) {
    // a hook that didn't answer in time fails closed, as "try again later" (duck-typed: the sdk's HookTimeoutError)
    if ((err as Error)?.name === "HookTimeoutError") {
      core.log.warn("blob upload hook timed out", { error: String(err) });
      throw new BlossomError(503, "upload policy timed out");
    }
    core.log.error("blob upload hook failed", { error: String(err) });
    throw new BlossomError(500, "error: upload policy failed");
  }
  if (!verdict.ok) throw new BlossomError(403, verdict.reason || "rejected by policy");

  // The thumbnail (a decode + resize) is made before the blob lock, so a slow one doesn't hold up deletes and
  // moderation of this blob; only when no copy is stored yet (a re-upload keeps the stored one). Where it goes
  // (hidden or not) is decided under the lock, from the status the blob is stored with.
  let thumb: Uint8Array | undefined;
  let thumbTried = false;
  if (settings.thumbnails && !(await core.repo.get(sha256))) {
    thumb = await core.images.thumbnail(data, storedType);
    thumbTried = true;
  }

  // The blob lock keeps existing-row check → store → row/owner insert from interleaving with a purge of the same
  // blob. The owner lock is held only around the quota check → insert, so one client's parallel uploads of
  // different blobs store their bytes concurrently. Lock order is always blob → owner.
  return core.blobLock.run(sha256, async () => {
    const existing = await core.repo.get(sha256);
    // block()/delete({block}) and owner deletes take this lock too, so a block, or the signer deleting this blob,
    // that landed while the body was read or hooks ran (an admin, or the hook itself) is seen here and the blob
    // is never stored after it
    const hashes = sha256 !== originalSha ? [sha256, originalSha] : [sha256];
    if (await core.policy.isRefused(hashes)) throw new BlossomError(403, "blob is blocked on this server");
    await core.tokens.assertTokenCurrent(hashes, input.pubkey, input.tokenCreatedAt);

    let wroteNew = false;
    let fresh: BlobRow | undefined;
    let held: { status: BlobStatus; by: string | null } | undefined;
    if (existing) {
      const hidden = isHidden(existing);
      // a copy of another size is a torn write: replace it
      if (!(await core.driver.has(sha256, { hidden, size: existing.size }))) await core.driver.put(sha256, data, existing.type, { hidden });
    } else {
      // deleting a blob held back for review and uploading it again doesn't skip the review
      held = await core.repo.held(sha256);
      const status: BlobStatus = held?.status ?? (settings.requireApproval ? "pending" : "approved");
      const hidden = status !== "approved";
      await core.driver.put(sha256, data, storedType, { hidden });
      wroteNew = true;
      // the blob was stored when we looked before the lock and has been purged since (rare)
      if (settings.thumbnails && !thumbTried) thumb = await core.images.thumbnail(data, storedType);
      let hasThumbnail = false;
      if (thumb) {
        try {
          await core.driver.putThumbnail(sha256, thumb, { hidden });
          hasThumbnail = true;
        } catch (err) {
          core.log.warn("storing thumbnail failed", { sha256, error: String(err) });
        }
      }
      fresh = { sha256, size: data.byteLength, type: storedType, createdAt: now(), status, moderatedBy: held?.by ?? null, hasThumbnail };
    }

    try {
      return await core.ownerLock.run(input.pubkey, async () => {
        const alreadyOwner = existing ? await core.repo.isOwner(sha256, input.pubkey) : false;
        if (!alreadyOwner) await core.admission.assertQuota(input.pubkey, data.byteLength, user);
        const at = now();
        // all row changes commit together (or not at all): never a blob without its owner, or the reverse
        const { row, uploaded } = await core.repo.tx(async (r) => {
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
        core.deps.bus.emit("blob.uploaded", { sha256, size: row.size, type: row.type, pubkey: input.pubkey });
        const extra = sha256 !== originalSha ? [["ox", originalSha]] : [];
        return { row, descriptor: core.descriptor(row, uploaded, extra), created: !!fresh };
      });
    } catch (err) {
      // bytes stored for a blob that never got a row (quota refused, db error): don't leave orphans behind
      if (wroteNew) await discardIfUnreferenced(core, sha256);
      throw err;
    }
  });
}
