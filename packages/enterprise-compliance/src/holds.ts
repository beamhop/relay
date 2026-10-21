// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Legal hold (§12.7). Holds freeze deletion by user (pubkey or directory subject),
 * IdP group, relay, date range and kinds.
 *
 * Enforcement:
 *  1. Registered as a provider into `lifecycle.holds` (when the lifecycle module is
 *     present): retention, vanish, crypto-shred, recycle purge and blob expiry ask it.
 *  2. Store-level guard (independent of PolicyHooks and of lifecycle): the EventStore,
 *     BlobIndex and BlobStore instances are wrapped while this module runs so that
 *     NIP-09 deletions, NIP-62 vanish, admin/moderation deletes (`moderation.remove`
 *     calls `deleteByIds`) and filter deletes first copy held events to the hold
 *     archive (`compliance.hold-archive`), and held blobs are never deleted from the
 *     blob store (ownership may go; bytes stay).
 */
import type {
  BlobIndex,
  BlobStore,
  EventStore,
  Filter,
  Kernel,
  NostrEvent,
  RelayId,
} from '@beamhop/core';
import { COL } from './config.ts';
import { groupsOf, identityOf } from './identity.ts';
import type { Rt } from './runtime.ts';
import { errMsg } from './util.ts';

export const HOLD_PROVIDER_ID = 'enterprise-compliance';

/** Same shape as lifecycle's `HoldSubject` (structural; no package dependency). */
export interface HoldSubject {
  pubkey?: string;
  eventId?: string;
  createdAt?: number;
  kind?: number;
  sha256?: string;
}

/** Same shape as lifecycle's `HoldProvider`. */
export interface HoldProvider {
  id: string;
  isHeld(relayId: RelayId, subject: HoldSubject): Promise<boolean> | boolean;
}

/** Same shape as lifecycle's `LegalHolds` service (`lifecycle.holds`). */
export interface LifecycleHoldsLike {
  register(provider: HoldProvider): () => void;
}

export interface HoldScope {
  pubkeys: string[];
  /** Directory identities, resolved to pubkeys via enterprise-identity. */
  subjects: Array<{ subject: string; idp?: string }>;
  groups: string[];
  /** Empty = every relay on the node. */
  relays: string[];
  since?: number;
  until?: number;
  kinds?: number[];
}

export interface LegalHold {
  id: string;
  name: string;
  reason: string;
  scope: HoldScope;
  status: 'active' | 'released';
  createdAt: number;
  createdBy: string;
  releasedAt?: number;
  releasedBy?: string;
  releaseReason?: string;
}

export interface ArchivedEvent {
  relayId: RelayId;
  event: NostrEvent;
  archivedAt: number;
  cause: string;
  holdIds: string[];
}

export function hasUserSelectors(s: HoldScope): boolean {
  return s.pubkeys.length + s.subjects.length + s.groups.length > 0;
}

export class LegalHolds {
  private cache: { at: number; holds: LegalHold[]; subjectKeys: Map<string, Set<string>> } | null =
    null;

  constructor(private readonly rt: Rt) {}

  private get docs() {
    return this.rt.ports.docs;
  }

  invalidate(): void {
    this.cache = null;
  }

  async list(): Promise<LegalHold[]> {
    const out: LegalHold[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<LegalHold>(COL.holds, { cursor, limit: 200 });
      out.push(...page.items.map((i) => i.value));
      cursor = page.cursor;
    } while (cursor);
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Active holds (cached; refreshed every `holds.refreshSeconds` or on change). */
  async active(): Promise<LegalHold[]> {
    const now = this.rt.ports.clock.nowMs();
    const ttl = this.rt.settings().holds.refreshSeconds * 1000;
    if (this.cache && now - this.cache.at < ttl) return this.cache.holds;
    const holds = (await this.list()).filter((h) => h.status === 'active');
    const subjectKeys = new Map<string, Set<string>>();
    const id = identityOf(this.rt.kernel);
    for (const h of holds) {
      const keys = new Set(h.scope.pubkeys);
      for (const s of h.scope.subjects) {
        try {
          const pk = await id?.pubkeyOf?.(s.subject, s.idp);
          if (pk) keys.add(pk);
        } catch {}
      }
      subjectKeys.set(h.id, keys);
    }
    this.cache = { at: now, holds, subjectKeys };
    return holds;
  }

  async get(id: string): Promise<LegalHold | null> {
    return this.docs.get<LegalHold>(COL.holds, id);
  }

  async create(
    input: { name: string; reason: string; scope: HoldScope },
    by: string,
  ): Promise<LegalHold> {
    const hold: LegalHold = {
      id: `hold_${this.rt.ports.crypto.randomHex(8)}`,
      name: input.name,
      reason: input.reason,
      scope: input.scope,
      status: 'active',
      createdAt: this.rt.now(),
      createdBy: by,
    };
    await this.docs.put(COL.holds, hold.id, hold);
    this.invalidate();
    this.rt.record({
      stream: 'compliance',
      type: 'hold.created',
      principalId: by,
      summary: `Legal hold “${hold.name}” started`,
      data: { holdId: hold.id, scope: hold.scope },
    });
    return hold;
  }

  async release(id: string, by: string, reason: string): Promise<LegalHold> {
    const cur = await this.get(id);
    if (!cur) throw new Error('That legal hold does not exist');
    if (cur.status === 'released') throw new Error('That legal hold was already released');
    const next: LegalHold = {
      ...cur,
      status: 'released',
      releasedAt: this.rt.now(),
      releasedBy: by,
      releaseReason: reason,
    };
    if (!(await this.docs.cas(COL.holds, id, cur, next)))
      throw new Error('The hold changed at the same time; try again');
    this.invalidate();
    this.rt.record({
      stream: 'compliance',
      type: 'hold.released',
      principalId: by,
      summary: `Legal hold “${cur.name}” released`,
      data: { holdId: id, reason },
    });
    return next;
  }

  /** Holds that cover the subject on this relay (`'*'` = node-wide operation). */
  async matching(relayId: RelayId, subject: HoldSubject): Promise<LegalHold[]> {
    const holds = await this.active();
    if (!holds.length) return [];
    let pubkey = subject.pubkey;
    let createdAt = subject.createdAt;
    let kind = subject.kind;
    if (!pubkey && subject.eventId && relayId !== '*') {
      const e = await this.rt.ports.events.getById(relayId, subject.eventId).catch(() => null);
      if (e) {
        pubkey = e.pubkey;
        createdAt ??= e.created_at;
        kind ??= e.kind;
      }
    }
    let owners: string[] | null = null;
    let groups: string[] | null = null;
    const out: LegalHold[] = [];
    for (const h of holds) {
      const s = h.scope;
      if (s.relays.length && relayId !== '*' && !s.relays.includes(relayId)) continue;
      if (s.kinds?.length && kind !== undefined && !s.kinds.includes(kind)) continue;
      if (createdAt !== undefined) {
        if (s.since !== undefined && createdAt < s.since) continue;
        if (s.until !== undefined && createdAt > s.until) continue;
      }
      if (!hasUserSelectors(s)) {
        out.push(h);
        continue;
      }
      const keys = this.cache?.subjectKeys.get(h.id) ?? new Set(s.pubkeys);
      let candidates: string[] = pubkey ? [pubkey] : [];
      if (!pubkey && subject.sha256) {
        owners ??= await this.blobOwners(relayId, subject.sha256);
        candidates = owners;
      }
      if (candidates.some((pk) => keys.has(pk))) {
        out.push(h);
        continue;
      }
      if (s.groups.length && candidates.length) {
        if (!groups) {
          groups = [];
          for (const pk of candidates) groups.push(...(await groupsOf(this.rt.kernel, pk)));
        }
        if (groups.some((g) => s.groups.includes(g))) out.push(h);
      }
    }
    return out;
  }

  private async blobOwners(relayId: RelayId, sha256: string): Promise<string[]> {
    if (relayId === '*') return [];
    try {
      return (await this.rt.ports.blobIndex.owners(relayId, sha256)).map((o) => o.pubkey);
    } catch {
      return [];
    }
  }

  async isHeld(relayId: RelayId, subject: HoldSubject): Promise<boolean> {
    if (subject.sha256 && (await this.isBlobPinned(subject.sha256))) return true;
    return (await this.matching(relayId, subject)).length > 0;
  }

  /** Provider registered into `lifecycle.holds`. */
  provider(): HoldProvider {
    return { id: HOLD_PROVIDER_ID, isHeld: (relayId, subject) => this.isHeld(relayId, subject) };
  }

  // ───────────── Archive & pinned blobs ─────────────

  async archive(relayId: RelayId, event: NostrEvent, cause: string, holdIds: string[]) {
    const key = `${relayId}:${event.id}`;
    if (await this.docs.get(COL.holdArchive, key)) return;
    const rec: ArchivedEvent = { relayId, event, archivedAt: this.rt.now(), cause, holdIds };
    await this.docs.put(COL.holdArchive, key, rec);
  }

  async archived(relayId?: RelayId): Promise<ArchivedEvent[]> {
    const out: ArchivedEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<ArchivedEvent>(COL.holdArchive, {
        cursor,
        limit: 500,
        ...(relayId ? { prefix: `${relayId}:` } : {}),
      });
      out.push(...page.items.map((i) => i.value));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /** Keep these bytes in the blob store even when every owner is gone. */
  async pinBlob(sha256: string, why: string): Promise<void> {
    if (await this.docs.get(COL.heldBlobs, sha256)) return;
    await this.docs.put(COL.heldBlobs, sha256, { sha256, why, at: this.rt.now() });
  }

  async isBlobPinned(sha256: string): Promise<boolean> {
    return !!(await this.docs.get(COL.heldBlobs, sha256));
  }

  /** Archive the held subset of `events`. Returns how many were archived. */
  async archiveHeld(relayId: RelayId, events: NostrEvent[], cause: string): Promise<number> {
    let n = 0;
    for (const e of events) {
      const hs = await this.matching(relayId, {
        pubkey: e.pubkey,
        eventId: e.id,
        createdAt: e.created_at,
        kind: e.kind,
      });
      if (!hs.length) continue;
      await this.archive(
        relayId,
        e,
        cause,
        hs.map((h) => h.id),
      );
      n++;
    }
    if (n) {
      this.rt.record({
        stream: 'compliance',
        type: 'hold.archived',
        relayId,
        summary: `Kept a copy of ${n} held post(s) before deletion (${cause})`,
        data: { count: n, cause },
      });
    }
    return n;
  }

  // ───────────── Store-level guard ─────────────

  /**
   * Wrap the store instances of this kernel (methods are replaced on the instance,
   * so modules that captured `ports.events` earlier are covered too). Returns an
   * uninstall function. Fails safe: when the archive step throws, the deletion is refused.
   */
  installStoreGuards(kernel: Kernel): () => void {
    const restores: Array<() => void> = [];
    const ports = kernel.ports;
    const cap = 10_000;
    const enabled = () => this.rt.settings().holds.archiveOnDelete;
    const anyHolds = async () => (await this.active()).length > 0;

    const ev = ports.events as EventStore;
    restores.push(
      patch(ev, 'applyDeletion', (orig) => async (relayId: RelayId, deletion: NostrEvent) => {
        if (enabled() && (await anyHolds())) {
          const targets: NostrEvent[] = [];
          for (const t of deletion.tags) {
            if (t[0] === 'e' && t[1]) {
              const e = await ev.getById(relayId, t[1]);
              if (e && e.pubkey === deletion.pubkey) targets.push(e);
            } else if (t[0] === 'a' && t[1]) {
              const [k, pk, ...rest] = t[1].split(':');
              const d = rest.join(':');
              if (pk !== deletion.pubkey || !k) continue;
              const f: Filter = { kinds: [Number(k)], authors: [pk], until: deletion.created_at };
              if (d) f['#d'] = [d];
              targets.push(...(await ev.query(relayId, [f], { maxLimit: cap })));
            }
          }
          await this.archiveHeld(relayId, targets, 'nip09');
        }
        return orig(relayId, deletion);
      }),
    );
    restores.push(
      patch(ev, 'vanish', (orig) => async (relayId: RelayId, pubkey: string, until: number) => {
        if (enabled() && (await anyHolds())) {
          const hs = await this.matching(relayId, { pubkey });
          if (hs.length) {
            let cursor = until;
            for (let i = 0; i < 1000; i++) {
              const page = await ev.query(
                relayId,
                [{ authors: [pubkey], until: cursor, limit: 500 }],
                { maxLimit: 500 },
              );
              if (!page.length) break;
              await this.archiveHeld(relayId, page, 'nip62');
              const oldest = page[page.length - 1]!.created_at;
              if (page.length < 500 || oldest <= 0) break;
              cursor = oldest - 1;
            }
          }
        }
        return orig(relayId, pubkey, until);
      }),
    );
    restores.push(
      patch(
        ev,
        'deleteByIds',
        (orig) => async (relayId: RelayId, ids: string[], opts?: { tombstone?: boolean }) => {
          if (enabled() && ids.length && (await anyHolds())) {
            const events: NostrEvent[] = [];
            for (const id of ids) {
              const e = await ev.getById(relayId, id);
              if (e) events.push(e);
            }
            await this.archiveHeld(relayId, events, 'admin');
          }
          return orig(relayId, ids, opts);
        },
      ),
    );
    restores.push(
      patch(ev, 'deleteMatching', (orig) => async (relayId: RelayId, filter: Filter) => {
        if (enabled() && (await anyHolds())) {
          const events = await ev.query(relayId, [{ ...filter, limit: cap }], { maxLimit: cap });
          if (events.length >= cap)
            this.rt.log('warn', 'hold archive: filter delete larger than the scan cap', {
              relayId,
              cap,
            });
          await this.archiveHeld(relayId, events, 'retention');
        }
        return orig(relayId, filter);
      }),
    );

    const idx = ports.blobIndex as BlobIndex;
    restores.push(
      patch(
        idx,
        'removeOwner',
        (orig) => async (relayId: RelayId, sha256: string, pubkey: string) => {
          if (await anyHolds()) {
            const hs = await this.matching(relayId, { pubkey, sha256 });
            if (hs.length) await this.pinBlob(sha256, `owner removed under hold ${hs[0]!.id}`);
          }
          return orig(relayId, sha256, pubkey);
        },
      ),
    );
    const blobs = ports.blobs as BlobStore;
    restores.push(
      patch(blobs, 'delete', (orig) => async (sha256: string) => {
        let pinned = false;
        try {
          pinned = await this.isBlobPinned(sha256);
        } catch (err) {
          this.rt.log('error', 'hold check failed; keeping the file', { err: errMsg(err) });
          return false;
        }
        if (pinned) {
          this.rt.log('info', 'kept a file under legal hold', { sha256 });
          return false;
        }
        return orig(sha256);
      }),
    );
    return () => {
      for (const r of restores.reverse()) r();
    };
  }
}

/** Replace `obj[name]` on the instance; returns a restore function. */
export function patch<T extends object, K extends keyof T & string>(
  obj: T,
  name: K,
  // biome-ignore lint/suspicious/noExplicitAny: generic method patching
  make: (orig: any) => T[K],
): () => void {
  const hadOwn = Object.hasOwn(obj, name);
  const prev = obj[name];
  const orig = (prev as unknown as (...a: unknown[]) => unknown).bind(obj);
  obj[name] = make(orig);
  return () => {
    if (hadOwn) obj[name] = prev;
    else delete (obj as Record<string, unknown>)[name];
  };
}
