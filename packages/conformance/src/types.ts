// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared types for checks, the runner and reports. */
import type { NostrEvent } from '@beamhop/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Dialer, RelayClient } from './client.ts';

export type Status = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  /** "NIP-01", "BUD-02", "fuzz" … */
  spec: string;
  title: string;
  status: Status;
  /** Plain-language explanation (why it failed / was skipped / what passed). */
  message: string;
  durationMs: number;
}

export interface Report {
  target: { relay: string; blossom?: string };
  software?: string;
  version?: string;
  supportedNips: number[];
  startedAt: string;
  durationMs: number;
  results: CheckResult[];
  summary: { pass: number; fail: number; skip: number; total: number };
}

/** NIP-11 relay information document (only fields the suite reads). */
export interface RelayInfo {
  name?: unknown;
  description?: unknown;
  pubkey?: unknown;
  software?: unknown;
  version?: unknown;
  supported_nips?: unknown;
  limitation?: {
    max_message_length?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    restricted_writes?: boolean;
    max_limit?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface Key {
  sk: Uint8Array;
  pk: string;
}

export interface EventTemplate {
  kind: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}

export interface SuiteContext {
  relayUrl: string;
  /** http(s) URL of the relay (for NIP-11). */
  httpUrl: string;
  blossomUrl?: string;
  info: RelayInfo | null;
  /** NIPs advertised in NIP-11 `supported_nips`. */
  nips: Set<number>;
  timeoutMs: number;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  dial: Dialer;
  /** Allow BUD-04 mirror checks against private/loopback source URLs. */
  allowPrivateMirror: boolean;
  /** Open a client; it is closed automatically when the check finishes. */
  connect(): Promise<RelayClient>;
  key(): Key;
  sign(key: Key, t: EventTemplate): NostrEvent;
  now(): number;
}

export interface Check {
  id: string;
  spec: string;
  title: string;
  /** Run only if the relay advertises any of these NIPs in NIP-11. */
  requiresNips?: number[];
  /** Needs `--blossom`. */
  blossom?: boolean;
  run(ctx: SuiteContext): Promise<string | undefined>;
}

export class CheckFailure extends Error {}
export class CheckSkip extends Error {}

export function fail(message: string): never {
  throw new CheckFailure(message);
}

export function skip(message: string): never {
  throw new CheckSkip(message);
}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckFailure(message);
}

export function newKey(): Key {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

export function signEvent(key: Key, t: EventTemplate, now: number): NostrEvent {
  const ev = finalizeEvent(
    {
      kind: t.kind,
      content: t.content ?? '',
      tags: t.tags ?? [],
      created_at: t.created_at ?? now,
    },
    key.sk,
  );
  // Plain object: drop nostr-tools' verified marker so tampering tests stay honest.
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  };
}

export function check(c: Check): Check {
  return c;
}

/** Random lowercase token for unique tags/content. */
export function token(n = 12): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
}

export function randomHex(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function short(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
