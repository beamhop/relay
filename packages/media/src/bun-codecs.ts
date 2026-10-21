// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun-only: the jSquash wasm files as embedded file imports. From source they
 * resolve to node_modules paths; in the single binary `bun build --compile`
 * embeds them and the imports resolve to `$bunfs/…` paths.
 */
import avifDec from '@jsquash/avif/codec/dec/avif_dec.wasm' with { type: 'file' };
import avifEnc from '@jsquash/avif/codec/enc/avif_enc.wasm' with { type: 'file' };
import jpegDec from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm' with { type: 'file' };
import jpegEnc from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm' with { type: 'file' };
// wasm-bindgen ships `.wasm.d.ts` typings for these two, which hide the file-import default.
// @ts-expect-error file import: the default export is the path
import png from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm' with { type: 'file' };
// @ts-expect-error file import: the default export is the path
import resize from '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm' with { type: 'file' };
import webpDec from '@jsquash/webp/codec/dec/webp_dec.wasm' with { type: 'file' };
import webpEnc from '@jsquash/webp/codec/enc/webp_enc_simd.wasm' with { type: 'file' };
import type { ImageCodecs } from './images.ts';
import { type JsquashWasmName, createJsquashCodecs } from './jsquash.ts';

const FILES: Record<JsquashWasmName, string> = {
  jpegDec,
  jpegEnc,
  png: png as string,
  webpDec,
  webpEnc,
  avifDec,
  avifEnc,
  resize: resize as string,
};

export function createBunImageCodecs(): ImageCodecs {
  return createJsquashCodecs(async (name) =>
    WebAssembly.compile(await Bun.file(FILES[name]).arrayBuffer()),
  );
}
