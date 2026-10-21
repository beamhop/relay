// SPDX-License-Identifier: AGPL-3.0-or-later
/** Nostr signers: NIP-07 browser extension and NIP-46 remote bunker. */
import type { EventTemplate, NostrSigner, SignedEvent } from './nip98.ts';

export function hasExtension(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

export function nip07Signer(): NostrSigner {
  const ext = () => {
    if (!window.nostr) throw new Error('No Nostr extension found');
    return window.nostr;
  };
  return {
    via: 'nip07',
    getPublicKey: () => ext().getPublicKey(),
    signEvent: (t: EventTemplate) => ext().signEvent(t) as Promise<SignedEvent>,
  };
}

const BUNKER_KEY = 'beamhop.bunker';

interface StoredBunker {
  uri: string;
  /** Hex client secret; kept so the bunker connection survives reloads within the tab. */
  sk: string;
}

/** Connect to a NIP-46 bunker (`bunker://…` or NIP-05). Loaded lazily (relay pool code). */
export async function nip46Signer(
  input: string,
  opts: { onAuth?: (url: string) => void; reuse?: StoredBunker } = {},
): Promise<NostrSigner> {
  const [{ BunkerSigner, parseBunkerInput }, { generateSecretKey }, { bytesToHex, hexToBytes }] =
    await Promise.all([
      import('nostr-tools/nip46'),
      import('nostr-tools/pure'),
      import('nostr-tools/utils'),
    ]);
  const bp = await parseBunkerInput(input);
  if (!bp) throw new Error('That does not look like a bunker address');
  const sk = opts.reuse ? hexToBytes(opts.reuse.sk) : generateSecretKey();
  const params: { onauth?: (url: string) => void } = {};
  if (opts.onAuth) params.onauth = opts.onAuth;
  const bunker = BunkerSigner.fromBunker(sk, bp, params);
  if (!opts.reuse) await bunker.connect();
  try {
    sessionStorage.setItem(BUNKER_KEY, JSON.stringify({ uri: input, sk: bytesToHex(sk) }));
  } catch {
    // storage unavailable: the bunker session lasts for this page only
  }
  return {
    via: 'nip46',
    getPublicKey: () => bunker.getPublicKey(),
    signEvent: (t) => bunker.signEvent(t) as Promise<SignedEvent>,
    close: () => bunker.close(),
  };
}

export function storedBunker(): StoredBunker | null {
  try {
    const raw = sessionStorage.getItem(BUNKER_KEY);
    return raw ? (JSON.parse(raw) as StoredBunker) : null;
  } catch {
    return null;
  }
}

export function forgetBunker(): void {
  try {
    sessionStorage.removeItem(BUNKER_KEY);
  } catch {
    // ignore
  }
}
