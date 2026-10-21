// SPDX-License-Identifier: AGPL-3.0-or-later
import { type NostrEvent, finalizeEvent, generateSecretKey, getPublicKey } from '@beamhop/core';

export interface TestKey {
  sk: string;
  pk: string;
}

export function makeKey(): TestKey {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

let clock = 1_700_000_000;

/** Sign a test event. created_at auto-increments unless given. */
export function makeEvent(
  key: TestKey,
  partial: Partial<Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>> = {},
): NostrEvent {
  return finalizeEvent(
    {
      kind: partial.kind ?? 1,
      tags: partial.tags ?? [],
      content: partial.content ?? 'hello',
      created_at: partial.created_at ?? clock++,
    },
    key.sk,
  );
}
