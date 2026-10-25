import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { assertSha256, thumbnailKey, type BlobDriver, type BlobObject, type ByteRange } from "./types";

const BunRt = (globalThis as unknown as { Bun?: { file(p: string): Blob } }).Bun;

/**
 * Under Bun a node stream (Readable.toWeb) is sent chunked and the Content-Length the route sets is dropped; a
 * Bun.file stream keeps it (downloads show their size and progress, range responses stay well-formed).
 */
function fileStream(path: string, range?: ByteRange): ReadableStream<Uint8Array> {
  if (BunRt) {
    const f = BunRt.file(path);
    return (range ? f.slice(range.start, range.end + 1) : f).stream() as ReadableStream<Uint8Array>;
  }
  const nodeStream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

/** `.<key>.<random>.tmp`: a write in progress, or one cut off by a crash */
const TEMP_RE = /^\..+\.tmp$/;
const SHARD_RE = /^[0-9a-f]{2}$/;

/**
 * Filesystem driver. Layout: `<root>/ab/cd/<sha256>` (+ `<sha256>.thumb.webp`).
 * Writes go to a temp file in the same directory, are fsynced and atomically renamed into place (then the directory
 * is fsynced, best effort), so a crash leaves either the whole blob or a temp file that `sweepTempFiles` removes.
 */
export function createFsDriver(root: string): BlobDriver {
  const dirOf = (sha256: string) => join(root, sha256.slice(0, 2), sha256.slice(2, 4));
  const pathOf = (sha256: string, key = sha256) => join(dirOf(sha256), key);

  async function writeAtomic(sha256: string, key: string, data: Uint8Array) {
    const dir = dirOf(sha256);
    await mkdir(dir, { recursive: true });
    const target = join(dir, key);
    const tmp = join(dir, `.${key}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(data);
      // the bytes must be on disk before the rename makes them the blob, or a power cut can leave a short file
      await fh.sync();
      await fh.close();
      await rename(tmp, target);
    } catch (err) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await syncDir(dir);
  }

  /** Persists the rename itself. Best effort: some platforms/filesystems (Windows) can't fsync a directory. */
  async function syncDir(dir: string) {
    try {
      const dh = await open(dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // ignore
    }
  }

  const listDir = async (dir: string): Promise<string[]> => {
    try {
      return await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  };

  async function read(path: string, range?: ByteRange): Promise<BlobObject | undefined> {
    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) return undefined;
      size = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return { body: fileStream(path, range), size, range };
  }

  return {
    name: "fs",
    async put(sha256, data) {
      assertSha256(sha256);
      await writeAtomic(sha256, sha256, data);
    },
    async get(sha256, range) {
      assertSha256(sha256);
      return read(pathOf(sha256), range);
    },
    async has(sha256, opts) {
      assertSha256(sha256);
      try {
        const st = await stat(pathOf(sha256));
        return st.isFile() && (opts?.size === undefined || st.size === opts.size);
      } catch {
        return false;
      }
    },
    async delete(sha256) {
      assertSha256(sha256);
      await rm(pathOf(sha256), { force: true });
      await rm(pathOf(sha256, thumbnailKey(sha256)), { force: true });
    },
    async putThumbnail(sha256, data) {
      assertSha256(sha256);
      await writeAtomic(sha256, thumbnailKey(sha256), data);
    },
    async getThumbnail(sha256) {
      assertSha256(sha256);
      return read(pathOf(sha256, thumbnailKey(sha256)));
    },
    async sweepTempFiles(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const a of await listDir(root)) {
        if (!SHARD_RE.test(a)) continue;
        for (const b of await listDir(join(root, a))) {
          if (!SHARD_RE.test(b)) continue;
          const dir = join(root, a, b);
          for (const name of await listDir(dir)) {
            if (!TEMP_RE.test(name)) continue;
            const p = join(dir, name);
            try {
              if ((await stat(p)).mtimeMs < cutoff) (await unlink(p), removed++);
            } catch {
              // gone already (finished or cleaned up by its writer)
            }
          }
        }
      }
      return removed;
    },
  };
}
