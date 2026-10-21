// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NIP-62 right to vanish, shared by the relay (a kind-62 request) and the
 * self-service portal / admin action (`kernel.use(VANISH_SERVICE)`), so both
 * paths archive held data, delete gift wraps addressed to the person, and
 * tell blossom/media (`user.vanished`) to remove the person's files.
 */
import { type Filter, type Kernel, type RelayId, kindClass } from '@beamhop/core';
import { GIFT_WRAP_KINDS } from './giftwrap.ts';
import { archiveHeld, holdsOf, queryAll } from './holds.ts';

export const VANISH_SERVICE = 'relay.vanish';

export interface VanishOptions {
  /** `'all'` when the request named ALL_RELAYS. */
  scope?: 'relay' | 'all';
  /** Up to this many deleted ids are collected for `event.deleted` consumers. */
  idCap?: number;
  /** Called when collecting the ids fails (the deletion still happens). */
  onError?: (err: unknown) => void;
}

export interface VanishOutcome {
  /** Events removed (own events and gift wraps addressed to the person). */
  removed: number;
}

export type VanishPerson = (
  relayId: RelayId,
  pubkey: string,
  until: number,
  opts?: VanishOptions,
) => Promise<VanishOutcome>;

export async function vanishPerson(
  kernel: Kernel,
  relayId: RelayId,
  pubkey: string,
  until: number,
  opts: VanishOptions = {},
): Promise<VanishOutcome> {
  const store = kernel.ports.events;
  // Stored gift-wrap kinds addressed to the vanishing user (NIP-62 SHOULD).
  const wraps: Filter = {
    kinds: [...GIFT_WRAP_KINDS].filter((k) => kindClass(k) !== 'ephemeral'),
    '#p': [pubkey],
    until,
  };
  // Collect (capped) ids before they are gone, for event.deleted consumers.
  const cap = opts.idCap ?? 0;
  let ids: string[] = [];
  if (cap > 0) {
    try {
      const evs = await store.query(
        relayId,
        [
          { authors: [pubkey], until, limit: cap },
          { ...wraps, limit: cap },
        ],
        { maxLimit: cap },
      );
      ids = evs.slice(0, cap).map((e) => e.id);
    } catch (err) {
      // The ids are only a courtesy for event.deleted consumers; erase anyway.
      opts.onError?.(err);
    }
  }
  // Legal hold: archive held events (the user's own and wraps addressed to
  // them) before they are erased; the request itself is still honoured.
  const holds = holdsOf(kernel);
  if (holds) {
    const own = await queryAll(kernel, relayId, { authors: [pubkey], until });
    await archiveHeld(kernel, holds, relayId, own, 'nip62');
    const received = await queryAll(kernel, relayId, wraps);
    await archiveHeld(kernel, holds, relayId, received, 'nip62', () => pubkey);
  }
  const removed =
    (await store.vanish(relayId, pubkey, until)) + (await store.deleteMatching(relayId, wraps));
  kernel.bus.emit('event.deleted', {
    relayId,
    ids,
    cause: 'nip62',
    count: Math.max(removed, ids.length),
  });
  // Files and media of the person (blossom, media) follow the same request.
  kernel.bus.emit('user.vanished', { relayId, pubkey, until, scope: opts.scope ?? 'relay' });
  return { removed };
}
