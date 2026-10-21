// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NIP-13 proof of work: difficulty helpers and a policy hook that enforces
 * `limits.minPowDifficulty` (0 disables it).
 */
import {
  ACCEPT,
  type Kernel,
  type NostrEvent,
  type PolicyHooks,
  type UnsignedEvent,
  computeEventId,
  reject,
} from '@beamhop/core';

/** Number of leading zero bits of a hex string (e.g. an event id). */
export function countLeadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i]!, 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/** Committed target difficulty from the `nonce` tag (third element), if present. */
export function committedDifficulty(event: Pick<NostrEvent, 'tags'>): number | undefined {
  for (const t of event.tags) {
    if (t[0] !== 'nonce') continue;
    const n = Number(t[2]);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Effective difficulty: actual leading zero bits, capped by the committed target
 * when one is given (NIP-13 recommends honoring the commitment so lucky hashes
 * of low-effort spam do not count).
 */
export function powDifficulty(event: Pick<NostrEvent, 'id' | 'tags'>): number {
  const actual = countLeadingZeroBits(event.id);
  const committed = committedDifficulty(event);
  return committed === undefined ? actual : Math.min(actual, committed);
}

/**
 * Mine an unsigned event until its id has `difficulty` leading zero bits.
 * Returns the event with a `nonce` tag and its id; the caller signs it.
 */
export function minePow(
  unsigned: UnsignedEvent,
  difficulty: number,
): UnsignedEvent & { id: string } {
  const tags = unsigned.tags.filter((t) => t[0] !== 'nonce');
  const nonceTag = ['nonce', '0', String(difficulty)];
  const ev = { ...unsigned, tags: [...tags, nonceTag] };
  for (let n = 0; ; n++) {
    nonceTag[1] = String(n);
    const id = computeEventId(ev);
    if (countLeadingZeroBits(id) >= difficulty) return { ...ev, id };
  }
}

/** Policy hook enforcing `kernel.limits(relayId, tier).minPowDifficulty`. */
export function powHook(kernel: Kernel): PolicyHooks {
  return {
    id: 'relay.pow',
    priority: 110,
    onEvent(event, ctx) {
      const min = kernel.limits(ctx.relayId, ctx.tier).minPowDifficulty;
      if (!min) return ACCEPT;
      const d = powDifficulty(event);
      if (d < min) return reject('pow', `difficulty ${d} is less than ${min}`);
      return ACCEPT;
    },
  };
}
