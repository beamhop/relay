// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun-only entry (`@beamhop/media/bun`): ffmpeg processor and the default
 * composite processor (sharp for images + ffmpeg for video) for `ports.media`.
 */
import type { Logger } from '@beamhop/core';
import { CompositeMediaProcessor, type RoutableProcessor } from './composite.ts';
import { type FfmpegOptions, createFfmpegMediaProcessor } from './ffmpeg.ts';
import { type SharpProcessorOptions, createSharpMediaProcessor } from './sharp.ts';

export {
  FfmpegMediaProcessor,
  createFfmpegMediaProcessor,
  crfFor,
  ffmpegArgs,
  type ExecResult,
  type FfmpegOptions,
} from './ffmpeg.ts';

export interface BunMediaOptions {
  sharp?: SharpProcessorOptions;
  ffmpeg?: FfmpegOptions;
  logger?: Logger;
}

export interface BunMediaResult {
  /** Composite of the available tools, or undefined when none is installed. */
  processor?: CompositeMediaProcessor;
  sharp: boolean;
  ffmpeg: boolean;
  /** Why sharp could not be loaded. */
  sharpError?: string;
}

/** Detect sharp and ffmpeg and build the runtime's `ports.media`. Never throws. */
export async function createBunMediaProcessor(o: BunMediaOptions = {}): Promise<BunMediaResult> {
  const sharp = await createSharpMediaProcessor(o.sharp);
  const ffmpeg = createFfmpegMediaProcessor(o.ffmpeg);
  const parts: RoutableProcessor[] = [];
  if (sharp.available) parts.push(sharp);
  if (ffmpeg.available) parts.push(ffmpeg);
  o.logger?.log(parts.length ? 'info' : 'warn', 'media tools', {
    sharp: sharp.available,
    ffmpeg: ffmpeg.available,
    ...(sharp.loadError ? { sharpError: sharp.loadError } : {}),
  });
  return {
    processor: parts.length ? new CompositeMediaProcessor(parts) : undefined,
    sharp: sharp.available,
    ffmpeg: ffmpeg.available,
    sharpError: sharp.loadError,
  };
}
