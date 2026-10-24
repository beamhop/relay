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
export interface PutOptions {
  /**
   * Store out of public reach (pending/blocked blobs). Only drivers that expose objects publicly
   * (`publicUrl`) act on it; others store as usual.
   */
  hidden?: boolean;
}

/**
 * Where the caller expects the object, from the blob's status (pending/blocked = hidden). Drivers that keep
 * hidden objects elsewhere look there first and only then at the other location (objects stored before an
 * upgrade, or a move interrupted midway).
 */
export interface LocateOptions {
  hidden?: boolean;
}

export interface BlobDriver {
  readonly name: string;
  put(sha256: string, data: BlobData, type: string, opts?: PutOptions): Promise<void>;
  /** Returns undefined when the object does not exist. `range` must be valid for the object size. */
  get(sha256: string, range?: ByteRange, opts?: LocateOptions): Promise<BlobObject | undefined>;
  has(sha256: string, opts?: LocateOptions): Promise<boolean>;
  /** Deletes the blob and its thumbnail (no error when missing). */
  delete(sha256: string): Promise<void>;
  putThumbnail(sha256: string, data: Uint8Array, opts?: PutOptions): Promise<void>;
  getThumbnail(sha256: string, opts?: LocateOptions): Promise<BlobObject | undefined>;
  /** When set, public GETs are redirected to this URL instead of being proxied. */
  publicUrl?(sha256: string): string | undefined;
  /**
   * Moves an existing blob (+ its thumbnail when `hasThumbnail`) out of / back into public reach when its status
   * changes. Must be idempotent: re-running it after a partial failure finishes the move.
   */
  setHidden?(sha256: string, hidden: boolean, opts?: { hasThumbnail?: boolean }): Promise<void>;
}

export const thumbnailKey = (sha256: string) => `${sha256}.thumb.webp`;

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function assertSha256(sha256: string): void {
  if (!SHA256_RE.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
