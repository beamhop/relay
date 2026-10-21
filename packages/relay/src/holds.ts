// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Legal hold integration (§12.7) for user-requested deletions (NIP-09, NIP-62).
 *
 * The lifecycle module exposes `kernel.use('lifecycle.holds')`; the relay only
 * depends on its shape (no package import). A user's request to delete or
 * vanish is always answered with OK and the data stops being served, but
 * events under legal hold are first copied to the DocStore collection
 * `lifecycle.held-archive` (key `<relayId>/<eventId>`), so the hold freezes the
 * data itself, not its public visibility. Without a hold provider nothing is
 * archived.
 */
import type { Filter, Kernel, NostrEvent, RelayId } from '@beamhop/core';

export const HOLDS_SERVICE = 'lifecycle.holds';
export const HELD_ARCHIVE_COLLECTION = 'lifecycle.held-archive';

export interface HoldSubjectLike {
  pubkey?: string;
  eventId?: string;
  createdAt?: number;
  kind?: number;
  sha256?: string;
}

/** Structural view of lifecycle's `LegalHolds`. */
export interface LegalHoldsLike {
  isHeld(relayId: RelayId, subject: HoldSubjectLike): Promise<boolean>;
  active?(): boolean;
}

export interface HeldArchiveEntry {
  relayId: RelayId;
  event: NostrEvent;
  /** What asked for the deletion: 'nip09' | 'nip62'. */
  cause: string;
  archivedAt: number;
}

/** The hold registry, or undefined when none is registered / no provider is active. */
export function holdsOf(kernel: Kernel): LegalHoldsLike | undefined {
  const h = kernel.use<LegalHoldsLike>(HOLDS_SERVICE);
  if (!h) return undefined;
  if (typeof h.active === 'function' && !h.active()) return undefined;
  return h;
}

/**
 * Copy held events to the archive. `subjectPubkey` overrides the hold
 * subject's pubkey (gift wraps are held for their recipient, not the random
 * outer key). Returns the number archived.
 */
export async function archiveHeld(
  kernel: Kernel,
  holds: LegalHoldsLike,
  relayId: RelayId,
  events: Iterable<NostrEvent>,
  cause: string,
  subjectPubkey?: (e: NostrEvent) => string,
): Promise<number> {
  let n = 0;
  for (const e of events) {
    const held = await holds.isHeld(relayId, {
      pubkey: subjectPubkey ? subjectPubkey(e) : e.pubkey,
      eventId: e.id,
      createdAt: e.created_at,
      kind: e.kind,
    });
    if (!held) continue;
    const entry: HeldArchiveEntry = {
      relayId,
      event: e,
      cause,
      archivedAt: kernel.ports.clock.now(),
    };
    await kernel.ports.docs.put(HELD_ARCHIVE_COLLECTION, `${relayId}/${e.id}`, entry);
    n++;
  }
  return n;
}

/**
 * All stored events matching `filter` (newest first, paged by `until`).
 * Pages share boundary timestamps, so ids are de-duplicated.
 */
export async function queryAll(
  kernel: Kernel,
  relayId: RelayId,
  filter: Filter,
  pageSize = 500,
): Promise<NostrEvent[]> {
  const out = new Map<string, NostrEvent>();
  let until = filter.until;
  for (;;) {
    const page = await kernel.ports.events.query(
      relayId,
      [{ ...filter, ...(until !== undefined ? { until } : {}), limit: pageSize }],
      { maxLimit: pageSize },
    );
    let fresh = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const e of page) {
      if (!out.has(e.id)) {
        out.set(e.id, e);
        fresh++;
      }
      oldest = Math.min(oldest, e.created_at);
    }
    if (page.length < pageSize) break;
    // A full page of one timestamp: step past it (the page itself was kept).
    until = fresh === 0 ? oldest - 1 : oldest;
    if (until < 0) break;
  }
  return [...out.values()];
}

/** Events a NIP-09 deletion request would remove (own events by `e` id or `a` address). */
export async function deletionTargets(
  kernel: Kernel,
  relayId: RelayId,
  deletion: NostrEvent,
): Promise<NostrEvent[]> {
  const out = new Map<string, NostrEvent>();
  for (const t of deletion.tags) {
    if (t[0] === 'e' && t[1]) {
      const e = await kernel.ports.events.getById(relayId, t[1]);
      if (e && e.pubkey === deletion.pubkey) out.set(e.id, e);
    } else if (t[0] === 'a' && t[1]) {
      const [k, pk, ...rest] = t[1].split(':');
      const kind = Number(k);
      if (!Number.isInteger(kind) || pk !== deletion.pubkey) continue;
      const evs = await queryAll(kernel, relayId, {
        kinds: [kind],
        authors: [pk],
        '#d': [rest.join(':')],
        until: deletion.created_at,
      });
      for (const e of evs) out.set(e.id, e);
    }
  }
  return [...out.values()];
}
