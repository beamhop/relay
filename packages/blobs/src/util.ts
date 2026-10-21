// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared helpers for BlobStore adapters (Web-standard APIs only). */

export const DEFAULT_TYPE = 'application/octet-stream';

const SHA256 = /^[0-9a-f]{64}$/;

export function assertSha256(sha256: string): void {
  if (!SHA256.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
}

export function isSha256(s: string): boolean {
  return SHA256.test(s);
}

export function concatBytes(chunks: Uint8Array[], total?: number): Uint8Array {
  const n = total ?? chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (bytes.length) c.enqueue(bytes);
      c.close();
    },
  });
}

export function toStream(
  data: Uint8Array | ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return data instanceof Uint8Array ? bytesStream(data) : data;
}

/**
 * Read a stream in fixed-size chunks (the last chunk may be shorter).
 * Used for multipart uploads where every part except the last has a minimum size.
 */
export async function* chunked(
  stream: ReadableStream<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buf: Uint8Array[] = [];
  let buffered = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let v = value;
      while (buffered + v.length >= size) {
        const take = size - buffered;
        buf.push(v.subarray(0, take));
        yield concatBytes(buf, size);
        buf = [];
        buffered = 0;
        v = v.subarray(take);
      }
      if (v.length) {
        buf.push(v);
        buffered += v.length;
      }
    }
    if (buffered > 0) yield concatBytes(buf, buffered);
  } finally {
    reader.releaseLock();
  }
}
