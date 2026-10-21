// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import type { MediaOp, MediaProcessor } from '@beamhop/core';
import {
  createBunMediaProcessor,
  createFfmpegMediaProcessor,
  crfFor,
  ffmpegArgs,
} from '../src/bun.ts';
import { CompositeMediaProcessor, processorNames } from '../src/composite.ts';
import { createSharpMediaProcessor, sharpFormat } from '../src/sharp.ts';
import { loadSharp, sharpProcessor, syntheticImage } from './helpers.ts';

/** JPEG with EXIF (incl. GPS-like fields) and orientation 6 (rotate 90°). */
async function jpegWithExif(): Promise<Uint8Array> {
  const sharp = (await loadSharp()) as unknown as (
    input: Uint8Array,
    o?: Record<string, unknown>,
  ) => {
    jpeg(): {
      withMetadata(o: Record<string, unknown>): {
        toBuffer(): Promise<Uint8Array>;
      };
    };
  };
  const { syntheticPixels } = await import('./helpers.ts');
  return sharp(syntheticPixels(3, 200, 100), { raw: { width: 200, height: 100, channels: 3 } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: 'SecretCam', Copyright: 'someone' }, IFD3: { GPSLatitudeRef: 'N' } },
    })
    .toBuffer();
}

const ascii = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('SharpMediaProcessor', async () => {
  const sharp = await loadSharp();
  const proc = await sharpProcessor();

  test('missing sharp → empty supports, never throws', async () => {
    const p = await createSharpMediaProcessor({
      load: async () => {
        throw new Error('Cannot find package sharp');
      },
    });
    expect(p.available).toBe(false);
    expect(p.supports).toEqual([]);
    expect(p.loadError).toContain('sharp');
    expect(p.accepts({ op: 'resize' }, 'image/png')).toBe(false);
    await expect(p.process(new Uint8Array(1), 'image/png', [{ op: 'resize' }])).rejects.toThrow();
  });

  test('format names', () => {
    expect(sharpFormat('image/webp')).toBe('webp');
    expect(sharpFormat('jpg')).toBe('jpeg');
    expect(sharpFormat('image/heic')).toBeUndefined();
  });

  test.skipIf(!sharp)('strip-metadata removes EXIF and applies orientation', async () => {
    const input = await jpegWithExif();
    expect(ascii(input)).toContain('SecretCam');
    const [r] = await proc!.process(input, 'image/jpeg', [{ op: 'strip-metadata' }]);
    expect(r?.type).toBe('image/jpeg');
    expect(ascii(r!.data!)).not.toContain('SecretCam');
    expect(ascii(r!.data!)).not.toContain('Exif');
    // orientation 6 applied to pixels: 200×100 becomes 100×200
    expect([r?.width, r?.height]).toEqual([100, 200]);
  });

  test.skipIf(!sharp)('resize fits inside, converts format, never enlarges', async () => {
    const img = await syntheticImage(sharp!, 2, { width: 400, height: 200 });
    const [a, b, c] = await proc!.process(img, 'image/png', [
      { op: 'resize', width: 100, format: 'webp', quality: 60 },
      { op: 'resize', width: 1000, height: 1000, format: 'avif' },
      { op: 'resize', width: 50, height: 50, format: 'image/jpeg' },
    ]);
    expect([a?.type, a?.width, a?.height]).toEqual(['image/webp', 100, 50]);
    expect([b?.type, b?.width, b?.height]).toEqual(['image/avif', 400, 200]);
    expect([c?.type, c?.width, c?.height]).toEqual(['image/jpeg', 50, 25]);
    expect(ascii(a!.data!.subarray(8, 12))).toBe('WEBP');
  });

  test.skipIf(!sharp)('thumbnail is a cover crop', async () => {
    const img = await syntheticImage(sharp!, 2, { width: 400, height: 200 });
    const [t] = await proc!.process(img, 'image/png', [{ op: 'thumbnail', width: 64 }]);
    expect([t?.type, t?.width, t?.height]).toEqual(['image/webp', 64, 64]);
  });

  test.skipIf(!sharp)('only accepts raster images', () => {
    expect(proc!.accepts({ op: 'resize' }, 'image/svg+xml')).toBe(false);
    expect(proc!.accepts({ op: 'resize' }, 'video/mp4')).toBe(false);
    expect(proc!.accepts({ op: 'transcode' }, 'image/png')).toBe(false);
  });
});

describe('FfmpegMediaProcessor', () => {
  test('absent ffmpeg is detected gracefully', () => {
    const p = createFfmpegMediaProcessor({ path: null });
    expect(p.available).toBe(false);
    expect(p.supports).toEqual([]);
    expect(p.accepts({ op: 'transcode' }, 'video/mp4')).toBe(false);
  });

  test('builds H.264/AAC mp4 + poster commands', () => {
    const t = ffmpegArgs({ op: 'transcode', width: 720, quality: 100 }, '/in', '/out.mp4');
    expect(t).toContain('libx264');
    expect(t).toContain('aac');
    expect(t).toContain('+faststart');
    expect(t[t.indexOf('-crf') + 1]).toBe('18');
    expect(t[t.indexOf('-vf') + 1]).toBe("scale='trunc(min(720,iw)/2)*2':-2");
    expect(t.at(-1)).toBe('/out.mp4');
    const p = ffmpegArgs({ op: 'thumbnail' }, '/in', '/p.jpg');
    expect(p).toContain('-frames:v');
    expect(crfFor(undefined)).toBe(23);
    expect(crfFor(0)).toBe(35);
    expect(() => ffmpegArgs({ op: 'resize' }, '/in', '/o')).toThrow();
  });

  test('runs ffmpeg via the exec hook and reads the output file', async () => {
    const seen: string[][] = [];
    const p = createFfmpegMediaProcessor({
      path: '/usr/bin/ffmpeg',
      exec: async (argv) => {
        seen.push(argv);
        await writeFile(argv.at(-1) as string, new TextEncoder().encode(`out:${argv.length}`));
        return { exitCode: 0, stderr: '' };
      },
    });
    expect(p.supports).toContain('transcode');
    const [mp4, poster] = await p.process(new Uint8Array([1, 2, 3]), 'video/quicktime', [
      { op: 'transcode' },
      { op: 'thumbnail' },
    ]);
    expect(mp4?.type).toBe('video/mp4');
    expect(poster?.type).toBe('image/jpeg');
    expect(seen[0]?.[0]).toBe('/usr/bin/ffmpeg');
    expect(seen[0]?.join(' ')).toContain('.mov');
    const failing = createFfmpegMediaProcessor({
      path: '/x/ffmpeg',
      exec: async () => ({ exitCode: 1, stderr: 'Invalid data found' }),
    });
    await expect(
      failing.process(new Uint8Array(1), 'video/mp4', [{ op: 'transcode' }]),
    ).rejects.toThrow('Invalid data found');
  });
});

describe('CompositeMediaProcessor', () => {
  const fake = (name: string, kind: string, supports: MediaOp['op'][]) => {
    const calls: string[] = [];
    const p: MediaProcessor & {
      name: string;
      accepts(op: MediaOp, type: string): boolean;
      calls: string[];
    } = {
      name,
      calls,
      supports,
      accepts: (_op, type) => type.startsWith(kind),
      async process(_i, type, ops) {
        calls.push(`${ops[0]?.op}:${type}`);
        return ops.map((o) => ({ op: o.op, hash: name }));
      },
    };
    return p;
  };

  test('routes ops by type and support', async () => {
    const img = fake('img', 'image/', ['thumbnail', 'perceptual-hash']);
    const vid = fake('vid', 'video/', ['thumbnail', 'transcode']);
    const c = new CompositeMediaProcessor([img, vid]);
    expect([...c.supports].sort()).toEqual(['perceptual-hash', 'thumbnail', 'transcode']);
    expect(processorNames(c)).toEqual(['img', 'vid']);
    expect((await c.process(new Uint8Array(), 'video/mp4', [{ op: 'thumbnail' }]))[0]?.hash).toBe(
      'vid',
    );
    expect((await c.process(new Uint8Array(), 'image/png', [{ op: 'thumbnail' }]))[0]?.hash).toBe(
      'img',
    );
    await expect(c.process(new Uint8Array(), 'image/png', [{ op: 'transcode' }])).rejects.toThrow(
      'No media tool',
    );
  });

  test('bun default composite reflects installed tools', async () => {
    const r = await createBunMediaProcessor({ ffmpeg: { path: null } });
    const sharp = await loadSharp();
    expect(r.ffmpeg).toBe(false);
    expect(r.sharp).toBe(!!sharp);
    if (sharp) expect(r.processor?.supports).toContain('perceptual-hash');
    else expect(r.processor).toBeUndefined();
  });
});
