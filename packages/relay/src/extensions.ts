// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Engine extension points used by NIP handlers that need to gate who may
 * read or write particular events (NIP-17/59 gift wraps, NIP-29 groups).
 *
 * Extensions are internal to the relay package: other modules use policy
 * hooks / access resolvers instead. Each method is optional; the engine runs
 * them in registration order.
 */
import type { Filter, NostrEvent, ReasonPrefix, RelayId } from '@beamhop/core';

/**
 * Who may receive an event: `null` means anyone allowed to read the relay;
 * otherwise a predicate over the NIP-42 authenticated pubkeys of a connection.
 */
export type Audience = ((authed: ReadonlySet<string>) => boolean) | null;

export type FilterCheck =
  | { ok: true; filters: Filter[] }
  | { ok: false; prefix: ReasonPrefix; message: string };

export interface Rejection {
  prefix: ReasonPrefix;
  message: string;
}

export interface WriteContext {
  relayId: RelayId;
  /** Pubkeys authenticated on the publishing connection (empty for internal writes). */
  authed: ReadonlySet<string>;
}

export interface RelayExtension {
  id: string;
  /** Restrict delivery of a stored or live event. */
  audience?(relayId: RelayId, event: NostrEvent): Audience | Promise<Audience>;
  /**
   * Check and optionally rewrite read filters (REQ, COUNT, NEG-OPEN) before
   * they reach the store. `authed` are the connection's NIP-42 pubkeys.
   */
  filters?(
    relayId: RelayId,
    filters: Filter[],
    authed: ReadonlySet<string>,
  ): FilterCheck | Promise<FilterCheck>;
  /** Write gate run after access checks and before the policy pipeline. */
  checkEvent?(event: NostrEvent, ctx: WriteContext): Promise<Rejection | undefined>;
  /**
   * Runs after an event was stored (or an ephemeral event accepted) and before
   * it is broadcast. Used to apply side effects such as group moderation.
   */
  afterAccept?(event: NostrEvent, ctx: WriteContext): Promise<void>;
}

/** Combine audiences: an event is visible only if every restriction admits the reader. */
export function allAudiences(list: Audience[]): Audience {
  const preds = list.filter((a): a is NonNullable<Audience> => a !== null);
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0]!;
  return (authed) => preds.every((p) => p(authed));
}
