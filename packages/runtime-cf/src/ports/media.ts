// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional MediaProcessor backed by the Cloudflare Images binding.
 * Supports only `resize` and `thumbnail`; everything else (metadata stripping,
 * transcoding, perceptual hashes) is not available on Workers and is skipped by
 * callers that check `supports`.
 */
import type { MediaOp, MediaProcessor, MediaResult } from '@beamhop/core';
import type { ImagesBindingLike } from '../cf-types.ts';

const THUMB_SIZE = 320;

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
}

export class CfImagesMediaProcessor implements MediaProcessor {
  readonly supports: ReadonlyArray<MediaOp['op']> = ['resize', 'thumbnail'];

  constructor(private readonly images: ImagesBindingLike) {}

  async process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    const out: MediaResult[] = [];
    for (const op of ops) {
      if (op.op !== 'resize' && op.op !== 'thumbnail') {
        throw new Error(`Cloudflare Images cannot do "${op.op}"`);
      }
      if (!type.startsWith('image/')) throw new Error(`Not an image: ${type}`);
      const isThumb = op.op === 'thumbnail';
      const width = op.width ?? (isThumb ? THUMB_SIZE : undefined);
      const height = op.height ?? (isThumb ? THUMB_SIZE : undefined);
      const format = op.format ?? (isThumb ? 'image/webp' : type);
      const result = await this.images
        .input(streamOf(input))
        .transform({ width, height, fit: isThumb ? 'cover' : 'scale-down' })
        .output({ format, quality: op.quality ?? (isThumb ? 75 : 85) });
      const data = new Uint8Array(await result.response().arrayBuffer());
      out.push({ op: op.op, data, type: result.contentType() });
    }
    return out;
  }
}
