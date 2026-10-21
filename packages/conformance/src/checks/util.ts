// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NostrEvent } from '@beamhop/core';
import { type RelayClient, reasonPrefix } from '../client.ts';
import { expect, fail, short } from '../types.ts';

/** Publish and require acceptance. */
export async function mustAccept(c: RelayClient, ev: NostrEvent, what: string): Promise<string> {
  const r = await c.publish(ev);
  expect(r, `The relay did not confirm ${what} (no OK message in time).`);
  expect(r.accepted, `The relay refused ${what}: "${short(r.message)}".`);
  return r.message;
}

/** Publish and require refusal (OK false). Returns the reason. */
export async function mustRefuse(
  c: RelayClient,
  ev: NostrEvent | Record<string, unknown>,
  what: string,
): Promise<string> {
  const r = await c.publish(ev);
  expect(r, `The relay did not answer ${what} (no OK message in time).`);
  expect(!r.accepted, `The relay accepted ${what}, but it should have refused it.`);
  return r.message;
}

/** Require a NIP-01 machine-readable prefix on a refusal reason. */
export function mustHavePrefix(message: string, allowed?: string[]): string {
  const p = reasonPrefix(message);
  if (!p) fail(`The refusal reason "${short(message)}" has no standard prefix like "invalid:".`);
  if (allowed && !allowed.includes(p))
    fail(`Expected a reason starting with ${allowed.join(' or ')}, got "${short(message)}".`);
  return p;
}

export async function query(c: RelayClient, filters: unknown[]) {
  const r = await c.req(filters);
  if (r.timedOut) fail('The relay did not finish answering a query (no EOSE in time).');
  if (r.closed !== undefined) fail(`The relay refused a normal query: "${short(r.closed)}".`);
  return r.events;
}

export const ids = (evs: NostrEvent[]) => evs.map((e) => e.id);

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
