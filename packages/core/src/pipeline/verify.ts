import type { NostrEvent } from "@beamhop/sdk";
import { verifyEvent } from "nostr-tools/pure";
import { Lru } from "../util/lru";

/**
 * Schnorr verification is the most expensive step of the write pipeline (~0.5-2ms per event in JS).
 * The same event is frequently re-published by many clients, so successful (id, sig) pairs are cached.
 */
export class Verifier {
  private cache: Lru<string, true>;
  hits = 0;
  misses = 0;
  constructor(size = 20_000) {
    this.cache = new Lru(size);
  }
  verify(event: NostrEvent): boolean {
    const key = event.id + event.sig;
    if (this.cache.get(key)) {
      this.hits++;
      return true;
    }
    this.misses++;
    // copy so a pre-set nostr-tools `verifiedSymbol` on caller objects can't short-circuit verification
    const ok = verifyEvent({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig });
    if (ok) this.cache.set(key, true);
    return ok;
  }
}
