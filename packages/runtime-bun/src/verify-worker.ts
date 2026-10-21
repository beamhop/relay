// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signature-check worker (see verify-pool.ts). Receives batches of
 * `[id, pubkey, sig, id, pubkey, sig, …]` hex strings and answers with one byte
 * per event (1 = valid BIP-340 signature over the id). Kept dependency-light so
 * workers start fast: only @noble/curves, no Beamhop core.
 */
import { schnorr } from '@noble/curves/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';
import type { VerifyRequest, VerifyResponse } from './verify-pool.ts';

interface WorkerScope {
  postMessage(m: VerifyResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<VerifyRequest>) => void) | null;
}
const scope = globalThis as unknown as WorkerScope;

function verifyTriples(data: readonly string[]): Uint8Array {
  const n = Math.floor(data.length / 3);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    try {
      const id = data[i * 3] as string;
      const pubkey = data[i * 3 + 1] as string;
      const sig = data[i * 3 + 2] as string;
      ok[i] = schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey)) ? 1 : 0;
    } catch {
      ok[i] = 0;
    }
  }
  return ok;
}

scope.onmessage = (e) => {
  const { seq, data } = e.data;
  const ok = verifyTriples(data);
  scope.postMessage({ seq, ok }, [ok.buffer]);
};
