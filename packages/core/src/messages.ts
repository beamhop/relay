// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NostrEvent } from './event.ts';
import type { Filter } from './filter.ts';

/** Client → relay messages (NIP-01, NIP-42, NIP-45, NIP-77). */
export type ClientMessage =
  | ['EVENT', NostrEvent]
  | ['REQ', string, ...Filter[]]
  | ['CLOSE', string]
  | ['AUTH', NostrEvent]
  | ['COUNT', string, ...Filter[]]
  | ['NEG-OPEN', string, Filter, string]
  | ['NEG-MSG', string, string]
  | ['NEG-CLOSE', string];

/** Relay → client messages. */
export type RelayMessage =
  | ['EVENT', string, NostrEvent]
  | ['OK', string, boolean, string]
  | ['EOSE', string]
  | ['CLOSED', string, string]
  | ['NOTICE', string]
  | ['AUTH', string]
  | ['COUNT', string, { count: number; approximate?: boolean }]
  | ['NEG-MSG', string, string]
  | ['NEG-ERR', string, string];

/** Standard machine-readable prefixes for OK/CLOSED reasons (NIP-01). */
export type ReasonPrefix =
  | 'duplicate'
  | 'pow'
  | 'blocked'
  | 'rate-limited'
  | 'invalid'
  | 'restricted'
  | 'auth-required'
  | 'mute'
  | 'error';

export function reason(prefix: ReasonPrefix, message: string): string {
  return `${prefix}: ${message}`;
}

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; reason: string };

/** Parse a raw client frame. Only checks the envelope; event/filter contents are validated later. */
export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid: malformed JSON' };
  }
  if (!Array.isArray(data) || typeof data[0] !== 'string') {
    return { ok: false, reason: 'invalid: message must be an array' };
  }
  const [type] = data;
  switch (type) {
    case 'EVENT':
    case 'AUTH':
      if (data.length !== 2) return { ok: false, reason: `invalid: ${type} arity` };
      return { ok: true, message: data as ClientMessage };
    case 'REQ':
    case 'COUNT':
      if (typeof data[1] !== 'string' || data[1].length === 0 || data[1].length > 64)
        return { ok: false, reason: 'invalid: subscription id' };
      return { ok: true, message: data as ClientMessage };
    case 'CLOSE':
    case 'NEG-CLOSE':
      if (typeof data[1] !== 'string') return { ok: false, reason: 'invalid: subscription id' };
      return { ok: true, message: data as ClientMessage };
    case 'NEG-OPEN':
    case 'NEG-MSG':
      if (typeof data[1] !== 'string') return { ok: false, reason: 'invalid: subscription id' };
      return { ok: true, message: data as ClientMessage };
    default:
      return { ok: false, reason: `invalid: unknown message type ${type}` };
  }
}
