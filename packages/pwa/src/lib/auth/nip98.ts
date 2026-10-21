// SPDX-License-Identifier: AGPL-3.0-or-later
/** NIP-98 HTTP auth (kind 27235) header creation for sign-in requests. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const NIP98_KIND = 27235;

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface SignedEvent extends EventTemplate {
  id: string;
  pubkey: string;
  sig: string;
}

/**
 * Anything that can sign Nostr events: a NIP-07 extension, a NIP-46 bunker,
 * or a private key held in memory by this page (`local`).
 */
export interface NostrSigner {
  via: 'nip07' | 'nip46' | 'local';
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<SignedEvent>;
  close?(): Promise<void>;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function base64(text: string): string {
  const bytes = utf8ToBytes(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Build the event template for a request (exported for tests). */
export function nip98Template(
  url: string,
  method: string,
  body: string | undefined,
  now = Math.floor(Date.now() / 1000),
): EventTemplate {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (body) tags.push(['payload', sha256Hex(body)]);
  return { kind: NIP98_KIND, created_at: now, tags, content: '' };
}

/** `Authorization` header value for one request. `body` must be the exact bytes sent. */
export async function nip98Header(
  signer: NostrSigner,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const ev = await signer.signEvent(nip98Template(url, method, body));
  return `Nostr ${base64(JSON.stringify(ev))}`;
}
