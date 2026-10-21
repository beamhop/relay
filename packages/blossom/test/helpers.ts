// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BeamhopConfig,
  type Kernel,
  type Ports,
  type Principal,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { FakeClock, type TestKey, makeEvent, memoryPorts } from '@beamhop/testkit';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { type BlossomOptions, createBlossomModule } from '../src/index.ts';

export const HOST = 'media.example.com';
export const OTHER = 'other.example.com';
export const BASE = `https://${HOST}`;

export const enc = (s: string) => new TextEncoder().encode(s);
export const hashOf = (b: Uint8Array) => bytesToHex(sha256(b));

export interface Setup {
  kernel: Kernel;
  ports: ReturnType<typeof memoryPorts>;
  req: (path: string, init?: RequestInit, host?: string) => Promise<Response>;
}

export async function setup(
  o: {
    blossom?: Record<string, unknown>;
    relay?: Record<string, unknown>;
    module?: BlossomOptions;
    ports?: Partial<Ports>;
  } = {},
): Promise<Setup> {
  const ports = memoryPorts({ clock: new FakeClock(Date.now()), ...o.ports });
  const config: BeamhopConfig = parseConfig({
    relays: [
      { id: 'main', hosts: [HOST], blossom: o.blossom ?? {}, ...o.relay },
      { id: 'other', hosts: [OTHER] },
    ],
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [createBlossomModule(o.module)],
  });
  const req = async (path: string, init?: RequestInit, host = HOST) =>
    kernel.http.request(`https://${host}${path}`, init);
  return { kernel, ports, req };
}

export function authEvent(
  key: TestKey,
  t: string,
  o: {
    x?: string[];
    now?: number;
    expiration?: number;
    createdAt?: number;
    kind?: number;
    server?: string;
  } = {},
) {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const tags = [
    ['t', t],
    ['expiration', String(o.expiration ?? now + 600)],
    ...(o.x ?? []).map((h) => ['x', h]),
  ];
  if (o.server) tags.push(['server', o.server]);
  return makeEvent(key, { kind: o.kind ?? 24242, created_at: o.createdAt ?? now, tags });
}

export function authHeader(key: TestKey, t: string, o: Parameters<typeof authEvent>[2] = {}) {
  return `Nostr ${btoa(JSON.stringify(authEvent(key, t, o)))}`;
}

export const admin: Principal = { id: 'test-admin', roles: { '*': 'owner' }, via: 'cli' };

export function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}
