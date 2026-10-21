// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Video MediaProcessor that shells out to a system `ffmpeg` (Bun only: uses
 * `Bun.spawn` / `Bun.which` and temp files). If ffmpeg is not on PATH the
 * processor reports `available: false` and an empty `supports`.
 *
 * Ops (video/* inputs only):
 * - transcode: H.264 (libx264, yuv420p) + AAC in MP4 with `+faststart`, scaled to
 *   fit `width` (default 1280, never enlarged); `quality` 0..100 maps to CRF 35..18.
 * - thumbnail: a JPEG poster frame from the first second, `width` px wide (default 640).
 * - strip-metadata: stream-copy remux without container metadata.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaOp, MediaResult } from '@beamhop/core';
import type { RoutableProcessor } from './composite.ts';

export interface ExecResult {
  exitCode: number;
  stderr: string;
}

export interface FfmpegOptions {
  /** ffmpeg binary path. Default: `Bun.which('ffmpeg')`. `null` forces "not installed". */
  path?: string | null;
  /** Per-job timeout. Default 10 minutes. */
  timeoutMs?: number;
  /** Where temp files go. Default OS temp dir. */
  tmpDir?: string;
  /** Command runner (tests). Default `Bun.spawn`. */
  exec?: (argv: string[], timeoutMs: number) => Promise<ExecResult>;
}

const CONTAINER_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpg',
  'video/ogg': 'ogv',
};

async function bunExec(argv: string[], timeoutMs: number): Promise<ExecResult> {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** `scale` filter that fits `w` px wide, never enlarges, keeps even dimensions (x264 needs them). */
const scaleFilter = (w: number) => `scale='trunc(min(${w},iw)/2)*2':-2`;

/** quality 0..100 → x264 CRF 35..18 (lower CRF = better). */
export function crfFor(quality: number | undefined): number {
  if (quality === undefined) return 23;
  const q = Math.max(0, Math.min(100, quality));
  return Math.round(35 - (q / 100) * 17);
}

/** ffmpeg arguments (after the binary) for one op. Exported for tests. */
export function ffmpegArgs(op: MediaOp, inPath: string, outPath: string): string[] {
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  switch (op.op) {
    case 'transcode':
      return [
        ...base,
        '-i',
        inPath,
        '-map_metadata',
        '-1',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(crfFor(op.quality)),
        '-pix_fmt',
        'yuv420p',
        '-vf',
        scaleFilter(op.width ?? 1280),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outPath,
      ];
    case 'thumbnail':
      return [
        ...base,
        '-ss',
        '1',
        '-i',
        inPath,
        '-frames:v',
        '1',
        '-vf',
        scaleFilter(op.width ?? 640),
        '-q:v',
        '4',
        outPath,
      ];
    case 'strip-metadata':
      return [...base, '-i', inPath, '-map', '0', '-map_metadata', '-1', '-c', 'copy', outPath];
    default:
      throw new Error(`ffmpeg cannot do "${op.op}"`);
  }
}

export class FfmpegMediaProcessor implements RoutableProcessor {
  readonly name = 'ffmpeg';
  readonly supports: ReadonlyArray<MediaOp['op']>;
  private readonly exec: (argv: string[], timeoutMs: number) => Promise<ExecResult>;

  constructor(
    readonly binary: string | null,
    private readonly opts: FfmpegOptions = {},
  ) {
    this.supports = binary ? ['transcode', 'thumbnail', 'strip-metadata'] : [];
    this.exec = opts.exec ?? bunExec;
  }

  get available(): boolean {
    return this.binary !== null;
  }

  accepts(op: MediaOp, type: string): boolean {
    if (!this.binary || !this.supports.includes(op.op) || !type.startsWith('video/')) return false;
    return op.op !== 'strip-metadata' || type in CONTAINER_EXT;
  }

  async process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    if (!this.binary) throw new Error('ffmpeg is not installed');
    const dir = await mkdtemp(join(this.opts.tmpDir ?? tmpdir(), 'beamhop-ffmpeg-'));
    try {
      const inPath = join(dir, `in.${CONTAINER_EXT[type] ?? 'bin'}`);
      await writeFile(inPath, input);
      const out: MediaResult[] = [];
      for (const [i, op] of ops.entries()) {
        if (!this.accepts(op, type)) throw new Error(`ffmpeg cannot do "${op.op}" for ${type}`);
        const outType =
          op.op === 'transcode' ? 'video/mp4' : op.op === 'thumbnail' ? 'image/jpeg' : type;
        const ext = outType === 'image/jpeg' ? 'jpg' : (CONTAINER_EXT[outType] ?? 'bin');
        const outPath = join(dir, `out-${i}.${ext}`);
        const r = await this.exec(
          [this.binary, ...ffmpegArgs(op, inPath, outPath)],
          this.opts.timeoutMs ?? 600_000,
        );
        if (r.exitCode !== 0) {
          throw new Error(`ffmpeg ${op.op} failed (${r.exitCode}): ${r.stderr.slice(-500)}`);
        }
        out.push({ op: op.op, data: new Uint8Array(await readFile(outPath)), type: outType });
      }
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Detect ffmpeg on PATH (never throws). */
export function createFfmpegMediaProcessor(opts: FfmpegOptions = {}): FfmpegMediaProcessor {
  let bin: string | null = null;
  if (opts.path !== undefined) bin = opts.path;
  else {
    try {
      bin = Bun.which('ffmpeg');
    } catch {
      bin = null;
    }
  }
  return new FfmpegMediaProcessor(bin, opts);
}
