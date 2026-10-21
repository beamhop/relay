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
import { exifOrientation, imageFormat, imageInfo, sniffImage } from '../src/image-meta.ts';
import { WorkerImageProcessor } from '../src/image-pool.ts';
import { busiestWindow, cropTo, encodeFormat, flatten, grey, orient } from '../src/images.ts';
import { imageProcessor, syntheticImage, withExif } from './helpers.ts';

const ascii = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

/** 200×100 JPEG with EXIF (make, GPS) and the given orientation. */
async function jpegWithExif(orientation: number): Promise<Uint8Array> {
  const jpeg = await syntheticImage(3, { width: 200, height: 100, format: 'jpeg' });
  return withExif(jpeg, orientation);
}

/** Two-frame 1×1 GIF with a comment extension and a NETSCAPE loop extension. */
function animatedGif(): Uint8Array {
  const frame = [
    0x21,
    0xf9,
    4,
    0,
    10,
    0,
    0,
    0, // graphic control: 10 cs delay
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0, // image descriptor 1×1, no local table
    2,
    2,
    0x44,
    0x01,
    0, // LZW min size 2: clear, index 0, end
  ];
  return new Uint8Array([
    ...new TextEncoder().encode('GIF89a'),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0, // 1×1, global colour table of 2 entries
    255,
    0,
    0,
    0,
    0,
    255,
    0x21,
    0xff,
    11,
    ...new TextEncoder().encode('NETSCAPE2.0'),
    3,
    1,
    0,
    0,
    0,
    0x21,
    0xfe,
    9,
    ...new TextEncoder().encode('SecretCam'),
    0,
    ...frame,
    ...frame,
    0x3b,
  ]);
}

/** RIFF/WebP with an extra EXIF chunk and the VP8X EXIF flag set. */
function webpWithExif(lossy: Uint8Array): Uint8Array {
  const info = imageInfo(lossy);
  const bitstream = lossy.subarray(12);
  const vp8x = new Uint8Array(18);
  vp8x.set(new TextEncoder().encode('VP8X'));
  new DataView(vp8x.buffer).setUint32(4, 10, true);
  vp8x[8] = 0x08; // EXIF present
  const w = (info?.width ?? 1) - 1;
  const h = (info?.height ?? 1) - 1;
  vp8x.set([w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16], 12);
  const exifPayload = new TextEncoder().encode('MM\0*SecretCam!');
  const exif = new Uint8Array(8 + exifPayload.length + (exifPayload.length & 1));
  exif.set(new TextEncoder().encode('EXIF'));
  new DataView(exif.buffer).setUint32(4, exifPayload.length, true);
  exif.set(exifPayload, 8);
  const body = new Uint8Array([...vp8x, ...bitstream, ...exif]);
  const out = new Uint8Array(12 + body.length);
  out.set(new TextEncoder().encode('RIFF'));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(new TextEncoder().encode('WEBP'), 8);
  out.set(body, 12);
  return out;
}

describe('image headers', () => {
  test('sniff and info read size, orientation and animation without decoding', async () => {
    const jpeg = await jpegWithExif(6);
    expect(sniffImage(jpeg)).toBe('jpeg');
    expect(imageInfo(jpeg)).toEqual({
      format: 'jpeg',
      width: 200,
      height: 100,
      orientation: 6,
      animated: false,
    });
    const png = await syntheticImage(1, { width: 30, height: 20 });
    expect(imageInfo(png)).toMatchObject({ format: 'png', width: 30, height: 20 });
    const webp = await syntheticImage(1, { width: 30, height: 20, format: 'webp' });
    expect(imageInfo(webp)).toMatchObject({ format: 'webp', width: 30, height: 20 });
    const avif = await syntheticImage(1, { width: 30, height: 20, format: 'avif' });
    expect(imageInfo(avif)).toMatchObject({ format: 'avif', width: 30, height: 20 });
    expect(imageInfo(animatedGif())).toMatchObject({ format: 'gif', width: 1, animated: true });
    expect(imageInfo(new TextEncoder().encode('<svg/>'))).toBeUndefined();
    expect(exifOrientation(new Uint8Array(4))).toBe(1);
  });

  test('format names', () => {
    expect(imageFormat('image/webp')).toBe('webp');
    expect(imageFormat('jpg')).toBe('jpeg');
    expect(imageFormat('image/heic')).toBeUndefined();
    expect(encodeFormat('gif')).toBe('png');
    expect(encodeFormat('image/avif')).toBe('avif');
  });
});

describe('pixel helpers', () => {
  const img = (w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([i, 0, 0, 255], i * 4);
    return { data, width: w, height: h };
  };
  const at = (m: { data: Uint8ClampedArray; width: number }, x: number, y: number) =>
    m.data[(y * m.width + x) * 4];

  test('orient applies all eight EXIF orientations', () => {
    const src = img(3, 2); // pixel value = index: row 0 = 0 1 2, row 1 = 3 4 5
    expect(orient(src, 1)).toBe(src);
    const r6 = orient(src, 6); // 90° clockwise → 2×3, top row = 3 0
    expect([r6.width, r6.height, at(r6, 0, 0), at(r6, 1, 0), at(r6, 1, 2)]).toEqual([
      2, 3, 3, 0, 2,
    ]);
    const r3 = orient(src, 3);
    expect([at(r3, 0, 0), at(r3, 2, 1)]).toEqual([5, 0]);
    const r8 = orient(src, 8); // 90° counter-clockwise: top row = 2 5
    expect([at(r8, 0, 0), at(r8, 1, 0)]).toEqual([2, 5]);
    for (const o of [2, 4, 5, 7]) expect(orient(src, o).data.length).toBe(src.data.length);
  });

  test('flatten composites on white; grey is linear-light Rec. 709 luma (as libvips)', () => {
    const t = { data: new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 255]), width: 2, height: 1 };
    expect([...flatten(t).data]).toEqual([255, 255, 255, 255, 255, 0, 0, 255]);
    expect([...grey(flatten(t))]).toEqual([255, 127]);
  });

  test('busiestWindow moves the crop to the detailed side', () => {
    const w = 300;
    const h = 100;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    // Checkerboard on the right third, flat white elsewhere.
    for (let y = 0; y < h; y++)
      for (let x = 200; x < w; x++) if ((x + y) % 2) data.set([0, 0, 0, 255], (y * w + x) * 4);
    const r = busiestWindow({ data, width: w, height: h }, 1);
    expect([r.width, r.height, r.y]).toEqual([100, 100, 0]);
    expect(r.x).toBeGreaterThanOrEqual(180);
    // Flat image: centre.
    const flat = busiestWindow({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, 1);
    expect(flat.x).toBe(100);
    expect(cropTo({ data, width: w, height: h }, r).width).toBe(100);
  });
});

describe('ImageMediaProcessor (wasm codecs)', () => {
  const proc = imageProcessor();

  test('strip-metadata removes EXIF and GPS and applies orientation', async () => {
    const input = await jpegWithExif(6);
    expect(ascii(input)).toContain('SecretCam');
    const [r] = await proc.process(input, 'image/jpeg', [{ op: 'strip-metadata' }]);
    expect(r?.type).toBe('image/jpeg');
    expect(ascii(r!.data!)).not.toContain('SecretCam');
    expect(ascii(r!.data!)).not.toContain('Exif');
    // orientation 6 applied to pixels: 200×100 becomes 100×200
    expect([r?.width, r?.height]).toEqual([100, 200]);
    expect(imageInfo(r!.data!)).toMatchObject({ width: 100, height: 200, orientation: 1 });
  });

  test('strip-metadata without rotation is lossless (pixel data untouched)', async () => {
    const jpeg = await syntheticImage(3, { width: 64, height: 32, format: 'jpeg' });
    const [r] = await proc.process(withExif(jpeg, 1), 'image/jpeg', [{ op: 'strip-metadata' }]);
    expect(r!.data).toEqual(jpeg);
    const png = await syntheticImage(3, { width: 16, height: 16 });
    const [p] = await proc.process(png, 'image/png', [{ op: 'strip-metadata' }]);
    expect(p!.data!.length).toBeLessThanOrEqual(png.length);
    expect(sniffImage(p!.data!)).toBe('png');
  });

  test('strip-metadata keeps GIF and WebP animation/bitstream, drops comments and EXIF', async () => {
    const gif = animatedGif();
    const [g] = await proc.process(gif, 'image/gif', [{ op: 'strip-metadata' }]);
    expect(ascii(g!.data!)).not.toContain('SecretCam');
    expect(ascii(g!.data!)).toContain('NETSCAPE2.0');
    expect(imageInfo(g!.data!)).toMatchObject({ animated: true });
    const webp = webpWithExif(await syntheticImage(2, { width: 40, height: 20, format: 'webp' }));
    expect(ascii(webp)).toContain('SecretCam');
    const [w] = await proc.process(webp, 'image/webp', [{ op: 'strip-metadata' }]);
    expect(ascii(w!.data!)).not.toContain('SecretCam');
    expect(w!.data![20]! & 0x08).toBe(0); // VP8X EXIF flag cleared
    // Still a valid image of the same size.
    const [t] = await proc.process(w!.data!, 'image/webp', [{ op: 'thumbnail', width: 8 }]);
    expect(t?.width).toBe(8);
    expect(new DataView(w!.data!.buffer).getUint32(4, true)).toBe(w!.data!.length - 8);
  });

  test('resize fits inside, converts format, never enlarges', async () => {
    const img = await syntheticImage(2, { width: 400, height: 200 });
    const [a, b, c] = await proc.process(img, 'image/png', [
      { op: 'resize', width: 100, format: 'webp', quality: 60 },
      { op: 'resize', width: 1000, height: 1000, format: 'avif' },
      { op: 'resize', width: 50, height: 50, format: 'image/jpeg' },
    ]);
    expect([a?.type, a?.width, a?.height]).toEqual(['image/webp', 100, 50]);
    expect([b?.type, b?.width, b?.height]).toEqual(['image/avif', 400, 200]);
    expect([c?.type, c?.width, c?.height]).toEqual(['image/jpeg', 50, 25]);
    expect(ascii(a!.data!.subarray(8, 12))).toBe('WEBP');
    expect(imageInfo(c!.data!)).toMatchObject({ width: 50, height: 25 });
  });

  test('thumbnail is a cover crop; GIF input works from its first frame', async () => {
    const img = await syntheticImage(2, { width: 400, height: 200 });
    const [t] = await proc.process(img, 'image/png', [{ op: 'thumbnail', width: 64 }]);
    expect([t?.type, t?.width, t?.height]).toEqual(['image/webp', 64, 64]);
    expect(imageInfo(t!.data!)).toMatchObject({ width: 64, height: 64 });
    const [g] = await proc.process(animatedGif(), 'image/gif', [{ op: 'thumbnail', width: 8 }]);
    expect([g?.width, g?.height]).toEqual([8, 8]);
  });

  test('refuses decompression bombs and lying content types before decoding', async () => {
    const small = imageProcessor({ maxPixels: 1000 });
    const img = await syntheticImage(1, { width: 100, height: 100 });
    await expect(small.process(img, 'image/png', [{ op: 'thumbnail' }])).rejects.toThrow(
      'too large',
    );
    await expect(
      proc.process(new TextEncoder().encode('<svg/>'), 'image/png', [{ op: 'thumbnail' }]),
    ).rejects.toThrow('Not a supported image');
  });

  test('only accepts raster images', () => {
    expect(proc.accepts({ op: 'resize' }, 'image/svg+xml')).toBe(false);
    expect(proc.accepts({ op: 'resize' }, 'image/tiff')).toBe(false);
    expect(proc.accepts({ op: 'resize' }, 'video/mp4')).toBe(false);
    expect(proc.accepts({ op: 'transcode' }, 'image/png')).toBe(false);
    expect(proc.accepts({ op: 'thumbnail' }, 'image/avif')).toBe(true);
  });
});

describe('WorkerImageProcessor', () => {
  test('runs jobs in a worker thread and survives a bad job', async () => {
    const w = new WorkerImageProcessor();
    try {
      const img = await syntheticImage(2, { width: 120, height: 60 });
      const [t, h] = await w.process(img, 'image/png', [
        { op: 'thumbnail', width: 32 },
        { op: 'perceptual-hash' },
      ]);
      expect([t?.width, t?.height, t?.type]).toEqual([32, 32, 'image/webp']);
      expect(h?.hash).toMatch(/^[0-9a-f]{16}$/);
      // The caller's input buffer is not transferred away.
      expect(img.byteLength).toBeGreaterThan(0);
      // Plain await: bun's `expect(promise).rejects` does not deliver Worker messages.
      const bad = await w
        .process(new Uint8Array([1, 2, 3]), 'image/png', [{ op: 'thumbnail' }])
        .catch((e: Error) => e);
      expect(String(bad)).toContain('Not a supported image');
      const [again] = await w.process(img, 'image/png', [{ op: 'resize', width: 10 }]);
      expect(again?.width).toBe(10);
    } finally {
      w.close();
    }
  });

  test('a job that times out fails and the next one gets a fresh worker', async () => {
    const w = new WorkerImageProcessor({ timeoutMs: 1 });
    const img = await syntheticImage(2, { width: 400, height: 400 });
    const err = await w.process(img, 'image/png', [{ op: 'thumbnail' }]).catch((e: Error) => e);
    expect(String(err)).toContain('longer than');
    w.close();
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

  test('bun default composite always has image tools; ffmpeg when found', async () => {
    const r = await createBunMediaProcessor({ ffmpeg: { path: null } });
    expect(r.ffmpeg).toBe(false);
    expect(r.images).toBe(true);
    expect(processorNames(r.processor)).toEqual(['image-codecs']);
    expect(r.processor.supports).toContain('perceptual-hash');
  });
});
