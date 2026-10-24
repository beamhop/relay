import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { assertSha256, thumbnailKey, type BlobData, type BlobDriver, type BlobObject, type ByteRange } from "./types";

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

/**
 * Filesystem driver. Layout: `<root>/ab/cd/<sha256>` (+ `<sha256>.thumb.webp`).
 * Writes go to a temp file in the same directory and are atomically renamed into place.
 */
export function createFsDriver(root: string): BlobDriver {
  const dirOf = (sha256: string) => join(root, sha256.slice(0, 2), sha256.slice(2, 4));
  const pathOf = (sha256: string, key = sha256) => join(dirOf(sha256), key);

  async function writeAtomic(sha256: string, key: string, data: BlobData) {
    const dir = dirOf(sha256);
    await mkdir(dir, { recursive: true });
    const target = join(dir, key);
    const tmp = join(dir, `.${key}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await open(tmp, "wx");
    try {
      if (data instanceof Uint8Array) {
        await fh.writeFile(data);
      } else {
        const reader = data.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) await fh.write(value);
        }
      }
      await fh.close();
      await rename(tmp, target);
    } catch (err) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

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
    async has(sha256) {
      assertSha256(sha256);
      try {
        return (await stat(pathOf(sha256))).isFile();
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
  };
}
