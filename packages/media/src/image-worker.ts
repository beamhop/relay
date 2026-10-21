// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Worker entry for image processing (Bun-only): the wasm codecs run here so a
 * large photo never stalls the relay's event loop. Messages: see image-pool.ts.
 */
import { createBunImageCodecs } from './bun-codecs.ts';
import type { ImageJob, ImageReply } from './image-pool.ts';
import { ImageMediaProcessor } from './images.ts';

declare const self: Worker;

let proc: ImageMediaProcessor | undefined;

self.onmessage = async (e: MessageEvent<ImageJob>) => {
  const job = e.data;
  proc ??= new ImageMediaProcessor(createBunImageCodecs(), job.options);
  let reply: ImageReply;
  try {
    reply = { seq: job.seq, results: await proc.process(job.input, job.type, job.ops) };
  } catch (err) {
    reply = { seq: job.seq, error: err instanceof Error ? err.message : String(err) };
  }
  const transfer = (reply.results ?? []).flatMap((r) => (r.data ? [r.data.buffer] : []));
  self.postMessage(reply, transfer as Transferable[]);
};
