// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Image MediaProcessor backed by `sharp` (libvips). `sharp` is an OPTIONAL
 * dependency loaded by dynamic import: when it is missing `supports` is empty,
 * `available` is false and the media health check / attention card explain how
 * to install it. No `Bun.*` / `node:*` APIs are used here.
 *
 * Ops (each runs independently on the original input):
 * - strip-metadata: auto-orient from EXIF, then re-encode in the same format
 *   without EXIF/GPS/XMP/ICC metadata (sharp drops metadata unless asked to keep it).
 * - resize: fit inside width×height (never enlarge); format webp|avif|jpeg|png; quality.
 * - thumbnail: cover-crop to width×height (default 320×320), webp by default.
 * - perceptual-hash: `format: 'phash'` (default, DCT) or `'dhash'`; the result also
 *   carries the input's width/height and a BlurHash placeholder.
 */
import type { MediaOp, MediaResult } from '@beamhop/core';
import type { RoutableProcessor } from './composite.ts';
import {
  DHASH_HEIGHT,
  DHASH_WIDTH,
  PHASH_SIZE,
  blurhashEncode,
  dhashFromGray,
  phashFromGray,
} from './hash.ts';

// Minimal structural types for the parts of sharp we use (keeps sharp optional for tsc).
interface OutputInfo {
  width: number;
  height: number;
  channels: number;
  format: string;
  size: number;
}
export interface SharpInstance {
  rotate(): SharpInstance;
  flatten(o?: { background?: string }): SharpInstance;
  greyscale(): SharpInstance;
  ensureAlpha(): SharpInstance;
  resize(o: Record<string, unknown>): SharpInstance;
  raw(): SharpInstance;
  toFormat(format: string, o?: Record<string, unknown>): SharpInstance;
  metadata(): Promise<{
    format?: string;
    width?: number;
    height?: number;
    pages?: number;
    orientation?: number;
  }>;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Uint8Array; info: OutputInfo }>;
}
export type SharpFactory = (
  input?: Uint8Array | Record<string, unknown>,
  o?: Record<string, unknown>,
) => SharpInstance;

export interface SharpProcessorOptions {
  /** Load sharp (tests / custom builds). Default: dynamic `import('sharp')`. */
  load?: () => Promise<unknown>;
  /** Refuse images with more pixels than this (decompression-bomb guard). Default 100 MP. */
  maxPixels?: number;
  /** Default thumbnail edge in px. Default 320. */
  thumbnailSize?: number;
}

const OUTPUT_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tiff: 'image/tiff',
};

/** `image/webp` | `webp` → `webp`; unknown → undefined. */
export function sharpFormat(f: string | undefined): string | undefined {
  if (!f) return undefined;
  const k = f.toLowerCase().replace(/^image\//, '');
  return k in OUTPUT_FORMATS ? (k === 'jpg' ? 'jpeg' : k) : undefined;
}

const ANIMATED = new Set(['image/gif', 'image/webp']);

export class SharpMediaProcessor implements RoutableProcessor {
  readonly name = 'sharp';
  readonly supports: ReadonlyArray<MediaOp['op']>;
  private readonly maxPixels: number;
  private readonly thumbSize: number;

  constructor(
    private readonly sharp: SharpFactory | null,
    opts: SharpProcessorOptions = {},
    /** Why sharp is unavailable (shown in health technical text). */
    readonly loadError?: string,
  ) {
    this.supports = sharp ? ['strip-metadata', 'resize', 'thumbnail', 'perceptual-hash'] : [];
    this.maxPixels = opts.maxPixels ?? 100_000_000;
    this.thumbSize = opts.thumbnailSize ?? 320;
  }

  get available(): boolean {
    return this.sharp !== null;
  }

  accepts(op: MediaOp, type: string): boolean {
    if (!this.sharp || !this.supports.includes(op.op)) return false;
    return type.startsWith('image/') && type !== 'image/svg+xml';
  }

  private open(input: Uint8Array, type: string, animated = false): SharpInstance {
    if (!this.sharp) throw new Error('Image tools (sharp) are not installed');
    return this.sharp(input, {
      animated: animated && ANIMATED.has(type),
      limitInputPixels: this.maxPixels,
      failOn: 'error',
    });
  }

  async process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    const out: MediaResult[] = [];
    for (const op of ops) {
      if (!this.accepts(op, type)) throw new Error(`sharp cannot do "${op.op}" for ${type}`);
      switch (op.op) {
        case 'strip-metadata':
          out.push(await this.strip(input, type, op));
          break;
        case 'resize':
          out.push(await this.resize(input, type, op));
          break;
        case 'thumbnail':
          out.push(await this.thumbnail(input, type, op));
          break;
        case 'perceptual-hash':
          out.push(await this.hash(input, type, op));
          break;
        default:
          throw new Error(`sharp cannot do "${op.op}"`);
      }
    }
    return out;
  }

  private async encode(
    img: SharpInstance,
    op: MediaOp,
    format: string,
    quality: number | undefined,
  ): Promise<MediaResult> {
    const o: Record<string, unknown> = {};
    if (quality !== undefined && format !== 'png' && format !== 'gif') o.quality = quality;
    const { data, info } = await img.toFormat(format, o).toBuffer({ resolveWithObject: true });
    return {
      op: op.op,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      type: OUTPUT_FORMATS[format] ?? `image/${format}`,
      width: info.width,
      height: info.height,
    };
  }

  private async strip(input: Uint8Array, type: string, op: MediaOp): Promise<MediaResult> {
    const meta = await this.open(input, type).metadata();
    const format = sharpFormat(op.format) ?? sharpFormat(meta.format);
    if (!format) throw new Error(`Cannot re-encode ${meta.format ?? type} images`);
    const animated = (meta.pages ?? 1) > 1;
    let img = this.open(input, type, animated);
    // Apply EXIF orientation to the pixels before the orientation tag is dropped.
    if (!animated && meta.orientation && meta.orientation > 1) img = img.rotate();
    return this.encode(img, op, format, op.quality ?? (format === 'jpeg' ? 90 : undefined));
  }

  private async resize(input: Uint8Array, type: string, op: MediaOp): Promise<MediaResult> {
    const meta = await this.open(input, type).metadata();
    const format = sharpFormat(op.format) ?? sharpFormat(meta.format) ?? 'jpeg';
    const img = this.open(input, type).rotate().resize({
      width: op.width,
      height: op.height,
      fit: 'inside',
      withoutEnlargement: true,
    });
    return this.encode(img, op, format, op.quality ?? 80);
  }

  private async thumbnail(input: Uint8Array, type: string, op: MediaOp): Promise<MediaResult> {
    const width = op.width ?? this.thumbSize;
    const height = op.height ?? width;
    const format = sharpFormat(op.format) ?? 'webp';
    const img = this.open(input, type)
      .rotate()
      .resize({ width, height, fit: 'cover', position: 'attention', withoutEnlargement: false });
    return this.encode(img, op, format, op.quality ?? 75);
  }

  private async hash(input: Uint8Array, type: string, op: MediaOp): Promise<MediaResult> {
    const algo = (op.format ?? 'phash').toLowerCase();
    const meta = await this.open(input, type).metadata();
    const w = algo === 'dhash' ? DHASH_WIDTH : PHASH_SIZE;
    const h = algo === 'dhash' ? DHASH_HEIGHT : PHASH_SIZE;
    const gray = await this.pixels(input, type, w, h, true);
    const hash = algo === 'dhash' ? dhashFromGray(gray) : phashFromGray(gray);
    const rgba = await this.pixels(input, type, 32, 32, false);
    const swap = (meta.orientation ?? 1) >= 5;
    return {
      op: op.op,
      hash,
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      blurhash: blurhashEncode(rgba, 32, 32, 4, 4, 3),
    };
  }

  /** Raw pixels resized to exactly w×h: 1 channel when `gray`, else RGBA. */
  private async pixels(
    input: Uint8Array,
    type: string,
    w: number,
    h: number,
    gray: boolean,
  ): Promise<Uint8Array> {
    let img = this.open(input, type).rotate().flatten({ background: '#ffffff' });
    if (gray) img = img.greyscale();
    img = img.resize({ width: w, height: h, fit: 'fill', kernel: 'cubic' });
    if (!gray) img = img.ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const want = gray ? 1 : 4;
    if (info.channels === want) return data;
    // Normalise channel count (e.g. greyscale output still carrying 3 channels).
    const out = new Uint8Array(w * h * want);
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < want; c++) {
        out[i * want + c] = data[i * info.channels + Math.min(c, info.channels - 1)] ?? 255;
      }
    }
    return out;
  }
}

/**
 * Create the sharp-backed processor. Never throws: if sharp cannot be loaded the
 * processor reports `available: false` and an empty `supports`.
 */
export async function createSharpMediaProcessor(
  opts: SharpProcessorOptions = {},
): Promise<SharpMediaProcessor> {
  try {
    // Variable specifier: sharp is optional, so neither tsc nor bundlers must require it.
    const specifier = 'sharp';
    const mod = (await (opts.load ? opts.load() : import(specifier))) as
      | { default?: SharpFactory }
      | SharpFactory;
    const factory = typeof mod === 'function' ? mod : mod?.default;
    if (typeof factory !== 'function') throw new Error('sharp module has no default export');
    return new SharpMediaProcessor(factory, opts);
  } catch (err) {
    return new SharpMediaProcessor(null, opts, err instanceof Error ? err.message : String(err));
  }
}
