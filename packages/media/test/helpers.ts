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
import { type MediaOptions, createMediaModule } from '../src/index.ts';
import { type SharpFactory, createSharpMediaProcessor } from '../src/sharp.ts';

export const HOST = 'media.example.com';
export const BASE = `https://${HOST}`;

export const sha = (b: Uint8Array) => testCrypto.sha256Hex(b);

let sharpFactory: SharpFactory | null | undefined;
/** sharp if installed, else null (tests skip with a message). */
export async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory !== undefined) return sharpFactory;
  try {
    const specifier = 'sharp';
    const mod = (await import(specifier)) as { default: SharpFactory };
    sharpFactory = mod.default;
  } catch {
    sharpFactory = null;
    console.warn('[media tests] sharp is not installed: skipping image-pixel tests');
  }
  return sharpFactory;
}

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

export async function syntheticImage(
  sharp: SharpFactory,
  seed: number,
  o: { width?: number; height?: number; format?: 'png' | 'jpeg'; quality?: number } = {},
): Promise<Uint8Array> {
  const width = o.width ?? 256;
  const height = o.height ?? 256;
  const img = sharp(syntheticPixels(seed, width, height), {
    raw: { width, height, channels: 3 },
  }).toFormat(o.format ?? 'png', o.quality ? { quality: o.quality } : {});
  const { data } = await img.toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

export async function sharpProcessor() {
  const s = await loadSharp();
  if (!s) return null;
  return createSharpMediaProcessor({ load: async () => ({ default: s }) });
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
