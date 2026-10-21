// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type NostrEvent, defineModule, verifyEvent } from '@beamhop/core';
import type { OutsideDialer, TestSocket } from '../src/index.ts';
import { COL } from '../src/index.ts';
import { setup } from './helpers.ts';

describe('launch kit', () => {
  test('addresses, QR, unpublished draft and NIP-11 polish', async () => {
    const { act, kernel } = await setup({
      relay: { info: { name: 'Cats', description: 'Cat pics' } },
    });
    const published: unknown[] = [];
    kernel.bus.on('event.accepted', (e) => published.push(e));
    const { output } = await act('experience.launch-kit', {});
    expect(output.urls).toEqual({
      relay: 'wss://relay.example.com',
      blossom: 'https://relay.example.com',
      landing: 'https://relay.example.com/',
      nip11: 'https://relay.example.com',
    });
    expect(output.qr.landing.startsWith('<svg')).toBe(true);
    expect(output.qr.relay).toContain('</svg>');
    expect(output.announcement.published).toBe(false);
    expect(output.announcement.draft.kind).toBe(1);
    expect(output.announcement.draft.content).toContain('wss://relay.example.com');
    expect(output.announcement.draft.content).toContain('Cats');
    expect('sig' in output.announcement.draft).toBe(false);
    const fields = output.polish.map((p: { field: string }) => p.field);
    expect(fields).toContain('icon');
    expect(fields).toContain('contact');
    expect(fields).not.toContain('description');
    expect(fields).not.toContain('name');
    expect(published).toHaveLength(0);
  });

  test('plain ws/http when TLS is off; no blossom URL when media is off', async () => {
    const { act } = await setup({
      config: {
        node: { tls: { mode: 'off' } },
        relays: [{ id: 'main', hosts: ['localhost:3334'], blossom: { enabled: false } }],
      },
    });
    const { output } = await act('experience.launch-kit', {});
    expect(output.urls.relay).toBe('ws://localhost:3334');
    expect(output.urls.blossom).toBeNull();
    expect(output.polish.map((p: { field: string }) => p.field)).toContain('description');
  });
});

/** A fake "internet": a relay that stores events and blobs. */
function fakeOutside(opts: { refuse?: string; down?: boolean } = {}) {
  const events = new Map<string, NostrEvent>();
  const blobs = new Map<string, Uint8Array>();
  const log: string[] = [];
  const dialer: OutsideDialer = {
    async fetch(req) {
      log.push(`${req.method} ${req.url}`);
      const url = new URL(req.url);
      if (req.headers.get('accept') === 'application/nostr+json')
        return Response.json({ name: 'Cats' });
      if (req.method === 'PUT' && url.pathname === '/upload') {
        if (!req.headers.get('authorization')?.startsWith('Nostr '))
          return new Response(null, { status: 401 });
        const auth = JSON.parse(atob(req.headers.get('authorization')!.slice(6))) as NostrEvent;
        if (!verifyEvent(auth) || auth.kind !== 24242) return new Response(null, { status: 401 });
        const body = new Uint8Array(await req.arrayBuffer());
        blobs.set(req.headers.get('x-sha-256')!, body);
        return Response.json({}, { status: 201 });
      }
      if (req.method === 'GET') {
        const b = blobs.get(url.pathname.slice(1));
        return b ? new Response(b.slice()) : new Response(null, { status: 404 });
      }
      if (req.method === 'DELETE') {
        blobs.delete(url.pathname.slice(1));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
    async connect(url) {
      log.push(`WS ${url}`);
      if (opts.down) throw new Error('ECONNREFUSED');
      const queue: string[] = [];
      const sock: TestSocket = {
        send(raw) {
          const msg = JSON.parse(raw);
          if (msg[0] === 'EVENT') {
            const ev = msg[1] as NostrEvent;
            if (opts.refuse) queue.push(JSON.stringify(['OK', ev.id, false, opts.refuse]));
            else {
              if (verifyEvent(ev)) events.set(ev.id, ev);
              queue.push(JSON.stringify(['OK', ev.id, verifyEvent(ev), '']));
            }
          } else if (msg[0] === 'REQ') {
            queue.push(JSON.stringify(['NOTICE', 'hello'])); // noise is skipped
            for (const id of msg[2].ids) {
              const e = events.get(id);
              if (e) queue.push(JSON.stringify(['EVENT', msg[1], e]));
            }
            queue.push(JSON.stringify(['EOSE', msg[1]]));
          }
        },
        async receive() {
          return queue.shift() ?? null;
        },
        close() {
          log.push('WS close');
        },
      };
      return sock;
    },
  };
  return { dialer, events, blobs, log };
}

describe('test my relay', () => {
  test('full round trip passes and counts toward the checklist', async () => {
    const out = fakeOutside();
    const { act, ports } = await setup({ experience: { dialer: out.dialer, testTimeoutMs: 200 } });
    const { output } = await act('experience.test-relay', {});
    expect(output.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual([
      'info:pass',
      'connect:pass',
      'publish:pass',
      'fetch:pass',
      'upload:pass',
      'download:pass',
    ]);
    expect(output.ok).toBe(true);
    expect(output.summary).toContain('Everything works');
    // Test event was cleaned up with a deletion and the blob deleted.
    const kinds = [...out.events.values()].map((e) => e.kind).sort((a, b) => a - b);
    expect(kinds).toEqual([5, 30078]);
    expect(out.blobs.size).toBe(0);
    expect(out.log).toContain('WS wss://relay.example.com');
    expect((await ports.docs.get<{ ok: boolean }>(COL.testRuns, 'main'))?.ok).toBe(true);
    const c = (await act('experience.checklist', {})).output;
    expect(c.items.find((i: { id: string }) => i.id === 'test-relay').done).toBe(true);
  });

  test('a relay that refuses strangers is a warning, not a failure', async () => {
    const out = fakeOutside({ refuse: 'restricted: only members can post here' });
    const { act } = await setup({ experience: { dialer: out.dialer, testTimeoutMs: 200 } });
    const { output } = await act('experience.test-relay', { skipUpload: true });
    const publish = output.steps.find((s: { id: string }) => s.id === 'publish');
    expect(publish.status).toBe('warn');
    expect(publish.technical).toContain('restricted');
    expect(output.steps.find((s: { id: string }) => s.id === 'fetch').status).toBe('skip');
    expect(output.ok).toBe(true);
  });

  test('connection failure is reported in plain words', async () => {
    const out = fakeOutside({ down: true });
    const { act } = await setup({ experience: { dialer: out.dialer, testTimeoutMs: 200 } });
    const { output } = await act('experience.test-relay', {});
    expect(output.ok).toBe(false);
    const connect = output.steps.find((s: { id: string }) => s.id === 'connect');
    expect(connect.status).toBe('fail');
    expect(connect.technical).toContain('ECONNREFUSED');
    expect(output.summary).toContain('connect');
  });
});

describe('address resolution (no domain configured)', () => {
  const wildcard = { hosts: ['*'] };

  test('wildcard host with nothing else known → needsDomain with a link, no checks run', async () => {
    const out = fakeOutside();
    const { act, ports } = await setup({
      relay: wildcard,
      experience: { dialer: out.dialer, testTimeoutMs: 200 },
    });
    const { output, result } = await act('experience.test-relay', {});
    expect(output.ok).toBe(false);
    expect(output.needsDomain).toBe(true);
    expect(output.summary).toStartWith('No web address is set yet');
    expect(output.link.screen).toBe('/settings/domains');
    expect(output.steps).toEqual([]);
    expect(result.summary).toBe(output.summary);
    expect(out.log).toEqual([]);
    expect(await ports.docs.get(COL.testRuns, 'main')).toBeNull();
    const kit = (await act('experience.launch-kit', {})).output;
    expect(kit.needsDomain).toBe(true);
    expect(kit.link.screen).toBe('/settings/domains');
    expect(JSON.stringify(kit)).not.toContain('wss://*');
  });

  test('explicit baseUrl wins and sets the scheme (http → ws, https → wss)', async () => {
    const out = fakeOutside();
    const { act } = await setup({
      relay: wildcard,
      experience: { dialer: out.dialer, testTimeoutMs: 200 },
    });
    const { output } = await act('experience.test-relay', {
      baseUrl: 'http://127.0.0.1:3334/admin/',
    });
    expect(output.ok).toBe(true);
    expect(output.needsDomain).toBe(false);
    expect(output.urlSource).toBe('baseUrl');
    expect(output.urls.relay).toBe('ws://127.0.0.1:3334');
    expect(out.log).toContain('WS ws://127.0.0.1:3334');
    expect(out.log).toContain('GET http://127.0.0.1:3334/');
    const kit = (await act('experience.launch-kit', { baseUrl: 'https://cats.example' })).output;
    expect(kit.ok).toBe(true);
    expect(kit.urls).toEqual({
      relay: 'wss://cats.example',
      blossom: 'https://cats.example',
      landing: 'https://cats.example/',
      nip11: 'https://cats.example',
    });
    expect(kit.announcement.text).toContain('wss://cats.example');
  });

  test('baseUrl beats configured hosts; path prefix is kept', async () => {
    const { act } = await setup({ relay: { hosts: ['relay.example.com'], pathPrefix: '/r1' } });
    const kit = (await act('experience.launch-kit', { baseUrl: 'http://localhost:3334' })).output;
    expect(kit.urls.relay).toBe('ws://localhost:3334/r1');
    const cfgOnly = (await act('experience.launch-kit', {})).output;
    expect(cfgOnly.urlSource).toBe('host');
    expect(cfgOnly.urls.relay).toBe('wss://relay.example.com/r1');
  });

  test('falls back to the last address the relay was reached at', async () => {
    const learned = defineModule({
      id: 'blossom',
      register(kernel) {
        kernel.provide('blossom', {
          learnedPublicUrl: (id: string) => (id === 'main' ? 'http://192.168.1.5:3334' : null),
        });
      },
    });
    const { act } = await setup({ relay: wildcard, modules: [learned] });
    const kit = (await act('experience.launch-kit', {})).output;
    expect(kit.urlSource).toBe('learned');
    expect(kit.urls.relay).toBe('ws://192.168.1.5:3334');
    // An unusable baseUrl is ignored.
    const bad = (await act('experience.launch-kit', { baseUrl: 'javascript:alert(1)' })).output;
    expect(bad.urlSource).toBe('learned');
  });
});
