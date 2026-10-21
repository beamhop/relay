// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Image MediaProcessor over injected codecs (WebAssembly in practice, see
 * jsquash.ts). Runtime-agnostic: no `Bun.*` / `node:*`; pixel work (orientation,
 * crop, flatten, grey) is plain JS on RGBA buffers.
 *
 * Ops (each runs independently on the original input):
 * - strip-metadata: drops EXIF/GPS/XMP/ICC/comments. Lossless (container
 *   segments only) unless the pixels must change: an EXIF rotation to apply, a
 *   requested output format, or AVIF input; then decode → orient → re-encode.
 *   Animated GIF/WebP/APNG keep their animation.
 * - resize: fit inside width×height (never enlarge); format webp|avif|jpeg|png; quality.
 * - thumbnail: cover-crop to width×height (default 320×320) around the busiest
 *   region, webp by default.
 * - perceptual-hash: `format: 'phash'` (default, DCT) or `'dhash'`; the result also
 *   carries the oriented width/height and a BlurHash placeholder.
 *
 * The decompression-bomb guard reads the pixel size from the headers before any
 * decoder runs. Animated images are processed from their first frame.
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
import {
  type ImageFormat,
  type ImageInfo,
  imageFormat,
  imageInfo,
  mimeOf,
  stripContainerMetadata,
} from './image-meta.ts';

export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Formats the codecs can write. */
export type EncodeFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type ResizeKernel = 'lanczos3' | 'catrom';

export interface ImageCodecs {
  /** First frame as RGBA. */
  decode(format: ImageFormat, bytes: Uint8Array): Promise<RgbaImage>;
  encode(format: EncodeFormat, img: RgbaImage, quality?: number): Promise<Uint8Array>;
  resize(img: RgbaImage, width: number, height: number, kernel: ResizeKernel): Promise<RgbaImage>;
}

export interface ImageProcessorOptions {
  /** Refuse images with more pixels than this (decompression-bomb guard). Default 100 MP. */
  maxPixels?: number;
  /** Default thumbnail edge in px. Default 320. */
  thumbnailSize?: number;
}

const ENCODABLE = new Set<string>(['jpeg', 'png', 'webp', 'avif']);

/** Output format for a request/input format: `image/webp` → `webp`; GIF → PNG; unknown → undefined. */
export function encodeFormat(f: string | undefined): EncodeFormat | undefined {
  const k = imageFormat(f);
  if (!k) return undefined;
  return ENCODABLE.has(k) ? (k as EncodeFormat) : 'png';
}

/** Supported op names (for `supports`). */
export const IMAGE_OPS: ReadonlyArray<MediaOp['op']> = [
  'strip-metadata',
  'resize',
  'thumbnail',
  'perceptual-hash',
];

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

export class ImageMediaProcessor implements RoutableProcessor {
  readonly name: string;
  readonly supports = IMAGE_OPS;
  private readonly maxPixels: number;
  private readonly thumbSize: number;

  constructor(
    private readonly codecs: ImageCodecs,
    opts: ImageProcessorOptions & { name?: string } = {},
  ) {
    this.name = opts.name ?? 'image-codecs';
    this.maxPixels = opts.maxPixels ?? 100_000_000;
    this.thumbSize = opts.thumbnailSize ?? 320;
  }

  accepts(op: MediaOp, type: string): boolean {
    return this.supports.includes(op.op) && ACCEPTED.has(type.toLowerCase());
  }

  async process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    const info = imageInfo(input);
    if (!info) throw new Error(`Not a supported image (declared ${type})`);
    if (info.width * info.height > this.maxPixels) {
      throw new Error(
        `Image is too large: ${info.width}×${info.height} exceeds ${this.maxPixels} pixels`,
      );
    }
    const out: MediaResult[] = [];
    // Decoded (oriented) pixels are shared by the ops of one call.
    let decoded: Promise<RgbaImage> | undefined;
    const pixels = () => {
      decoded ??= this.codecs
        .decode(info.format, input)
        .then((img) => orient(img, info.orientation));
      return decoded;
    };
    for (const op of ops) {
      if (!this.accepts(op, type)) throw new Error(`Image tools cannot do "${op.op}" for ${type}`);
      switch (op.op) {
        case 'strip-metadata':
          out.push(await this.strip(input, info, op, pixels));
          break;
        case 'resize':
          out.push(await this.resize(info, op, await pixels()));
          break;
        case 'thumbnail':
          out.push(await this.thumbnail(op, await pixels()));
          break;
        case 'perceptual-hash':
          out.push(await this.hash(op, await pixels()));
          break;
        default:
          throw new Error(`Image tools cannot do "${op.op}"`);
      }
    }
    return out;
  }

  private async encode(
    op: MediaOp,
    img: RgbaImage,
    format: EncodeFormat,
    quality: number | undefined,
  ): Promise<MediaResult> {
    const src = format === 'jpeg' ? flatten(img) : img;
    const data = await this.codecs.encode(format, src, format === 'png' ? undefined : quality);
    return { op: op.op, data, type: mimeOf(format), width: img.width, height: img.height };
  }

  private async strip(
    input: Uint8Array,
    info: ImageInfo,
    op: MediaOp,
    pixels: () => Promise<RgbaImage>,
  ): Promise<MediaResult> {
    const wanted = encodeFormat(op.format);
    const lossless =
      info.format !== 'avif' &&
      (info.animated || info.orientation === 1) &&
      (!wanted || wanted === info.format);
    if (lossless) {
      const swap = info.orientation >= 5;
      return {
        op: op.op,
        data: stripContainerMetadata(input, info.format),
        type: mimeOf(info.format),
        width: swap ? info.height : info.width,
        height: swap ? info.width : info.height,
      };
    }
    const format = wanted ?? encodeFormat(info.format) ?? 'png';
    return this.encode(op, await pixels(), format, op.quality ?? (format === 'jpeg' ? 90 : 80));
  }

  private async resize(info: ImageInfo, op: MediaOp, img: RgbaImage): Promise<MediaResult> {
    const format = encodeFormat(op.format) ?? encodeFormat(info.format) ?? 'jpeg';
    const scale = Math.min(
      1,
      op.width ? op.width / img.width : 1,
      op.height ? op.height / img.height : 1,
    );
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const out = scale < 1 ? await this.codecs.resize(img, w, h, 'lanczos3') : img;
    return this.encode(op, out, format, op.quality ?? 80);
  }

  private async thumbnail(op: MediaOp, img: RgbaImage): Promise<MediaResult> {
    const width = op.width ?? this.thumbSize;
    const height = op.height ?? width;
    const format = encodeFormat(op.format) ?? 'webp';
    const crop = cropTo(img, busiestWindow(img, width / height));
    const out = await this.codecs.resize(crop, width, height, 'lanczos3');
    return this.encode(op, out, format, op.quality ?? 75);
  }

  private async hash(op: MediaOp, img: RgbaImage): Promise<MediaResult> {
    const algo = (op.format ?? 'phash').toLowerCase();
    const w = algo === 'dhash' ? DHASH_WIDTH : PHASH_SIZE;
    const h = algo === 'dhash' ? DHASH_HEIGHT : PHASH_SIZE;
    const flat = flatten(img);
    // Grey before resizing, like libvips: the hashes then match lists made with sharp.
    const small = firstChannel(await this.codecs.resize(greyImage(flat), w, h, 'catrom'));
    const hash = algo === 'dhash' ? dhashFromGray(small) : phashFromGray(small);
    const tiny = await this.codecs.resize(flat, 32, 32, 'catrom');
    return {
      op: op.op,
      hash,
      width: img.width,
      height: img.height,
      blurhash: blurhashEncode(
        new Uint8Array(tiny.data.buffer, tiny.data.byteOffset, tiny.data.length),
        32,
        32,
        4,
        4,
        3,
      ),
    };
  }
}

// ---------------------------------------------------------------- pixel helpers

/** Apply EXIF orientation 1..8 to RGBA pixels. */
export function orient(img: RgbaImage, orientation: number): RgbaImage {
  if (orientation <= 1 || orientation > 8) return img;
  const { width: w, height: h, data } = img;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const aligned = data.byteOffset % 4 === 0 ? data : data.slice();
  const src = new Uint32Array(aligned.buffer, aligned.byteOffset, w * h);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2:
          dx = w - 1 - x;
          dy = y;
          break;
        case 3:
          dx = w - 1 - x;
          dy = h - 1 - y;
          break;
        case 4:
          dx = x;
          dy = h - 1 - y;
          break;
        case 5:
          dx = y;
          dy = x;
          break;
        case 6:
          dx = h - 1 - y;
          dy = x;
          break;
        case 7:
          dx = h - 1 - y;
          dy = w - 1 - x;
          break;
        default:
          dx = y;
          dy = w - 1 - x;
      }
      dst[dy * ow + dx] = src[y * w + x] ?? 0;
    }
  }
  return { data: out, width: ow, height: oh };
}

/** Composite on white (opaque output). */
export function flatten(img: RgbaImage): RgbaImage {
  const d = img.data;
  let opaque = true;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) return img;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = (d[i + 3] ?? 255) / 255;
    out[i] = (d[i] ?? 0) * a + 255 * (1 - a);
    out[i + 1] = (d[i + 1] ?? 0) * a + 255 * (1 - a);
    out[i + 2] = (d[i + 2] ?? 0) * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

/** sRGB byte → linear light, and back (table + inverse). */
const TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (y: number) => 255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055);

/** Luma as libvips' `b-w` computes it: Rec. 709 weights in linear light, sRGB-encoded. */
export function grey(img: RgbaImage): Uint8Array {
  const d = img.data;
  const out = new Uint8Array(img.width * img.height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const y =
      0.2126 * (TO_LINEAR[d[i] ?? 0] ?? 0) +
      0.7152 * (TO_LINEAR[d[i + 1] ?? 0] ?? 0) +
      0.0722 * (TO_LINEAR[d[i + 2] ?? 0] ?? 0);
    out[p] = Math.round(toSrgb(y));
  }
  return out;
}

/** {@link grey} as an opaque RGBA image (r = g = b = luma), for the RGBA resizer. */
function greyImage(img: RgbaImage): RgbaImage {
  const g = grey(img);
  const data = new Uint8ClampedArray(g.length * 4);
  for (let p = 0; p < g.length; p++) data.set([g[p] ?? 0, g[p] ?? 0, g[p] ?? 0, 255], p * 4);
  return { data, width: img.width, height: img.height };
}

function firstChannel(img: RgbaImage): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  for (let p = 0; p < out.length; p++) out[p] = img.data[p * 4] ?? 0;
  return out;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Largest window of `aspect` (w/h) inside the image, slid along the long axis to the
 * position with the most detail (edges + saturation), sampled on a coarse grid.
 */
export function busiestWindow(img: RgbaImage, aspect: number): Rect {
  const { width: W, height: H, data } = img;
  const cw = Math.min(W, Math.round(H * aspect));
  const ch = Math.min(H, Math.round(W / aspect));
  if (cw === W && ch === H) return { x: 0, y: 0, width: W, height: H };
  const horizontal = cw < W;
  const span = horizontal ? W - cw : H - ch;
  // Detail per column (or row) on a ≤64-sample grid.
  const N = 64;
  const along = horizontal ? W : H;
  const across = horizontal ? H : W;
  const bins = Math.min(N, along);
  const score = new Float64Array(bins);
  const lum = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
  };
  const sat = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  const steps = Math.min(N, across);
  for (let k = 0; k < bins; k++) {
    const a = Math.min(along - 2, Math.floor(((k + 0.5) * along) / bins));
    for (let s = 0; s < steps; s++) {
      const c = Math.min(across - 2, Math.floor(((s + 0.5) * across) / steps));
      const [x, y] = horizontal ? [a, c] : [c, a];
      const edge = Math.abs(lum(x + 1, y) - lum(x, y)) + Math.abs(lum(x, y + 1) - lum(x, y));
      score[k] = (score[k] ?? 0) + edge + 0.5 * sat(x, y);
    }
  }
  const winBins = Math.max(1, Math.round(((horizontal ? cw : ch) / along) * bins));
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  // 11 positions in tenths of the free span, centre first: a move needs 5% more detail.
  for (const t of [5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]) {
    const pos = Math.round((span * t) / 10);
    const start = Math.floor((pos / along) * bins);
    let sum = 0;
    for (let k = start; k < Math.min(bins, start + winBins); k++) sum += score[k] ?? 0;
    if (bestScore === Number.NEGATIVE_INFINITY || sum > bestScore * 1.05) {
      bestScore = sum;
      best = pos;
    }
  }
  return horizontal
    ? { x: best, y: 0, width: cw, height: H }
    : { x: 0, y: best, width: W, height: ch };
}

export function cropTo(img: RgbaImage, r: Rect): RgbaImage {
  if (r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height) return img;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const s = ((r.y + y) * img.width + r.x) * 4;
    out.set(img.data.subarray(s, s + r.width * 4), y * r.width * 4);
  }
  return { data: out, width: r.width, height: r.height };
}
