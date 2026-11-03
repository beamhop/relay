import { nowSec as now } from "@beamhop/sdk";
import { CREATED_AT_SKEW } from "./auth";
import { type BlobRepo, type BlobRow, isHidden } from "./repo";
import type { BlossomCore, BlossomServiceImpl } from "./service";

/** blobs released at once by `deleteByPubkey` (each is its own transaction + driver delete) */
const DELETE_CONCURRENCY = 4;

// ------------------------------------------------------------ purging rows and bytes

/** Removes a blob's rows; inside the caller's transaction (`repo`), under the blob lock. */
export async function removeRows(sha256: string, repo: BlobRepo): Promise<void> {
  await repo.remove(sha256);
  // its original → stored mappings only matter while the blob exists or one of the hashes is blocked
  await repo.pruneStripped(sha256);
}

/** Deletes the bytes of a blob whose rows are gone (committed) and announces it; under the blob lock. */
export async function purgeBytes(core: BlossomCore, sha256: string, actor: string): Promise<void> {
  await deleteBytes(core, sha256);
  core.deps.bus.emit("blob.deleted", { sha256, actor });
}

/** Driver delete; a failure is queued and retried (`retryPendingDeletes`) instead of leaving the bytes for good. */
async function deleteBytes(core: BlossomCore, sha256: string): Promise<void> {
  try {
    await core.driver.delete(sha256);
  } catch (err) {
    core.log.error("deleting blob data failed; will retry", { sha256, error: String(err) });
    await queueDelete(core, sha256);
  }
}

async function queueDelete(core: BlossomCore, sha256: string): Promise<void> {
  await core.repo.addPendingDelete(sha256, now()).catch((err) =>
    core.log.warn("queueing blob data for deletion failed; the bytes stay until the blob is uploaded and deleted again", { sha256, error: String(err) }),
  );
}

/**
 * Bytes written for a blob whose rows didn't commit. They're deleted only when a lookup positively finds no row:
 * the commit may have gone through after all (an error on COMMIT, another instance inserting the same blob), and
 * deleting then would leave a row without data. When the lookup fails too, the retry queue looks again later.
 */
export async function discardIfUnreferenced(core: BlossomCore, sha256: string): Promise<void> {
  let row: BlobRow | undefined;
  try {
    row = await core.repo.get(sha256);
  } catch {
    await queueDelete(core, sha256);
    return;
  }
  if (!row) await deleteBytes(core, sha256);
}

/**
 * Tries queued byte deletions again (oldest/least-tried first). Each is re-checked under the blob lock: bytes of a
 * blob uploaded again since are the blob's, and only leave the queue. Returns how many left the queue.
 */
export async function retryPendingDeletes(core: BlossomCore, limit = 100): Promise<number> {
  let items: { sha256: string }[];
  try {
    items = await core.repo.pendingDeletes(limit);
  } catch (err) {
    core.log.warn("reading queued blob deletions failed", { error: String(err) });
    return 0;
  }
  let done = 0;
  for (const { sha256 } of items) {
    await core.blobLock.run(sha256, async () => {
      try {
        if (!(await core.repo.get(sha256))) await core.driver.delete(sha256);
        await core.repo.clearPendingDelete(sha256);
        done++;
      } catch (err) {
        core.log.debug("queued blob deletion failed again", { sha256, error: String(err) });
        await core.repo.pendingDeleteFailed(sha256).catch(() => {});
      }
    });
  }
  return done;
}

// ------------------------------------------------------------ ownership

/**
 * Removes one owner; purges the blob when no owners remain. Returns true if ownership was removed.
 * A moderation decision outlives that purge, so deleting and re-uploading can't undo it: a blocked blob's hash
 * goes on the blocklist (an admin can lift it there), and a pending one comes back pending. The owner's upload
 * tokens for the blob signed before `deletedAt` stop working: the delete token's created_at, so both sides are on
 * the signer's own clock (a client running slow can re-sign right away); without a token (an admin removing a
 * user's blobs) the server's clock minus the skew allowance.
 */
export async function releaseOwnership(
  core: BlossomCore,
  sha256: string,
  pubkey: string,
  actor: string,
  deletedAt?: number,
  /** the BUD-11 delete token used, marked used in the same transaction (`expiresAt` in ms) */
  token?: { key: string; expiresAt: number },
): Promise<boolean> {
  return core.blobLock.run(sha256, async () => {
    const at = deletedAt ?? now() - CREATED_AT_SKEW;
    // row changes commit together; the bytes go only after that
    const res = await core.repo.tx(async (r) => {
      if (!(await r.removeOwner(sha256, pubkey))) return undefined;
      if (token) await r.markTokenUsed(token.key, token.expiresAt);
      const records = await core.tokens.recordDeletion(sha256, pubkey, at, r);
      if ((await r.ownerCount(sha256)) > 0) return { records, purged: false };
      const row = await r.get(sha256);
      if (row?.status === "blocked") await r.block(sha256, "blocked by a moderator, then deleted by its owner", now(), row.moderatedBy);
      else if (row && isHidden(row)) await r.setHeld(sha256, row.status, row.moderatedBy, now());
      await removeRows(sha256, r);
      return { records, purged: true };
    });
    if (!res) return false;
    if (token) core.tokens.noteUsedToken(token);
    core.tokens.noteDeletions(res.records);
    if (res.purged) await purgeBytes(core, sha256, actor);
    return true;
  });
}

// ------------------------------------------------------------ admin actions

/** Who asked for an admin action, for the audit entry (the admin API passes the request's client IP). */
export interface ActionOpts {
  ip?: string | null;
}

/** The admin service's moderation actions (each audited): status changes, deletes, blocks. */
export function createAdminOps(core: BlossomCore): Pick<BlossomServiceImpl, "setStatus" | "delete" | "deleteByPubkey" | "block" | "unblock"> {
  const { deps } = core;
  /** Audit entry + bus "admin.action", like the admin API's own audit helper. */
  const audit = async (actor: string, action: string, target: string, details: Record<string, unknown> = {}, opts?: ActionOpts) => {
    const at = now();
    const ip = opts?.ip ?? null;
    await deps.stores.audit.record({ actor, action, target, details, ip, at }).catch((err) => core.log.warn("audit failed", { error: String(err) }));
    deps.bus.emit("admin.action", { entry: { at, actor, action, target, details, ip } });
  };

  return {
    async setStatus(sha256, status, actor, opts) {
      await core.lockBlob(sha256, async () => {
        const row = await core.repo.get(sha256);
        if (!row) throw new Error(`blob ${sha256} not found`);
        // public object storage: move the bytes out of (or back into) public reach before the status flips
        await core.driver.setHidden?.(sha256, status !== "approved", { hasThumbnail: row.hasThumbnail });
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
          // a plain delete must not launder a moderation decision: like an owner's delete, a blocked blob stays
          // blocklisted and a hidden one stays held, so re-uploading the bytes doesn't bring them back approved
          else if (row?.status === "blocked") await r.block(sha256, "blocked by a moderator, then deleted", now(), row.moderatedBy ?? actor);
          else if (row && isHidden(row)) await r.setHeld(sha256, row.status, row.moderatedBy, now());
          if (row) {
            // the owners' existing upload tokens mustn't put it back (a token signed within the clock-skew allowance
            // before now still works, so an owner re-signing right away isn't refused over a second of drift)
            const at = now() - CREATED_AT_SKEW;
            for (const pubkey of (await r.owners([sha256])).get(sha256) ?? []) await core.tokens.recordDeletion(sha256, pubkey, at, r);
            await removeRows(sha256, r);
          }
          return row;
        });
        if (row) await purgeBytes(core, sha256, actor);
        // no row (that committed lookup says so): stray bytes, if any
        else await core.driver.delete(sha256).catch(() => {});
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
              if (await releaseOwnership(core, sha, pubkey, actor)) n++;
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

    async block(sha256, reason, actor, opts) {
      await core.lockBlob(sha256, async () => {
        const stored = await core.repo.tx(async (r) => {
          await r.block(sha256, reason, now(), actor);
          if (!(await r.get(sha256))) return false;
          await removeRows(sha256, r);
          return true;
        });
        if (stored) await purgeBytes(core, sha256, actor);
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
  };
}
