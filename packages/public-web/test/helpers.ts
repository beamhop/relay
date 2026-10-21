// SPDX-License-Identifier: AGPL-3.0-or-later
import { createBlossomModule } from '@beamhop/blossom';
import {
  type BeamhopModule,
  type Kernel,
  type NostrEvent,
  type Principal,
  createKernel,
  finalizeEvent,
  parseConfig,
} from '@beamhop/core';
import { createPolicyModule } from '@beamhop/policy';
import { relayModule } from '@beamhop/relay';
import { type TestKey, memoryPorts } from '@beamhop/testkit';
import { publicWebModule } from '../src/index.ts';
import { sha256Hex } from '../src/session.ts';

export const ORIGIN = 'https://relay.test';
export const HTML = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

export interface SetupOptions {
  relay?: Record<string, unknown>;
  relays?: Array<Record<string, unknown>>;
  modules?: BeamhopModule[];
  /** Put public-web first to prove NIP-11 negotiation does not depend on order. */
  publicFirst?: boolean;
  publicWeb?: Record<string, unknown>;
}

export async function setup(opts: SetupOptions = {}) {
  const ports = memoryPorts();
  const config = parseConfig({
    relays: opts.relays ?? [
      { id: 'main', hosts: ['relay.test'], info: { name: 'Test Relay' }, ...opts.relay },
    ],
    modules: opts.publicWeb ? { 'public-web': opts.publicWeb } : {},
  });
  const core = [relayModule, createPolicyModule(), createBlossomModule()];
  const modules = opts.publicFirst
    ? [publicWebModule, ...core, ...(opts.modules ?? [])]
    : [...(opts.modules ?? []), ...core, publicWebModule];
  const kernel: Kernel = await createKernel({ runtime: 'test', ports, config, modules });

  const request = (path: string, init: RequestInit = {}) =>
    kernel.http.request(`${ORIGIN}${path}`, init);

  return {
    kernel,
    ports,
    request,
    async html(path: string, init: RequestInit = {}) {
      const res = await request(path, { ...init, headers: { ...HTML, ...(init.headers ?? {}) } });
      return { res, body: await res.text() };
    },
    /** Full NIP-98 sign-in; returns the session cookie header value. */
    async login(
      key: TestKey,
      overrides: Partial<{ url: string; method: string; skew: number }> = {},
    ) {
      const ch = await request('/portal/challenge', { method: 'POST' });
      const { challenge, url } = (await ch.json()) as { challenge: string; url: string };
      const body = JSON.stringify({ challenge });
      const ev = finalizeEvent(
        {
          kind: 27235,
          created_at: ports.clock.now() + (overrides.skew ?? 0),
          content: '',
          tags: [
            ['u', overrides.url ?? url],
            ['method', overrides.method ?? 'POST'],
            ['payload', await sha256Hex(body)],
          ],
        },
        key.sk,
      );
      const res = await request('/portal/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Nostr ${btoa(JSON.stringify(ev))}`,
        },
        body,
      });
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      return { res, cookie, challenge, body, ev };
    },
    async csrf(cookie: string) {
      const { body } = await this.html('/portal', { headers: { cookie } });
      return /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
    },
    async post(path: string, cookie: string, fields: Record<string, string>) {
      return request(path, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        redirect: 'manual',
      });
    },
    event(
      key: TestKey,
      partial: Partial<Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>> = {},
    ) {
      return finalizeEvent(
        {
          kind: partial.kind ?? 1,
          tags: partial.tags ?? [],
          content: partial.content ?? 'hello',
          created_at: partial.created_at ?? ports.clock.now(),
        },
        key.sk,
      );
    },
  };
}

export const admin: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };
