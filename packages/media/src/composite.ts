// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Composite MediaProcessor: routes each op to the first component that can
 * handle it for the given content type (e.g. images → image codecs, video → ffmpeg).
 * Runtime-agnostic.
 */
import type { MediaOp, MediaProcessor, MediaResult } from '@beamhop/core';

/** A MediaProcessor that may also say which content types it handles. */
export interface RoutableProcessor extends MediaProcessor {
  /** Short name for health/technical text, e.g. `image-codecs`, `ffmpeg`. */
  readonly name?: string;
  /** Whether this processor can run `op` on content of `type`. Default: `supports` includes op. */
  accepts?(op: MediaOp, type: string): boolean;
}

export function canHandle(p: RoutableProcessor, op: MediaOp, type: string): boolean {
  if (!p.supports.includes(op.op)) return false;
  return p.accepts ? p.accepts(op, type) : true;
}

/** Names of the tools behind a processor (for health / attention text). */
export function processorNames(p: MediaProcessor | undefined): string[] {
  if (!p) return [];
  if (p instanceof CompositeMediaProcessor) return p.processors.flatMap(processorNames);
  const name = (p as RoutableProcessor).name;
  return [name ?? 'custom'];
}

/** Whether `p` can run `op` on content of `type` (composite-aware). */
export function processorAccepts(
  p: MediaProcessor | undefined,
  op: MediaOp,
  type: string,
): boolean {
  if (!p) return false;
  return canHandle(p as RoutableProcessor, op, type);
}

export class CompositeMediaProcessor implements RoutableProcessor {
  readonly name = 'composite';
  constructor(readonly processors: RoutableProcessor[]) {}

  get supports(): ReadonlyArray<MediaOp['op']> {
    return [...new Set(this.processors.flatMap((p) => p.supports))];
  }

  accepts(op: MediaOp, type: string): boolean {
    return this.processors.some((p) => canHandle(p, op, type));
  }

  /** Each op runs independently on `input`; results are returned in op order. */
  async process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    const out: MediaResult[] = [];
    for (const op of ops) {
      const p = this.processors.find((c) => canHandle(c, op, type));
      if (!p) throw new Error(`No media tool can do "${op.op}" for ${type}`);
      out.push(...(await p.process(input, type, [op])));
    }
    return out;
  }
}
