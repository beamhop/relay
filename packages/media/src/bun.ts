// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun-only entry (`@beamhop/media/bun`): the default composite processor for
 * `ports.media` — built-in image codecs (WebAssembly, in a worker thread) plus
 * ffmpeg for video when it is on PATH.
 */
import type { Logger } from '@beamhop/core';
import { CompositeMediaProcessor, type RoutableProcessor } from './composite.ts';
import { type FfmpegOptions, createFfmpegMediaProcessor } from './ffmpeg.ts';
import { type WorkerImageOptions, WorkerImageProcessor } from './image-pool.ts';

export {
  FfmpegMediaProcessor,
  createFfmpegMediaProcessor,
  crfFor,
  ffmpegArgs,
  type ExecResult,
  type FfmpegOptions,
} from './ffmpeg.ts';
export { createBunImageCodecs } from './bun-codecs.ts';
export {
  DEFAULT_IMAGE_WORKER_URL,
  WorkerImageProcessor,
  imageWorkerUrl,
  setImageWorkerUrl,
  type WorkerImageOptions,
} from './image-pool.ts';

export interface BunMediaOptions {
  images?: WorkerImageOptions;
  ffmpeg?: FfmpegOptions;
  logger?: Logger;
}

export interface BunMediaResult {
  processor: CompositeMediaProcessor;
  /** Built-in image tools: always present. */
  images: true;
  ffmpeg: boolean;
}

/** Build the runtime's `ports.media`: image codecs always, ffmpeg if found. Never throws. */
export async function createBunMediaProcessor(o: BunMediaOptions = {}): Promise<BunMediaResult> {
  const ffmpeg = createFfmpegMediaProcessor(o.ffmpeg);
  const parts: RoutableProcessor[] = [new WorkerImageProcessor(o.images)];
  if (ffmpeg.available) parts.push(ffmpeg);
  o.logger?.log('info', 'media tools', { images: true, ffmpeg: ffmpeg.available });
  return { processor: new CompositeMediaProcessor(parts), images: true, ffmpeg: ffmpeg.available };
}
