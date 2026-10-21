// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Node signing key for compliance artifacts (eDiscovery manifests, usage reports).
 * BIP-340 Schnorr over secp256k1 — the same primitive as Nostr, so the public key can
 * be published as the node's npub. The secret is wrapped by `ports.keyWrapper`
 * (local master key / KMS / Vault) when one is configured.
 */
import type { Ports } from '@beamhop/core';
import { schnorr } from '@noble/curves/secp256k1';
import { COL } from './config.ts';
import { b64decode, b64encode, fromHex, toHex } from './util.ts';

interface StoredKey {
  pubkey: string;
  /** Plain hex secret (no key wrapper configured). */
  secret?: string;
  /** Wrapped secret (base64) and wrapper provider. */
  wrapped?: string;
  provider?: string;
  createdAt: number;
}

export interface NodeSigner {
  pubkey: string;
  sign(msg: Uint8Array): Promise<string>;
}

export async function nodeSigner(ports: Ports): Promise<NodeSigner> {
  let rec = await ports.docs.get<StoredKey>(COL.keys, 'node');
  if (!rec) {
    const sk = schnorr.utils.randomPrivateKey();
    const next: StoredKey = {
      pubkey: toHex(schnorr.getPublicKey(sk)),
      createdAt: ports.clock.now(),
    };
    if (ports.keyWrapper) {
      next.wrapped = b64encode(await ports.keyWrapper.wrap(sk));
      next.provider = ports.keyWrapper.provider;
    } else {
      next.secret = toHex(sk);
    }
    if (!(await ports.docs.cas(COL.keys, 'node', null, next))) {
      rec = await ports.docs.get<StoredKey>(COL.keys, 'node');
    } else {
      rec = next;
    }
  }
  const stored = rec as StoredKey;
  const secret = async (): Promise<Uint8Array> => {
    if (stored.secret) return fromHex(stored.secret);
    if (!stored.wrapped || !ports.keyWrapper)
      throw new Error('The node signing key is wrapped but no key wrapper is configured');
    return ports.keyWrapper.unwrap(b64decode(stored.wrapped));
  };
  return {
    pubkey: stored.pubkey,
    async sign(msg) {
      return toHex(schnorr.sign(msg, await secret()));
    },
  };
}

export function verifySignature(sigHex: string, msg: Uint8Array, pubkeyHex: string): boolean {
  try {
    return schnorr.verify(fromHex(sigHex), msg, fromHex(pubkeyHex));
  } catch {
    return false;
  }
}
