import type { NostrEvent } from "@beamhop/sdk";
import { createHash } from "node:crypto";
import { getEventHash } from "nostr-tools/pure";
import { Lru } from "../util/lru";
import { schnorrOk } from "./schnorr";
import type { VerifyPool } from "./verify-pool";

/**
 * Schnorr verification is the most expensive step of the write pipeline (~0.2-2ms per event in JS).
 * The same event is frequently re-published by many clients, so successful (id, pubkey, sig) triples are cached.
 * The id is always recomputed from the event body (cheap sha256): a cache hit therefore proves the body
 * hashes to an id whose signature by `pubkey` was already verified.
 */
export class Verifier {
  private cache: Lru<string, true>;
  /** check(): signatures being verified, so concurrent copies of one event are verified once */
  private inflight = new Map<string, Promise<boolean>>();
  constructor(
    size = 20_000,
    /** where check() verifies signatures (main thread without one) */
    private readonly pool?: VerifyPool,
  ) {
    this.cache = new Lru(size);
  }

  /** Synchronous check, on the main thread (AUTH, NIP-98: rare). */
  verify(event: NostrEvent): boolean {
    const p = this.prepare(event);
    return typeof p === "boolean" ? p : this.verifyHere(p);
  }

  private verifyHere(p: { id: string; pubkey: string; sig: string; key: string }): boolean {
    const ok = schnorrOk(p.id, p.pubkey, p.sig);
    if (ok) this.cache.set(p.key, true);
    return ok;
  }

  /**
   * Same result as verify(). With a pool the signature is checked on its workers (a promise); without one this is
   * verify() itself, answered synchronously, so the pipeline pays no extra await.
   */
  check(event: NostrEvent): boolean | Promise<boolean> {
    if (!this.pool) return this.verify(event);
    const p = this.prepare(event);
    if (typeof p === "boolean") return p;
    let running = this.inflight.get(p.key);
    if (!running) {
      running = this.pool.verify(p.id, p.pubkey, p.sig).then((ok) => {
        this.inflight.delete(p.key);
        if (ok) this.cache.set(p.key, true);
        return ok;
      });
      this.inflight.set(p.key, running);
    }
    return running;
  }

  /**
   * Starts check() early (with a pool only): a connection's EVENTs are processed one at a time, so without this
   * one connection would keep a single worker busy. The pipeline's own check() then joins it or hits the cache.
   */
  prefetch(event: NostrEvent): void {
    if (this.pool) void this.check(event);
  }

  /** The verdict when the id or the cache settles it, else what the signature check needs. */
  private prepare(event: NostrEvent): boolean | { id: string; pubkey: string; sig: string; key: string } {
    // copy so a pre-set nostr-tools `verifiedSymbol` on caller objects can't short-circuit verification
    const ev = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
    let hash: string;
    try {
      hash = getEventHash(ev);
      if (hash !== ev.id && hasRawControl(ev)) hash = specEventHash(ev);
    } catch {
      return false;
    }
    if (hash !== ev.id) return false;
    if (typeof ev.sig !== "string") return false;
    const key = `${ev.id}:${ev.pubkey}:${ev.sig}`;
    if (this.cache.get(key)) return true;
    return { id: ev.id, pubkey: ev.pubkey, sig: ev.sig, key };
  }
}

/** Control characters JSON.stringify writes as \u00XX, but NIP-01 serializes verbatim (all but \n \r \t \b \f). */
const RAW_CONTROL = /[\u0000-\u0007\u000b\u000e-\u001f]/;
const SPEC_ESCAPES: Record<string, string> = { "\n": "\\n", '"': '\\"', "\\": "\\\\", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
const specString = (s: string) => `"${s.replace(/[\n"\\\r\t\b\f]/g, (c) => SPEC_ESCAPES[c])}"`;

function hasRawControl(ev: Pick<NostrEvent, "tags" | "content">): boolean {
  return RAW_CONTROL.test(ev.content) || ev.tags.some((t) => t.some((v) => RAW_CONTROL.test(v)));
}

/**
 * The id as NIP-01 specifies it: only \n \" \\ \r \t \b \f are escaped, "all other characters must be included
 * verbatim". JSON.stringify (getEventHash) escapes the other control characters as \u00XX instead, and most clients
 * sign that way, so an event matching either serialization is accepted.
 */
function specEventHash(ev: Omit<NostrEvent, "sig">): string {
  const tags = `[${ev.tags.map((t) => `[${t.map(specString).join(",")}]`).join(",")}]`;
  const body = `[0,${specString(ev.pubkey)},${ev.created_at},${ev.kind},${tags},${specString(ev.content)}]`;
  return createHash("sha256").update(body, "utf8").digest("hex");
}
