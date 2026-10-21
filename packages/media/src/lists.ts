// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Known-abuse perceptual hash lists (§5.3), configured per relay in
 * `blossom.scanning.lists` as local paths or http(s) URLs.
 *
 * File format: one hash per line, 16 hex chars (64-bit). Optional `phash:` /
 * `dhash:` prefix (default phash). Blank lines and `#` comments are ignored;
 * anything after the hash on a line is ignored too (labels).
 *
 * Real CSAM/abuse hash lists are only available under legal agreements with the
 * organisations that maintain them; Beamhop ships none (only a synthetic test list).
 */
import { hashWords, popcount32 } from './hash.ts';

export type HashAlgo = 'phash' | 'dhash';

export interface HashEntry {
  algo: HashAlgo;
  hash: string;
  hi: number;
  lo: number;
}

export interface HashList {
  source: string;
  entries: HashEntry[];
  /** Lines that were not valid hashes. */
  invalid: number;
  loadedAt: number;
  error?: string;
}

export interface ParsedList {
  entries: HashEntry[];
  invalid: number;
}

export function parseHashList(text: string): ParsedList {
  const entries: HashEntry[] = [];
  let invalid = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const token = (line.split(/[\s,;]+/)[0] ?? '').toLowerCase();
    const m = /^(?:(phash|dhash):)?([0-9a-f]{16})$/.exec(token);
    const words = m ? hashWords(m[2] as string) : null;
    if (!m || !words) {
      invalid++;
      continue;
    }
    entries.push({
      algo: (m[1] as HashAlgo) ?? 'phash',
      hash: m[2] as string,
      hi: words[0],
      lo: words[1],
    });
  }
  return { entries, invalid };
}

export interface ListMatch {
  source: string;
  algo: HashAlgo;
  /** The list entry that matched. */
  entry: string;
  distance: number;
}

/** Closest list entry within `threshold` bits, or null. */
export function matchHashes(
  hashes: Partial<Record<HashAlgo, string>>,
  lists: HashList[],
  threshold: number,
): ListMatch | null {
  let best: ListMatch | null = null;
  for (const algo of ['phash', 'dhash'] as const) {
    const h = hashes[algo];
    const words = h ? hashWords(h) : null;
    if (!words) continue;
    for (const list of lists) {
      for (const e of list.entries) {
        if (e.algo !== algo) continue;
        const d = popcount32(e.hi ^ words[0]) + popcount32(e.lo ^ words[1]);
        if (d <= threshold && (!best || d < best.distance)) {
          best = { source: list.source, algo, entry: e.hash, distance: d };
          if (d === 0) return best;
        }
      }
    }
  }
  return best;
}

export interface ListLoaderOptions {
  /** fetch for http(s) lists (tests inject a stub). Default global fetch. */
  fetch?: (req: Request) => Promise<Response>;
  /** Read a local list file. Default: lazy `node:fs/promises` (Bun / Node only). */
  readFile?: (path: string) => Promise<string>;
  /** Max list size in bytes. Default 64 MiB. */
  maxBytes?: number;
  timeoutMs?: number;
}

async function defaultReadFile(path: string): Promise<string> {
  // Variable specifier keeps this out of Worker bundles; local lists are a VM feature.
  const specifier = 'node:fs/promises';
  const fs = (await import(specifier)) as { readFile(p: string, enc: string): Promise<string> };
  return fs.readFile(path, 'utf8');
}

export async function loadListText(source: string, o: ListLoaderOptions = {}): Promise<string> {
  const max = o.maxBytes ?? 64 * 1024 * 1024;
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const doFetch = o.fetch ?? ((r: Request) => fetch(r));
    const res = await doFetch(
      new Request(source, { signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } else {
    const path = source.startsWith('file://')
      ? decodeURIComponent(new URL(source).pathname)
      : source;
    text = await (o.readFile ?? defaultReadFile)(path);
  }
  if (text.length > max) throw new Error(`list is larger than ${max} bytes`);
  return text;
}

/**
 * Loaded lists keyed by source. `get` loads missing sources on demand; `refresh`
 * reloads everything (scheduled). A failed reload keeps the previous entries.
 */
export class HashListCache {
  private readonly lists = new Map<string, HashList>();
  private readonly inflight = new Map<string, Promise<HashList>>();

  constructor(private readonly opts: ListLoaderOptions & { now: () => number }) {}

  async get(sources: readonly string[]): Promise<HashList[]> {
    return Promise.all(sources.map((s) => this.lists.get(s) ?? this.load(s)));
  }

  async refresh(sources: readonly string[]): Promise<void> {
    await Promise.all([...new Set(sources)].map((s) => this.load(s)));
    for (const k of [...this.lists.keys()]) if (!sources.includes(k)) this.lists.delete(k);
  }

  status(): HashList[] {
    return [...this.lists.values()];
  }

  private load(source: string): Promise<HashList> {
    const running = this.inflight.get(source);
    if (running) return running;
    const p = (async () => {
      const prev = this.lists.get(source);
      let list: HashList;
      try {
        const parsed = parseHashList(await loadListText(source, this.opts));
        list = { source, ...parsed, loadedAt: this.opts.now() };
      } catch (err) {
        list = {
          source,
          entries: prev?.entries ?? [],
          invalid: prev?.invalid ?? 0,
          loadedAt: prev?.loadedAt ?? 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      this.lists.set(source, list);
      return list;
    })().finally(() => this.inflight.delete(source));
    this.inflight.set(source, p);
    return p;
  }
}
