/**
 * Signs many events up front on worker threads (~0.4 ms per signature on one core), so timed runs measure the relay,
 * not the load generator.
 */
import { cpus } from "node:os";
import type { Event } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools";

export interface Template {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface Signer {
  sk: Uint8Array;
  pubkey: string;
}

export const newSigner = (): Signer => {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
};

export interface SignJob {
  sk: Uint8Array;
  t: Template;
}

/** Signs every job, split over `threads` workers. Order is kept. */
export async function signAll(jobs: SignJob[], threads = Math.max(1, cpus().length - 2)): Promise<Event[]> {
  const per = Math.ceil(jobs.length / threads);
  const parts = await Promise.all(
    Array.from({ length: threads }, (_, i) => {
      const slice = jobs.slice(i * per, (i + 1) * per);
      if (!slice.length) return Promise.resolve([] as Event[]);
      const w = new Worker(new URL("./sign-worker.ts", import.meta.url));
      return new Promise<Event[]>((resolve, reject) => {
        w.onmessage = (m: MessageEvent<Event[]>) => {
          w.terminate();
          resolve(m.data);
        };
        w.onerror = (e) => reject(e);
        w.postMessage(slice);
      });
    }),
  );
  return parts.flat();
}

/** `n` notes from `signers` (round robin), each with a hashtag like real notes. */
export async function makeNotes(
  n: number,
  signers: Signer[],
  opts: { kind?: number; tags?: (i: number) => string[][]; content?: (i: number) => string } = {},
): Promise<Event[]> {
  const now = Math.floor(Date.now() / 1000);
  const jobs: SignJob[] = [];
  for (let i = 0; i < n; i++) {
    jobs.push({
      sk: signers[i % signers.length].sk,
      t: {
        kind: opts.kind ?? 1,
        created_at: now - (i % 600),
        tags: opts.tags?.(i) ?? [["t", `load${i % 20}`]],
        content: opts.content?.(i) ?? `load test note ${i} ${crypto.randomUUID()}`,
      },
    });
  }
  return signAll(jobs);
}
