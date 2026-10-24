import type { NostrEvent } from "@beamhop/sdk";
import { getEventHash, verifyEvent } from "nostr-tools/pure";
import { Lru } from "../util/lru";

/**
 * Schnorr verification is the most expensive step of the write pipeline (~0.5-2ms per event in JS).
 * The same event is frequently re-published by many clients, so successful (id, sig) pairs are cached.
 * The id is always recomputed from the event body first (cheap sha256), so a cache hit can never
 * vouch for an event whose content was altered while keeping a known-good id/sig.
 */
export class Verifier {
  private cache: Lru<string, true>;
  hits = 0;
  misses = 0;
  constructor(size = 20_000) {
    this.cache = new Lru(size);
  }
  verify(event: NostrEvent): boolean {
    // copy so a pre-set nostr-tools `verifiedSymbol` on caller objects can't short-circuit verification
    const copy = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
    try {
      if (getEventHash(copy) !== event.id) return false;
    } catch {
      return false;
    }
    const key = event.id + event.sig;
    if (this.cache.get(key)) {
      this.hits++;
      return true;
    }
    this.misses++;
    const ok = verifyEvent(copy);
    if (ok) this.cache.set(key, true);
    return ok;
  }
}
