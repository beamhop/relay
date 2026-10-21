// SPDX-License-Identifier: AGPL-3.0-or-later
/** Unsigned-but-well-formed events for bulk tests/benchmarks (stores don't verify). */
import type { NostrEvent } from '@beamhop/core';

export function randHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fakeEvent(partial: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: randHex(32),
    pubkey: randHex(32),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'hello world',
    sig: randHex(64),
    ...partial,
  };
}
