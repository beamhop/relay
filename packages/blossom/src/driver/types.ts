/** Inclusive byte range (like HTTP `Range: bytes=start-end`). */
export interface ByteRange {
  start: number;
  end: number;
}

export interface BlobObject {
  /** Body of the requested object (or of the requested range). */
  body: ReadableStream<Uint8Array>;
  /** Total size of the stored object in bytes (not the range length). */
  size: number;
  /** Present when only a range of the object is returned. */
  range?: ByteRange;
}

export type BlobData = Uint8Array | ReadableStream<Uint8Array>;

/**
 * Storage backend for blob bytes. Keys are the sha256 of the blob; thumbnails are stored
 * next to it under `<sha256>.thumb.webp`. Metadata lives in the database, not here.
 */
export interface BlobDriver {
  readonly name: string;
  put(sha256: string, data: BlobData, type: string): Promise<void>;
  /** Returns undefined when the object does not exist. `range` must be valid for the object size. */
  get(sha256: string, range?: ByteRange): Promise<BlobObject | undefined>;
  has(sha256: string): Promise<boolean>;
  /** Deletes the blob and its thumbnail (no error when missing). */
  delete(sha256: string): Promise<void>;
  putThumbnail(sha256: string, data: Uint8Array): Promise<void>;
  getThumbnail(sha256: string): Promise<BlobObject | undefined>;
  /** When set, public GETs are redirected to this URL instead of being proxied. */
  publicUrl?(sha256: string, ext: string): string | undefined;
}

export const thumbnailKey = (sha256: string) => `${sha256}.thumb.webp`;

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function assertSha256(sha256: string): void {
  if (!SHA256_RE.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
