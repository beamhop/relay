// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign in with a private key typed into the app (nsec, hex or a NIP-49
 * `ncryptsec`). The key lives only in memory for this session and signs the
 * NIP-98 login locally; it is never sent to the server and never logged.
 * "Remember on this device" stores it encrypted with a password (NIP-49).
 */
import type { NostrSigner, SignedEvent } from './nip98.ts';

export type KeyInput =
  | { kind: 'secret'; sk: Uint8Array }
  | { kind: 'encrypted'; ncryptsec: string }
  | { kind: 'public' }
  | { kind: 'invalid' };

const REMEMBER_KEY = 'beamhop.localKey';

export interface RememberedKey {
  ncryptsec: string;
  /** Hex public key, shown so the admin knows which key is stored. */
  pubkey: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Recognise what the admin pasted (nothing is stored or sent). */
export async function parseKeyInput(raw: string): Promise<KeyInput> {
  const text = raw.trim();
  if (/^ncryptsec1[02-9ac-hj-np-z]+$/i.test(text))
    return { kind: 'encrypted', ncryptsec: text.toLowerCase() };
  if (/^[0-9a-f]{64}$/i.test(text)) return { kind: 'secret', sk: hexToBytes(text.toLowerCase()) };
  if (/^npub1/i.test(text)) return { kind: 'public' };
  if (/^nsec1/i.test(text)) {
    try {
      const { decode } = await import('nostr-tools/nip19');
      const d = decode(text.toLowerCase());
      if (d.type === 'nsec') return { kind: 'secret', sk: d.data as Uint8Array };
    } catch {
      // fall through
    }
  }
  return { kind: 'invalid' };
}

/** Decrypt a NIP-49 `ncryptsec` with its password (throws on a wrong password). */
export async function decryptKey(ncryptsec: string, password: string): Promise<Uint8Array> {
  const { decrypt } = await import('nostr-tools/nip49');
  return decrypt(ncryptsec, password);
}

/** Encrypt a key as NIP-49 `ncryptsec` (scrypt, log2(N) = `logn`). */
export async function encryptKey(sk: Uint8Array, password: string, logn = 16): Promise<string> {
  const { encrypt } = await import('nostr-tools/nip49');
  return encrypt(sk, password, logn);
}

export async function publicKeyOf(sk: Uint8Array): Promise<string> {
  const { getPublicKey } = await import('nostr-tools/pure');
  return getPublicKey(sk);
}

/** A signer that keeps the key in this closure only (memory, this page). */
export async function localKeySigner(sk: Uint8Array): Promise<NostrSigner> {
  const { finalizeEvent, getPublicKey } = await import('nostr-tools/pure');
  const key = new Uint8Array(sk);
  const pubkey = getPublicKey(key);
  return {
    via: 'local',
    getPublicKey: async () => pubkey,
    signEvent: async (t) => finalizeEvent(t, key) as SignedEvent,
    close: async () => {
      key.fill(0);
    },
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function rememberedKey(): RememberedKey | null {
  try {
    const raw = storage()?.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RememberedKey;
    return typeof v.ncryptsec === 'string' && v.ncryptsec.startsWith('ncryptsec1') ? v : null;
  } catch {
    return null;
  }
}

/** Store the key encrypted with `password` (NIP-49) on this device. */
export async function rememberKey(sk: Uint8Array, password: string, logn = 16): Promise<void> {
  const ncryptsec = await encryptKey(sk, password, logn);
  const pubkey = await publicKeyOf(sk);
  storage()?.setItem(REMEMBER_KEY, JSON.stringify({ ncryptsec, pubkey } satisfies RememberedKey));
}

export function forgetKey(): void {
  try {
    storage()?.removeItem(REMEMBER_KEY);
  } catch {
    // ignore
  }
}
