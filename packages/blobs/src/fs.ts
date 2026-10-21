// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Filesystem BlobStore — Bun only (imported via `@beamhop/blobs/fs` so Workers
 * bundles never pull it in).
 *
 * Layout: `<root>/<aa>/<bb>/<sha256>` (data) + `<sha256>.json` (`{ type }`),
 * sharded by the first two hex byte pairs. Writes go to `<root>/.tmp/` and are
 * published with an atomic rename; the data file appearing is the commit point.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobBody, BlobMeta, BlobStore, ByteRange } from '@beamhop/core';
import { DEFAULT_TYPE, assertSha256, isSha256 } from './util.ts';

export interface FsBlobStoreOptions {
  /** Root directory, e.g. `./data/blobs`. */
  root: string;
}

export class FsBlobStore implements BlobStore {
  readonly kind = 'fs';
  private readonly root: string;
  private readonly tmp: string;

  constructor(opts: FsBlobStoreOptions | string) {
    this.root = typeof opts === 'string' ? opts : opts.root;
    this.tmp = join(this.root, '.tmp');
  }

  private dir(sha256: string): string {
    assertSha256(sha256);
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4));
  }

  private path(sha256: string): string {
    return join(this.dir(sha256), sha256);
  }

  async init(): Promise<void> {
    await mkdir(this.tmp, { recursive: true });
    // Leftovers from interrupted writes are never visible; clean them up.
    for (const f of await readdir(this.tmp).catch(() => [] as string[])) {
      await rm(join(this.tmp, f), { force: true }).catch(() => {});
    }
  }

  private async readType(sha256: string): Promise<string> {
    try {
      const j = JSON.parse(await readFile(`${this.path(sha256)}.json`, 'utf8')) as {
        type?: string;
      };
      return j.type || DEFAULT_TYPE;
    } catch {
      return DEFAULT_TYPE;
    }
  }

  async head(sha256: string): Promise<BlobMeta | null> {
    try {
      const s = await stat(this.path(sha256));
      return { sha256, size: s.size, type: await this.readType(sha256) };
    } catch {
      return null;
    }
  }

  async get(sha256: string, range?: ByteRange): Promise<BlobBody | null> {
    const meta = await this.head(sha256);
    if (!meta) return null;
    let file: Blob = Bun.file(this.path(sha256));
    if (range) file = file.slice(range.start, range.end + 1);
    return { ...meta, body: file.stream() as ReadableStream<Uint8Array> };
  }

  async put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const final = this.path(meta.sha256);
    if (await this.head(meta.sha256)) {
      if (!(data instanceof Uint8Array)) await data.cancel().catch(() => {});
      return;
    }
    await mkdir(this.tmp, { recursive: true });
    await mkdir(this.dir(meta.sha256), { recursive: true });
    const id = `${meta.sha256}.${crypto.randomUUID()}`;
    const tmpData = join(this.tmp, id);
    const tmpMeta = join(this.tmp, `${id}.json`);
    try {
      if (data instanceof Uint8Array) {
        await Bun.write(tmpData, data);
      } else {
        const sink = Bun.file(tmpData).writer();
        const reader = data.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sink.write(value);
            await sink.flush();
          }
        } finally {
          await sink.end();
          reader.releaseLock();
        }
      }
      await writeFile(tmpMeta, JSON.stringify({ type: meta.type || DEFAULT_TYPE }));
      await rename(tmpMeta, `${final}.json`);
      await rename(tmpData, final);
    } catch (err) {
      await rm(tmpData, { force: true }).catch(() => {});
      await rm(tmpMeta, { force: true }).catch(() => {});
      throw err;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    const p = this.path(sha256);
    try {
      await rm(p);
    } catch {
      return false;
    }
    await rm(`${p}.json`, { force: true }).catch(() => {});
    return true;
  }

  async list(opts?: { cursor?: string; limit?: number }): Promise<{
    items: BlobMeta[];
    cursor?: string;
  }> {
    const limit = Math.max(opts?.limit ?? 100, 1);
    const cursor = opts?.cursor ?? '';
    const items: BlobMeta[] = [];
    let more = false;
    const hex2 = (s: string) => /^[0-9a-f]{2}$/.test(s);
    const sorted = async (p: string) => (await readdir(p).catch(() => [] as string[])).sort();
    outer: for (const a of (await sorted(this.root)).filter(hex2)) {
      if (a < cursor.slice(0, 2)) continue;
      for (const b of (await sorted(join(this.root, a))).filter(hex2)) {
        if (`${a}${b}` < cursor.slice(0, 4)) continue;
        for (const f of await sorted(join(this.root, a, b))) {
          if (!isSha256(f) || f <= cursor) continue;
          if (items.length >= limit) {
            more = true;
            break outer;
          }
          const m = await this.head(f);
          if (m) items.push(m);
        }
      }
    }
    const last = items[items.length - 1];
    return { items, cursor: more && last ? last.sha256 : undefined };
  }
}
