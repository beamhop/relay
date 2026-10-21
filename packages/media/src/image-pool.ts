// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Image processing in a Worker thread (Bun-only). The wasm codecs are
 * synchronous: encoding a 12 MP photo takes about a second, which on the main
 * thread would freeze every relay connection. One worker, spawned lazily, runs
 * jobs one at a time (the media queue already bounds concurrency).
 *
 * A worker that errors, exits or does not answer within `timeoutMs` is
 * terminated; its jobs fail and the next job starts a fresh worker.
 */
import type { MediaOp, MediaResult } from '@beamhop/core';
import type { RoutableProcessor } from './composite.ts';
import { IMAGE_OPS, ImageMediaProcessor, type ImageProcessorOptions } from './images.ts';

export interface ImageJob {
  seq: number;
  input: Uint8Array;
  type: string;
  ops: MediaOp[];
  options: ImageProcessorOptions;
}
export interface ImageReply {
  seq: number;
  results?: MediaResult[];
  error?: string;
}

/** Worker script next to this file when run from source; the compiled binary overrides it. */
export const DEFAULT_IMAGE_WORKER_URL = new URL('./image-worker.ts', import.meta.url).href;
let workerUrl = DEFAULT_IMAGE_WORKER_URL;

/** The single binary embeds `image-worker.ts` as an extra entrypoint and sets its path here. */
export function setImageWorkerUrl(url: string): void {
  workerUrl = url;
}
export function imageWorkerUrl(): string {
  return workerUrl;
}

export interface WorkerImageOptions extends ImageProcessorOptions {
  /** Worker script (default {@link imageWorkerUrl}). */
  url?: string;
  /** A job not answered in this time counts as a crash (default 120 s). */
  timeoutMs?: number;
}

interface Pending {
  resolve: (r: MediaResult[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerImageProcessor implements RoutableProcessor {
  readonly name = 'image-codecs';
  readonly supports = IMAGE_OPS;
  /** Same routing rules as the in-thread processor (no codecs needed for `accepts`). */
  private readonly rules = new ImageMediaProcessor(
    {
      decode: () => Promise.reject(new Error('unused')),
      encode: () => Promise.reject(new Error('unused')),
      resize: () => Promise.reject(new Error('unused')),
    },
    {},
  );
  private worker: Worker | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: WorkerImageOptions = {}) {}

  accepts(op: MediaOp, type: string): boolean {
    return this.rules.accepts(op, type);
  }

  /** Jobs run one at a time, in order. */
  process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    const run = this.chain.then(() => this.send(input, type, ops));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private spawn(): Worker {
    const w = new Worker(this.opts.url ?? workerUrl);
    w.onmessage = (e: MessageEvent<ImageReply>) => {
      const p = this.pending.get(e.data.seq);
      if (!p) return;
      this.pending.delete(e.data.seq);
      clearTimeout(p.timer);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve(e.data.results ?? []);
    };
    // Events of a worker already replaced must not touch its successor.
    w.onerror = (e) => {
      if (this.worker === w) this.crash(new Error(`Image worker failed: ${e.message}`));
    };
    w.addEventListener('close', () => {
      if (this.worker === w) this.crash(new Error('Image worker exited'));
    });
    // Never keep the process alive just for an idle worker.
    (w as Worker & { unref?: () => void }).unref?.();
    return w;
  }

  private crash(err: Error): void {
    const w = this.worker;
    this.worker = undefined;
    w?.terminate();
    for (const [seq, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(seq);
    }
  }

  private send(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    this.worker ??= this.spawn();
    const seq = ++this.seq;
    const { url: _u, timeoutMs = 120_000, ...options } = this.opts;
    return new Promise<MediaResult[]>((resolve, reject) => {
      const timer = setTimeout(
        () => this.crash(new Error(`Image processing took longer than ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.pending.set(seq, { resolve, reject, timer });
      // Copy: the caller keeps its input (it is stored as the original).
      const job: ImageJob = { seq, input: input.slice(), type, ops, options };
      this.worker?.postMessage(job, [job.input.buffer as ArrayBuffer]);
    });
  }

  /** Stop the worker (pending jobs fail). */
  close(): void {
    this.crash(new Error('Image worker stopped'));
  }
}
