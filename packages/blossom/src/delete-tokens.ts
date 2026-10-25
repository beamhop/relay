import type { Logger, TaskTracker } from "@beamhop/sdk";
import { nowSec as now } from "@beamhop/sdk";
import { CREATED_AT_SKEW, MAX_AUTH_LIFETIME } from "./auth";
import { BlossomError } from "./http";
import { ExpiringSet } from "./limits";
import type { BlobRepo } from "./repo";

/**
 * Deletions and the tokens they void: BUD-11 delete tokens are single-use, and an owner's deletion of a blob voids
 * their upload tokens for it signed before then.
 */
export class DeleteTokens {
  /**
   * BUD-11 delete tokens already used (replaying one could delete a blob the signer later re-uploaded).
   * Cached here and persisted (blossom_used_tokens) until the token expires, so a restart doesn't re-enable replays.
   */
  readonly usedDeleteTokens = new ExpiringSet(100_000);
  private usedTokenWrites = 0;
  private deletionWrites = 0;

  constructor(
    private readonly repo: BlobRepo,
    private readonly log: Logger,
    private readonly tasks: TaskTracker,
  ) {}

  async isDeleteTokenUsed(key: string): Promise<boolean> {
    if (this.usedDeleteTokens.has(key)) return true;
    const exp = await this.repo.tokenUsed(key, Date.now()).catch(() => undefined);
    if (exp === undefined) return false;
    this.usedDeleteTokens.add(key, exp);
    return true;
  }

  /** Caches a delete token marked used (its transaction committed), pruning expired ones every thousand. */
  noteUsedToken(token: { key: string; expiresAt: number }): void {
    this.usedDeleteTokens.add(token.key, token.expiresAt);
    if (++this.usedTokenWrites % 1000 === 0) void this.tasks.run("blossom token prune", () => this.pruneUsedDeleteTokens());
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
  noteDeletions(n: number) {
    const before = this.deletionWrites;
    this.deletionWrites += n;
    if (Math.floor(before / 1000) !== Math.floor(this.deletionWrites / 1000)) void this.tasks.run("blossom deletion prune", () => this.pruneDeletions());
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
}
