// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * {@link ImageCodecs} backed by jSquash (Squoosh's WebAssembly codecs, Apache-2.0):
 * mozjpeg, libwebp, libavif, the Rust PNG codec and the Squoosh resizer, plus
 * omggif (MIT, pure JS) for decoding GIF.
 *
 * Runtime-agnostic: the caller supplies the compiled `WebAssembly.Module` of each
 * codec (`loadWasm`), so the same code runs from source, inside the single binary
 * (embedded files) or on Workers (wasm imports). Each codec is initialised on first
 * use; the AVIF encoder alone is ~3.5 MB of wasm.
 */
import avifDecode, { init as initAvifDec } from '@jsquash/avif/decode.js';
import avifEncode, { init as initAvifEnc } from '@jsquash/avif/encode.js';
import jpegDecode, { init as initJpegDec } from '@jsquash/jpeg/decode.js';
import jpegEncode, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import pngDecode, { init as initPngDec } from '@jsquash/png/decode.js';
import pngEncode, { init as initPngEnc } from '@jsquash/png/encode.js';
import resizeImage, { initResize } from '@jsquash/resize';
import webpDecode, { init as initWebpDec } from '@jsquash/webp/decode.js';
import webpEncode, { init as initWebpEnc } from '@jsquash/webp/encode.js';
import { GifReader } from 'omggif';
import type { ImageFormat } from './image-meta.ts';
import type { EncodeFormat, ImageCodecs, ResizeKernel, RgbaImage } from './images.ts';

/** The wasm files the codecs need (paths relative to node_modules). */
export const JSQUASH_WASM = {
  jpegDec: '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm',
  jpegEnc: '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm',
  png: '@jsquash/png/codec/pkg/squoosh_png_bg.wasm',
  webpDec: '@jsquash/webp/codec/dec/webp_dec.wasm',
  // The SIMD build: Bun, Workers and current browsers all have wasm SIMD.
  webpEnc: '@jsquash/webp/codec/enc/webp_enc_simd.wasm',
  avifDec: '@jsquash/avif/codec/dec/avif_dec.wasm',
  // Single-threaded build (jSquash picks it on Bun and Workers too).
  avifEnc: '@jsquash/avif/codec/enc/avif_enc.wasm',
  resize: '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm',
} as const;

export type JsquashWasmName = keyof typeof JSQUASH_WASM;

/** Some runtimes (Workers) have no `ImageData`; the codecs only read data/width/height. */
function imageData(img: RgbaImage): ImageData {
  const Ctor = (globalThis as { ImageData?: typeof ImageData }).ImageData;
  if (Ctor && img instanceof Ctor) return img;
  return Ctor ? new Ctor(img.data, img.width, img.height) : (img as unknown as ImageData);
}

if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  // Decoders construct ImageData for their result.
  (globalThis as Record<string, unknown>).ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
}

const buf = (b: Uint8Array): ArrayBuffer =>
  b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer
    ? b.buffer
    : (b.slice().buffer as ArrayBuffer);

function decodeGif(bytes: Uint8Array): RgbaImage {
  const r = new GifReader(bytes);
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  r.decodeAndBlitFrameRGBA(0, data);
  return { data, width: r.width, height: r.height };
}

export function createJsquashCodecs(
  loadWasm: (name: JsquashWasmName) => Promise<WebAssembly.Module>,
): ImageCodecs {
  const ready = new Map<string, Promise<unknown>>();
  const once = (key: string, init: () => Promise<unknown>) => {
    let p = ready.get(key);
    if (!p) {
      p = init();
      ready.set(key, p);
      // A failed init may be retried on the next call.
      p.catch(() => ready.delete(key));
    }
    return p;
  };
  const use = (name: JsquashWasmName, init: (m: WebAssembly.Module) => Promise<unknown>) =>
    once(name, async () => init(await loadWasm(name)));

  return {
    async decode(format: ImageFormat, bytes: Uint8Array): Promise<RgbaImage> {
      switch (format) {
        case 'jpeg':
          await use('jpegDec', (m) => initJpegDec(m));
          return jpegDecode(buf(bytes));
        case 'png':
          await use('png', (m) => initPngDec(m));
          return pngDecode(buf(bytes));
        case 'webp':
          await use('webpDec', (m) => initWebpDec(m));
          return webpDecode(buf(bytes));
        case 'avif': {
          await use('avifDec', (m) => initAvifDec(m));
          const img = await avifDecode(buf(bytes));
          if (!img) throw new Error('Could not decode AVIF image');
          return img;
        }
        case 'gif':
          return decodeGif(bytes);
      }
    },

    async encode(format: EncodeFormat, img: RgbaImage, quality?: number): Promise<Uint8Array> {
      const data = imageData(img);
      let out: ArrayBuffer;
      switch (format) {
        case 'jpeg':
          await use('jpegEnc', (m) => initJpegEnc(m));
          out = await jpegEncode(data, quality === undefined ? {} : { quality });
          break;
        case 'png':
          await use('png', (m) => initPngEnc(m));
          out = await pngEncode(data);
          break;
        case 'webp':
          await use('webpEnc', (m) => initWebpEnc(m));
          out = await webpEncode(data, quality === undefined ? {} : { quality });
          break;
        case 'avif':
          await use('avifEnc', (m) => initAvifEnc(m));
          // speed 8: a server encodes many small variants; 6 (default) is ~3× slower.
          out = await avifEncode(data, { speed: 8, ...(quality === undefined ? {} : { quality }) });
          break;
      }
      return new Uint8Array(out);
    },

    async resize(img: RgbaImage, width: number, height: number, kernel: ResizeKernel) {
      await use('resize', (m) => initResize(m));
      return resizeImage(imageData(img), {
        width,
        height,
        method: kernel,
        fitMethod: 'stretch',
        // lanczos3 (copies): alpha- and gamma-correct. catrom (hash input, opaque):
        // plain sRGB, like libvips, so hashes match lists made with sharp.
        premultiply: kernel === 'lanczos3',
        linearRGB: kernel === 'lanczos3',
      });
    },
  };
}
