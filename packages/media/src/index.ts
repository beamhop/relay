// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Media module: abuse scanning of image uploads (perceptual hashes vs. hash
 * lists, §5.3), derivative variants (thumbnail + responsive sizes, video
 * transcode + poster, §4.2) with `GET /<sha256>/variants`, health check and
 * attention cards. Processing goes through `ports.media` (built-in image codecs/ffmpeg on Bun
 * via `@beamhop/media/bun`, Cloudflare Images on Workers).
 *
 * Runtime-agnostic entry: Bun-only processors live in `@beamhop/media/bun`.
 */
import { type BeamhopModule, defineModule } from '@beamhop/core';
import { mediaCards, mediaHealthCheck, registerActions } from './admin.ts';
import { MediaConfigSchema } from './config.ts';
import { registerRoutes } from './routes.ts';
import { type MediaOptions, MediaService } from './service.ts';

export const MEDIA_LISTS_JOB = 'media.lists';

export function createMediaModule(opts: MediaOptions = {}): BeamhopModule {
  let svc: MediaService | undefined;
  const offs: Array<() => void> = [];
  return defineModule({
    id: 'media',
    dependsOn: ['blossom'],
    configSchema: MediaConfigSchema,
    register(kernel) {
      const s = new MediaService(kernel, opts);
      svc = s;
      kernel.provide('media', s);
      offs.push(kernel.bus.on('blob.uploaded', (e) => s.onUploaded(e)));
      offs.push(kernel.bus.on('blob.deleted', (e) => s.onDeleted(e)));
      offs.push(kernel.policy.add(s.serveHook()));
      offs.push(
        kernel.onConfigChange(() => {
          s.reconfigure();
          void s.refreshLists().catch(() => {});
        }),
      );
      registerRoutes(kernel, s);
      registerActions(kernel, s);
      kernel.health.push(mediaHealthCheck(kernel, s));
      kernel.cards.push(mediaCards(kernel, s));
    },
    start(kernel) {
      const s = svc;
      if (!s) return;
      const background = async () => {
        try {
          await s.refreshLists();
          await s.sweepPending();
        } catch (err) {
          kernel.bus.emit('error', { source: MEDIA_LISTS_JOB, message: String(err) });
        }
      };
      kernel.ports.scheduler.every(MEDIA_LISTS_JOB, s.config().listRefreshMinutes * 60, background);
      void background();
    },
    stop(kernel) {
      kernel.ports.scheduler.cancel(MEDIA_LISTS_JOB);
      svc?.queue.close();
      for (const off of offs.splice(0)) off();
    },
  });
}

/** Default media module (lists loaded with global fetch / local files). */
export const mediaModule: BeamhopModule = createMediaModule();

export { MediaConfigSchema, type MediaConfig } from './config.ts';
export {
  CompositeMediaProcessor,
  canHandle,
  processorAccepts,
  processorNames,
  type RoutableProcessor,
} from './composite.ts';
export {
  IMAGE_OPS,
  ImageMediaProcessor,
  busiestWindow,
  cropTo,
  encodeFormat,
  flatten,
  grey,
  orient,
  type EncodeFormat,
  type ImageCodecs,
  type ImageProcessorOptions,
  type Rect,
  type ResizeKernel,
  type RgbaImage,
} from './images.ts';
export {
  exifOrientation,
  imageFormat,
  imageInfo,
  mimeOf,
  sniffImage,
  stripContainerMetadata,
  type ImageFormat,
  type ImageInfo,
} from './image-meta.ts';
export { JSQUASH_WASM, createJsquashCodecs, type JsquashWasmName } from './jsquash.ts';
export {
  blurhashEncode,
  dhashFromGray,
  hammingHex,
  hashWords,
  phashFromGray,
  popcount32,
} from './hash.ts';
export {
  HashListCache,
  loadListText,
  matchHashes,
  parseHashList,
  type HashAlgo,
  type HashEntry,
  type HashList,
  type ListMatch,
} from './lists.ts';
export { WorkQueue, type QueueStats, type WorkQueueOptions } from './queue.ts';
export { extForType, variantsView, type VariantsResponse } from './routes.ts';
export {
  HASHES,
  MATCHES,
  MATCH_REASON,
  MediaService,
  PENDING,
  SCAN_HOOK_ID,
  VARIANTS,
  VARIANT_OF,
  VARIANT_OWNER,
  mediaKind,
  scanGated,
  type HashRecord,
  type MatchRecord,
  type MediaOptions,
  type VariantInfo,
  type VariantRecord,
  type VariantRole,
} from './service.ts';
