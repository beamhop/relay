// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  FakeClock,
  MemoryEventStore,
  MemoryLogger,
  eventStoreContract,
  makeEvent,
  makeKey,
} from '@beamhop/testkit';
import { type AdapterImporters, loadStores } from '../src/adapters.ts';
import type { ImagesBindingLike } from '../src/cf-types.ts';
import { decodeState, encodeState } from '../src/connection.ts';
import { CfCrypto, CfLogger } from '../src/ports/basic.ts';
import { GuardedEventStore } from '../src/ports/guards.ts';
import { CfImagesMediaProcessor } from '../src/ports/media.ts';
import { relayHint } from '../src/ports/pubsub.ts';

eventStoreContract(
  'guarded(memory)',
  async () => new GuardedEventStore(new MemoryEventStore(), { chunkSize: 3 }),
);

describe('CPU guards: chunked queries', () => {
  async function seeded(n: number, sameSecond = false) {
    const inner = new MemoryEventStore();
    const key = makeKey();
    for (let i = 0; i < n; i++) {
      await inner.save('r', makeEvent(key, { created_at: sameSecond ? 1000 : 1000 + i }));
    }
    return inner;
  }

  test('chunked results equal unchunked results', async () => {
    const inner = await seeded(50);
    const guarded = new GuardedEventStore(inner, { chunkSize: 7 });
    for (const limit of [undefined, 5, 23, 50, 80]) {
      const f = limit === undefined ? { kinds: [1] } : { kinds: [1], limit };
      const a = (await guarded.query('r', [f])).map((e) => e.id);
      const b = (await inner.query('r', [f])).map((e) => e.id);
      expect(a).toEqual(b);
    }
  });

  test('pages correctly when many events share a timestamp', async () => {
    const inner = await seeded(20, true);
    const guarded = new GuardedEventStore(inner, { chunkSize: 4 });
    const a = await guarded.query('r', [{ limit: 15 }]);
    expect(a.map((e) => e.id)).toEqual((await inner.query('r', [{ limit: 15 }])).map((e) => e.id));
  });

  test('stops at the time budget and returns partial, ordered results', async () => {
    const inner = await seeded(40);
    let calls = 0;
    const slow = new Proxy(inner, {
      get(t, p, r) {
        if (p === 'query') {
          return async (...args: Parameters<MemoryEventStore['query']>) => {
            calls++;
            clock.advance(1);
            return t.query(...args);
          };
        }
        return Reflect.get(t, p, r);
      },
    });
    const clock = new FakeClock(0);
    const logger = new MemoryLogger();
    const guarded = new GuardedEventStore(slow, {
      chunkSize: 5,
      budgetMs: 2500,
      nowMs: () => clock.nowMs(),
      logger,
    });
    const out = await guarded.query('r', [{ limit: 40 }]);
    expect(calls).toBe(3);
    expect(out.length).toBe(15);
    const sorted = [...out].sort((a, b) => b.created_at - a.created_at);
    expect(out).toEqual(sorted);
    expect(logger.lines.some((l) => l.msg.includes('CPU'))).toBe(true);
  });

  test('caller abort signal stops paging', async () => {
    const inner = await seeded(30);
    const guarded = new GuardedEventStore(inner, { chunkSize: 5 });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await guarded.query('r', [{ limit: 30 }], { signal: ctrl.signal })).toEqual([]);
  });
});

describe('adapter loading', () => {
  test('uses storage-sql D1 stores and R2 blob store when exported', async () => {
    const events = new MemoryEventStore();
    const created: unknown[] = [];
    class R2BindingBlobStore {
      kind = 'r2';
      constructor(readonly bucket: unknown) {
        created.push(bucket);
      }
      async init() {}
    }
    const importers: AdapterImporters = {
      storageSql: async () => ({
        createSqlStores: async (opts: unknown) => {
          created.push(opts);
          return { events };
        },
      }),
      blobs: async () => ({ R2BindingBlobStore }),
    };
    const db = {
      prepare() {},
      async batch() {
        return [];
      },
    };
    const bucket = { tag: 'bucket' };
    const logger = new MemoryLogger();
    const s = await loadStores({ DB: db, BLOBS: bucket as never }, logger, importers);
    expect(s.events).toBe(events);
    expect(s.sources).toEqual({
      events: 'd1',
      blobIndex: 'memory',
      docs: 'memory',
      metrics: 'memory',
      blobs: 'r2',
    });
    expect(created).toEqual([{ driver: 'd1', d1: db }, bucket]);
    expect(logger.lines.some((l) => l.msg.includes('missing "docs"'))).toBe(true);
  });

  test('falls back to memory with a warning when exports are missing', async () => {
    const logger = new MemoryLogger();
    const s = await loadStores(
      {
        DB: {
          prepare() {},
          async batch() {
            return [];
          },
        },
        BLOBS: {} as never,
      },
      logger,
      {
        storageSql: async () => ({}),
        blobs: async () => {
          throw new Error('nope');
        },
      },
    );
    expect(s.sources.events).toBe('memory');
    expect(s.sources.blobs).toBe('memory');
    expect(logger.lines.filter((l) => l.level === 'warn').length).toBe(2);
  });
});

describe('basic ports', () => {
  test('hashIp is keyed, stable within a day and rotates daily', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const c = new CfCrypto('salt', clock);
    const h = c.hashIp('203.0.113.1');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(c.hashIp('203.0.113.1')).toBe(h);
    expect(new CfCrypto('other', clock).hashIp('203.0.113.1')).not.toBe(h);
    clock.advance(86400);
    expect(c.hashIp('203.0.113.1')).not.toBe(h);
  });

  test('sha256Hex/randomHex via WebCrypto; missing salt warns', async () => {
    let warned = false;
    const c = new CfCrypto(undefined, undefined, () => {
      warned = true;
    });
    expect(warned).toBe(true);
    expect(await c.sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(c.randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('logger emits JSON lines, filters by level, merges child fields', () => {
    const lines: string[] = [];
    const log = new CfLogger('info', { a: 1 }, (l) => lines.push(l));
    log.log('debug', 'hidden');
    log.child({ b: 2 }).log('warn', 'shown', { c: 3 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: 'warn', msg: 'shown', a: 1, b: 2, c: 3 },
    ]);
  });

  test('relay hint narrows channels to one relay', () => {
    expect(relayHint('events:alpha', ['alpha', 'beta'])).toBe('alpha');
    expect(relayHint('broadcast:config', ['alpha'])).toBeUndefined();
  });

  test('state codec round-trips Map/Set and drops unserializable entries', () => {
    const state = new Map<string, unknown>([
      ['relay', { subs: new Map([['a', [{ kinds: [1] }]]]), seen: new Set(['x']) }],
      ['fn', () => 1],
      ['n', 5],
    ]);
    const back = decodeState(encodeState(state));
    expect(back.get('n')).toBe(5);
    expect(back.has('fn')).toBe(false);
    const relay = back.get('relay') as { subs: Map<string, unknown>; seen: Set<string> };
    expect(relay.subs.get('a')).toEqual([{ kinds: [1] }]);
    expect(relay.seen.has('x')).toBe(true);
    expect(decodeState('not json').size).toBe(0);
  });
});

describe('Cloudflare Images media processor', () => {
  test('resize and thumbnail via the Images binding', async () => {
    const calls: unknown[] = [];
    const images: ImagesBindingLike = {
      input(stream) {
        const t = {
          transform(x: unknown) {
            calls.push(['transform', x]);
            return t;
          },
          async output(o: { format: string }) {
            calls.push(['output', o]);
            const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            return {
              response: () => new Response(bytes.slice(0, 2)),
              contentType: () => o.format,
              image: () => new Response(bytes).body as ReadableStream<Uint8Array>,
            };
          },
        };
        return t;
      },
    };
    const m = new CfImagesMediaProcessor(images);
    expect(m.supports).toEqual(['resize', 'thumbnail']);
    const out = await m.process(new Uint8Array([1, 2, 3]), 'image/png', [
      { op: 'thumbnail' },
      { op: 'resize', width: 800 },
    ]);
    expect(out.map((r) => [r.op, r.type, r.data?.length])).toEqual([
      ['thumbnail', 'image/webp', 2],
      ['resize', 'image/png', 2],
    ]);
    expect(calls[0]).toEqual(['transform', { width: 320, height: 320, fit: 'cover' }]);
    await expect(m.process(new Uint8Array(), 'image/png', [{ op: 'transcode' }])).rejects.toThrow();
    await expect(m.process(new Uint8Array(), 'video/mp4', [{ op: 'resize' }])).rejects.toThrow();
  });
});
