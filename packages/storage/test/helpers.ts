import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "@beamhop/sdk";

export interface Signer {
  sk: Uint8Array;
  pubkey: string;
  sign(e: { kind: number; created_at: number; tags?: string[][]; content?: string }): NostrEvent;
}

export function signer(): Signer {
  const sk = generateSecretKey();
  return {
    sk,
    pubkey: getPublicKey(sk),
    sign: (e) => finalizeEvent({ kind: e.kind, created_at: e.created_at, tags: e.tags ?? [], content: e.content ?? "" }, sk) as NostrEvent,
  };
}
