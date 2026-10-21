// SPDX-License-Identifier: AGPL-3.0-or-later
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const PUBKEY_RE = /^[0-9a-f]{64}$/;
export const DEFAULT_TYPE = 'application/octet-stream';

/** An HTTP-mappable failure. `reason` is plain language and goes into `X-Reason`. */
export class BlossomError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
};
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]),
);
TYPE_BY_EXT.jpeg = 'image/jpeg';

export function extFor(type: string): string {
  const e = EXT_BY_TYPE[type];
  return e ? `.${e}` : '';
}

export function typeForExt(ext: string): string | undefined {
  return TYPE_BY_EXT[ext.toLowerCase()];
}

/** `image/png; charset=x` → `image/png`; empty → undefined. */
export function cleanType(t: string | null | undefined): string | undefined {
  const v = t?.split(';')[0]?.trim().toLowerCase();
  return v ? v : undefined;
}

/** Match `image/png` against patterns like `image/*`, `*`, `video/mp4`. */
export function typeAllowed(type: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat === '*' || pat === '*/*') return true;
    if (pat.endsWith('/*')) return type.startsWith(pat.slice(0, -1));
    return pat === type;
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/**
 * Hash and count bytes while they stream through. Errors the stream when the
 * byte limit is exceeded, or (at end of stream) when the hash or size does not
 * match what the client declared — so a BlobStore never commits bad bytes.
 */
export function hashingStream(opts: {
  limit: number;
  limitReason: string;
  expectedSha?: string;
  expectedSize?: number;
  /** Error for a hash mismatch (default 409). */
  mismatch?: BlossomError;
}): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  result: () => { sha256: string; size: number } | undefined;
  error: () => BlossomError | undefined;
} {
  const h = sha256.create();
  let size = 0;
  let out: { sha256: string; size: number } | undefined;
  let failure: BlossomError | undefined;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length;
      if (size > opts.limit) {
        failure = new BlossomError(413, opts.limitReason);
        controller.error(failure);
        return;
      }
      h.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      const hex = bytesToHex(h.digest());
      if (opts.expectedSha && hex !== opts.expectedSha) {
        failure = opts.mismatch ?? hashMismatch();
        throw failure;
      }
      if (opts.expectedSize !== undefined && size !== opts.expectedSize) {
        failure = new BlossomError(400, 'File size does not match Content-Length');
        throw failure;
      }
      out = { sha256: hex, size };
    },
  });
  return { stream, result: () => out, error: () => failure };
}

export const hashMismatch = () =>
  new BlossomError(409, 'File contents do not match the declared hash');
export const xTagMismatch = () =>
  new BlossomError(403, 'Auth does not cover this file (x tag mismatch)');

/** Buffer a stream up to `limit` bytes. */
export async function readLimited(
  body: ReadableStream<Uint8Array>,
  limit: number,
  limitReason: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel().catch(() => {});
      throw new BlossomError(413, limitReason);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Refuse obviously internal mirror targets (SSRF guard; DNS-level checks are the runtime's job). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.endsWith('.internal') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':')) {
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  }
  return false;
}
