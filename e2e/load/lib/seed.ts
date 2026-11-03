/**
 * Deterministic synthetic corpus for the historical-query benchmarks, bulk-inserted straight into the event tables
 * (ids and signatures are placeholders: stored events are never re-verified, and inserting through the relay would
 * take hours for millions of events). Event `i` is always the same event, so benchmarks know what to query for.
 *
 * Shape: AUTHORS authors with a Zipf-like share each (author 0 is the heaviest), kinds 1 (notes, ~60%), 7 (reactions,
 * ~25%, e+p tags), 6 (reposts, ~5%), 1111 (comments, ~10%, e+p+t tags), created_at spread over the last year,
 * note content drawn from a fixed vocabulary (so search terms have known frequencies).
 */
import { createHash } from "node:crypto";
import type { Beamhop } from "@beamhop/server";

type Db = Beamhop["stores"]["db"];

export const AUTHORS = 2000;
export const YEAR = 365 * 86_400;
export const HASHTAGS = Array.from({ length: 50 }, (_, i) => `tag${i}`);
export const WORDS = [
  "nostr", "relay", "bitcoin", "coffee", "morning", "music", "photo", "travel", "code", "release", "weather",
  "garden", "book", "movie", "running", "pizza", "design", "privacy", "freedom", "sunset", "mountain", "ocean",
  "kitten", "zap", "meme", "linux", "rust", "typescript", "server", "database", "postgres", "sqlite", "index",
  "query", "latency", "throughput", "benchmark", "camera", "bike", "train", "rain", "snow", "spring", "autumn",
  "winter", "summer", "chess", "guitar", "piano", "painting", "rareword",
];

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const authorPubkey = (i: number) => hex(`load-author:${i}`);
export const eventId = (i: number) => hex(`load-event:${i}`);

/** mulberry32: small seeded PRNG */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zipf-ish author pick: cumulative weights 1/(k+1) */
const cumulative = (() => {
  const c: number[] = [];
  let s = 0;
  for (let k = 0; k < AUTHORS; k++) c.push((s += 1 / (k + 1)));
  return c.map((x) => x / s);
})();
function pickAuthor(r: number): number {
  let lo = 0;
  let hi = AUTHORS - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SeedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** Event number `i` of the corpus (timestamps relative to `base`, the seeding run's "now"). */
export function seedEvent(i: number, base: number): SeedEvent {
  const r = rng(i * 7919 + 17);
  const author = pickAuthor(r());
  const created_at = base - Math.floor(r() * YEAR);
  const k = r();
  const kind = k < 0.6 ? 1 : k < 0.85 ? 7 : k < 0.9 ? 6 : 1111;
  const tags: string[][] = [];
  const ref = () => eventId(Math.floor(r() * Math.max(1, i)));
  const p = () => authorPubkey(pickAuthor(r()));
  let content = "";
  if (kind === 1 || kind === 1111) {
    const n = 5 + Math.floor(r() * 20);
    const words: string[] = [];
    // "rareword" is the last word: picked about once in a few hundred notes
    for (let w = 0; w < n; w++) words.push(WORDS[Math.floor(r() * r() * WORDS.length)]);
    content = words.join(" ");
    if (r() < 0.3) tags.push(["p", p()]);
    if (r() < 0.15) tags.push(["t", HASHTAGS[Math.floor(r() * r() * HASHTAGS.length)]]);
  }
  if (kind === 7) {
    content = "+";
    tags.push(["e", ref()], ["p", p()]);
  }
  if (kind === 6) tags.push(["e", ref()], ["p", p()]);
  if (kind === 1111) tags.push(["e", ref()], ["p", p()], ["t", HASHTAGS[Math.floor(r() * HASHTAGS.length)]]);
  return { id: eventId(i), pubkey: authorPubkey(author), created_at, kind, tags, content };
}

const SIG = "0".repeat(128);
const BATCH = 1000;
const ROWS_PER_STATEMENT = 200;

/** Inserts events [offset, offset + n) (created_at relative to `base`) in transactions of BATCH. Returns the number inserted. */
export async function seedEvents(db: Db, n: number, offset: number, base: number, progress?: (done: number) => void): Promise<number> {
  let done = 0;
  for (let start = offset; start < offset + n; start += BATCH) {
    const evs: SeedEvent[] = [];
    for (let i = start; i < Math.min(offset + n, start + BATCH); i++) evs.push(seedEvent(i, base));
    await db.tx(async (tx) => {
      const seqs = new Map<string, number>();
      for (let j = 0; j < evs.length; j += ROWS_PER_STATEMENT) {
        const part = evs.slice(j, j + ROWS_PER_STATEMENT);
        const rows = await tx.all<{ seq: number; id: string }>(
          `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, d_tag, expiration) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, NULL, NULL)").join(", ")} RETURNING seq, id`,
          part.flatMap((e) => [e.id, e.pubkey, e.created_at, e.kind, JSON.stringify(e.tags), e.content, SIG]),
        );
        for (const row of rows) seqs.set(row.id, Number(row.seq));
      }
      const tagRows: unknown[] = [];
      let count = 0;
      const flush = async () => {
        if (!count) return;
        await tx.run(`INSERT INTO event_tags (event_seq, name, value, created_at) VALUES ${Array.from({ length: count }, () => "(?, ?, ?, ?)").join(", ")}`, tagRows.splice(0));
        count = 0;
      };
      for (const e of evs) {
        const seen = new Set<string>();
        for (const [name, value] of e.tags) {
          if (seen.has(`${name}:${value}`)) continue;
          seen.add(`${name}:${value}`);
          tagRows.push(seqs.get(e.id), name, value, e.created_at);
          if (++count >= 500) await flush();
        }
      }
      await flush();
    });
    done += evs.length;
    if (progress && done % 50_000 < BATCH) progress(done);
  }
  return done;
}
