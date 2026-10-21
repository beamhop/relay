import { createBlossomModule } from '@beamhop/blossom';
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BeamhopConfig,
  type Kernel,
  type MediaOp,
  type MediaProcessor,
  type MediaResult,
  type Notification,
  type Ports,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { FakeClock, memoryPorts, testCrypto } from '@beamhop/testkit';
import { createBunImageCodecs } from '../src/bun-codecs.ts';
import {
  type EncodeFormat,
  ImageMediaProcessor,
  type ImageProcessorOptions,
  type RgbaImage,
} from '../src/images.ts';
import { type MediaOptions, createMediaModule } from '../src/index.ts';

export const HOST = 'media.example.com';
export const BASE = `https://${HOST}`;

export const sha = (b: Uint8Array) => testCrypto.sha256Hex(b);

/** The built-in wasm codecs, run in-thread (the runtime uses a worker; see image-pool.ts). */
export const codecs = createBunImageCodecs();

/** In-thread image processor over the real codecs. */
export const imageProcessor = (o: ImageProcessorOptions = {}) => new ImageMediaProcessor(codecs, o);

/**
 * Deterministic synthetic RGB picture: smooth shapes + gradients driven by `seed`.
 * Different seeds give visually different images; same seed → same pixels.
 */
export function syntheticPixels(seed: number, width = 256, height = 256): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  const a = (seed * 0.37) % 1;
  const cx = (0.3 + 0.4 * ((seed * 0.61) % 1)) * width;
  const cy = (0.3 + 0.4 * ((seed * 0.83) % 1)) * height;
  const r = (0.15 + 0.2 * ((seed * 0.29) % 1)) * width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const d = Math.hypot(x - cx, y - cy);
      const inside = d < r ? 1 : 0;
      const wave = Math.sin((x / width) * Math.PI * (2 + seed) + a * 6) * 0.5 + 0.5;
      const g = (y / height) * (seed % 2 === 0 ? 1 : -1) + (seed % 2 === 0 ? 0 : 1);
      px[i] = Math.round(255 * (inside ? 0.9 : wave * 0.6));
      px[i + 1] = Math.round(255 * (inside ? 0.2 : g * 0.8));
      px[i + 2] = Math.round(255 * (inside ? 0.4 : (1 - wave) * 0.7));
    }
  }
  return px;
}

/** RGB pixels → RGBA image. */
export function rgba(rgb: Uint8Array, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[i * 3] ?? 0;
    data[i * 4 + 1] = rgb[i * 3 + 1] ?? 0;
    data[i * 4 + 2] = rgb[i * 3 + 2] ?? 0;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

export async function syntheticImage(
  seed: number,
  o: { width?: number; height?: number; format?: EncodeFormat; quality?: number } = {},
): Promise<Uint8Array> {
  const width = o.width ?? 256;
  const height = o.height ?? 256;
  return codecs.encode(
    o.format ?? 'png',
    rgba(syntheticPixels(seed, width, height), width, height),
    o.quality,
  );
}

/**
 * Insert an EXIF APP1 segment (big-endian TIFF) right after SOI: orientation, a
 * camera make, and a GPS IFD with a latitude ref, so tests can check all are gone.
 */
export function withExif(jpeg: Uint8Array, orientation: number, make = 'SecretCam'): Uint8Array {
  const makeBytes = new TextEncoder().encode(`${make}\0`);
  // TIFF: header(8) + IFD0 with 3 entries (2 + 36 + 4) + GPS IFD with 1 entry (2 + 12 + 4) + make.
  const ifd0 = 8;
  const gps = ifd0 + 2 + 3 * 12 + 4;
  const makeAt = gps + 2 + 12 + 4;
  const tiff = new Uint8Array(makeAt + makeBytes.length);
  const v = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0, 42]);
  v.setUint32(4, ifd0);
  v.setUint16(ifd0, 3);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    v.setUint16(at, tag);
    v.setUint16(at + 2, type);
    v.setUint32(at + 4, count);
    if (type === 3 && count === 1) v.setUint16(at + 8, value);
    else v.setUint32(at + 8, value);
  };
  entry(ifd0 + 2, 0x010f, 2, makeBytes.length, makeAt); // Make (ASCII, offset)
  entry(ifd0 + 14, 0x0112, 3, 1, orientation); // Orientation (SHORT)
  entry(ifd0 + 26, 0x8825, 4, 1, gps); // GPS IFD pointer
  v.setUint16(gps, 1);
  entry(gps + 2, 0x0001, 2, 2, 0x4e000000); // GPSLatitudeRef "N"
  tiff.set(makeBytes, makeAt);
  const app1 = new Uint8Array(4 + 6 + tiff.length);
  const a = new DataView(app1.buffer);
  a.setUint16(0, 0xffe1);
  a.setUint16(2, 2 + 6 + tiff.length);
  app1.set(new TextEncoder().encode('Exif\0\0'), 4);
  app1.set(tiff, 10);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

/**
 * Fake processor (no native deps): `perceptual-hash` returns the first 16 hex chars of
 * the bytes' sha256 (phash) or chars 16..32 (dhash); thumbnail/resize return tagged bytes.
 * `gate` delays every call until resolved.
 */
export class FakeProcessor implements MediaProcessor {
  readonly name = 'fake';
  supports: ReadonlyArray<MediaOp['op']> = ['perceptual-hash', 'thumbnail', 'resize'];
  calls: MediaOp[] = [];
  gate?: Promise<void>;
  async process(input: Uint8Array, type: string, ops: MediaOp[]): Promise<MediaResult[]> {
    if (this.gate) await this.gate;
    const h = await sha(input);
    const out: MediaResult[] = [];
    for (const op of ops) {
      this.calls.push(op);
      if (op.op === 'perceptual-hash') {
        out.push({
          op: op.op,
          hash: op.format === 'dhash' ? h.slice(16, 32) : h.slice(0, 16),
          width: 2000,
          height: 1000,
          blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        });
      } else {
        const w = op.width ?? 320;
        const data = new TextEncoder().encode(`${op.op}:${w}:${h}`);
        out.push({ op: op.op, data, type: 'image/webp', width: w, height: Math.round(w / 2) });
      }
    }
    return out;
  }
}

export interface Setup {
  kernel: Kernel;
  ports: ReturnType<typeof memoryPorts>;
  notifications: Notification[];
  req: (path: string, init?: RequestInit) => Promise<Response>;
  upload: (data: Uint8Array, type?: string) => Promise<Response>;
}

export async function setup(
  o: {
    blossom?: Record<string, unknown>;
    media?: Record<string, unknown>;
    module?: MediaOptions;
    ports?: Partial<Ports>;
  } = {},
): Promise<Setup> {
  const ports = memoryPorts({ clock: new FakeClock(Date.now()), ...o.ports });
  const config: BeamhopConfig = parseConfig({
    relays: [{ id: 'main', hosts: [HOST], blossom: { requireAuth: false, ...o.blossom } }],
    modules: { media: o.media ?? {} },
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [createBlossomModule(), createMediaModule(o.module)],
  });
  const notifications: Notification[] = [];
  kernel.setNotifier(async (n) => {
    notifications.push(n);
  });
  const req = async (path: string, init?: RequestInit) =>
    kernel.http.request(`${BASE}${path}`, init);
  const upload = async (data: Uint8Array, type = 'image/png') =>
    req('/upload', { method: 'PUT', body: data as BodyInit, headers: { 'content-type': type } });
  return { kernel, ports, notifications, req, upload };
}

/** Stub fetch serving fixed texts by URL. */
export function stubFetch(map: Record<string, string | number>) {
  return async (r: Request) => {
    const v = map[r.url];
    if (v === undefined || typeof v === 'number') return new Response('nope', { status: v ?? 404 });
    return new Response(v);
  };
}
