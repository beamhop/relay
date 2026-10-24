import type { NostrEvent } from "@beamhop/sdk";
import { getEventHash, verifyEvent } from "nostr-tools/pure";
import { Lru } from "../util/lru";

/**
 * Schnorr verification is the most expensive step of the write pipeline (~0.5-2ms per event in JS).
 * The same event is frequently re-published by many clients, so successful (id, pubkey, sig) triples are cached.
 * The id is always recomputed from the event body (cheap sha256): a cache hit therefore proves the body
 * hashes to an id whose signature by `pubkey` was already verified.
 */
export class Verifier {
  private cache: Lru<string, true>;
  constructor(size = 20_000) {
    this.cache = new Lru(size);
  }
  verify(event: NostrEvent): boolean {
    // copy so a pre-set nostr-tools `verifiedSymbol` on caller objects can't short-circuit verification
    const ev = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
    let hash: string;
    try {
      hash = getEventHash(ev);
    } catch {
      return false;
    }
    if (hash !== ev.id) return false;
    const key = `${ev.id}:${ev.pubkey}:${ev.sig}`;
    if (this.cache.get(key)) return true;
    const ok = verifyEvent(ev);
    if (ok) this.cache.set(key, true);
    return ok;
  }
}
