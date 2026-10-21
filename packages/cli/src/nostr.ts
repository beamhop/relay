// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signers for `beamhop login`: a NIP-46 bunker (preferred — the key never
 * touches this machine) or an nsec for automation (read from stdin or env,
 * never from a flag so it cannot end up in shell history). NIP-98 headers
 * are built here.
 */
import { decode } from 'nostr-tools/nip19';
import {
  type EventTemplate,
  type VerifiedEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { CliError } from './io.ts';

export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<VerifiedEvent>;
  close?(): Promise<void>;
  /** For the `X-Nostr-Signer` header. */
  readonly kind: 'nsec' | 'nip46';
}

export function parseSecretKey(input: string): Uint8Array {
  const t = input.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Uint8Array.from(Buffer.from(t, 'hex'));
  if (t.startsWith('nsec1')) {
    try {
      const d = decode(t);
      if (d.type === 'nsec') return d.data;
    } catch {
      // fall through
    }
  }
  throw new CliError('That is not a valid secret key (expected nsec1… or 64 hex characters).');
}

export function nsecSigner(input: string): Signer {
  const sk = parseSecretKey(input);
  return {
    kind: 'nsec',
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t) => finalizeEvent(t, sk),
  };
}

export async function bunkerSigner(uri: string, onAuth?: (url: string) => void): Promise<Signer> {
  const { BunkerSigner, parseBunkerInput } = await import('nostr-tools/nip46');
  const bp = await parseBunkerInput(uri.trim());
  if (!bp) throw new CliError('That is not a valid bunker address (expected bunker://…).');
  const params = onAuth ? { onauth: onAuth } : {};
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, params);
  try {
    await signer.connect();
  } catch (err) {
    await signer.close().catch(() => {});
    throw new CliError(
      'The bunker did not answer. Check the address and approve the request in your signer app.',
      1,
      String(err),
    );
  }
  return {
    kind: 'nip46',
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (t) => signer.signEvent(t),
    close: () => signer.close(),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(d).toString('hex');
}

/** `Authorization: Nostr <base64 kind-27235 event>` for one request (NIP-98). */
export async function nip98Header(
  signer: Signer,
  url: string,
  method: string,
  body: string | undefined,
  nowSeconds: number,
): Promise<string> {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (body) tags.push(['payload', await sha256Hex(body)]);
  const ev = await signer.signEvent({ kind: 27235, created_at: nowSeconds, tags, content: '' });
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`;
}
