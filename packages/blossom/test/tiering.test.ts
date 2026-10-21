// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type BlobStore, type Kernel, createKernel, parseConfig } from '@beamhop/core';
import { FakeClock, MemoryBlobStore, makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import {
  BLOCKED,
  BLOSSOM_GC_JOB,
  BLOSSOM_TIERING_JOB,
  type BlossomService,
  QUARANTINE,
  TIERS,
  type TieringStatusOutput,
  createBlossomModule,
} from '../src/index.ts';
import { HOST, admin, authHeader, enc, hashOf } from './helpers.ts';

const DAY = 86_400;

async function setup(
  o: { modules?: Record<string, unknown>; cold?: BlobStore | null; holds?: Set<string> } = {},
) {
  const ports = memoryPorts({ clock: new FakeClock(Date.now()) });
  const cold = o.cold === undefined ? new MemoryBlobStore() : o.cold;
  const config = parseConfig({
    relays: [{ id: 'main', hosts: [HOST] }],
    modules: o.modules ?? {},
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [
      createBlossomModule({
        tiering: cold ? { coldStore: cold } : {},
      }),
    ],
  });
  if (o.holds) {
    const holds = o.holds;
    kernel.provide('lifecycle.holds', {
      isHeld: async (_r: string, s: { sha256?: string }) => !!s.sha256 && holds.has(s.sha256),
    });
  }
  const req = async (path: string, init?: RequestInit) =>
    kernel.http.request(`https://${HOST}${path}`, init);
  const svc = kernel.use<BlossomService>('blossom') as BlossomService;
  // The raw hot store (ports.blobs itself now reads both tiers).
  const hot = svc.tiering!.store.hot;
  const ctx = { principal: admin, relayId: 'main', ports };
  const nodeCtx = { principal: admin, relayId: null, ports };
  const run = async (id: string, input: unknown, c: typeof ctx | typeof nodeCtx = ctx) => {
    const a = kernel.actions.get(id);
    if (!a) throw new Error(`no action ${id}`);
    return a.run(a.input.parse(input), c);
  };
  return { kernel, ports, hot, cold, req, svc, ctx, nodeCtx, run };
}

const tiered = (afterDays = 30, extra: Record<string, unknown> = {}) => ({
  blossom: {
    tiers: { cold: { store: { driver: 'memory' }, afterDays, ...extra } },
  },
});

async function upload(
  s: { req: (p: string, i?: RequestInit) => Response | Promise<Response> },
  key: ReturnType<typeof makeKey>,
  data: Uint8Array,
) {
  return s.req('/upload', {
    method: 'PUT',
    body: data as BodyInit,
    headers: {
      authorization: authHeader(key, 'upload', { x: [hashOf(data)] }),
      'content-type': 'image/png',
    },
  });
}

describe('hot/cold tiering', () => {
  test('off by default: pass-through, job is a no-op', async () => {
    const s = await setup({ cold: null });
    const key = makeKey();
    const data = enc('plain file');
    expect((await upload(s, key, data)).status).toBe(200);
    expect(await s.hot.head(hashOf(data))).not.toBeNull();
    await s.ports.scheduler.tick(BLOSSOM_TIERING_JOB);
    const st = (await s.run('media.storage-tiers', {}, s.nodeCtx)).output as TieringStatusOutput;
    expect(st.enabled).toBe(false);
    expect(st.tiers).toHaveLength(1);
    expect(st.tiers[0]?.usedBytes).toBe(data.length);
  });

  test('moves stale blobs to cold, serves them transparently, never moves quarantined or held', async () => {
    const holds = new Set<string>();
    const s = await setup({ modules: tiered(30), holds });
    const key = makeKey();
    const a = enc('old and cold');
    const b = enc('quarantined one');
    const c = enc('held one');
    const d = enc('read recently');
    for (const x of [a, b, c, d]) expect((await upload(s, key, x)).status).toBe(200);
    await s.svc.quarantine('main', hashOf(b), 'Held for review');
    holds.add(hashOf(c));
    s.ports.clock.advance(20 * DAY);
    expect((await s.req(`/${hashOf(d)}`)).status).toBe(200);
    await s.svc.settled();
    s.ports.clock.advance(11 * DAY);

    await s.ports.scheduler.tick(BLOSSOM_TIERING_JOB);
    expect(await s.cold!.head(hashOf(a))).not.toBeNull();
    expect(await s.hot.head(hashOf(a))).toBeNull();
    for (const x of [b, c, d]) {
      expect(await s.hot.head(hashOf(x))).not.toBeNull();
      expect(await s.cold!.head(hashOf(x))).toBeNull();
    }
    // Recorded in the tier index.
    expect(await s.ports.docs.get(TIERS, hashOf(a))).toMatchObject({ tier: 'cold' });
    // Transparent GET (incl. range) from cold.
    const got = await s.req(`/${hashOf(a)}`, { headers: { range: 'bytes=0-2' } });
    expect(got.status).toBe(206);
    expect(await got.text()).toBe('old');
    // list-blobs shows the tier.
    const list = (await s.run('media.list-blobs', {})).output as {
      items: Array<{ sha256: string; tier: string; owners: number }>;
    };
    expect(list.items.find((i) => i.sha256 === hashOf(a))).toMatchObject({
      tier: 'cold',
      owners: 1,
    });

    const st = (await s.run('media.storage-tiers', {}, s.nodeCtx)).output as TieringStatusOutput;
    expect(st.enabled).toBe(true);
    expect(st.job.moved).toBe(1);
    expect(st.job.lastRun).not.toBeNull();
    expect(st.job.nextRun).toBeGreaterThan(st.job.lastRun ?? 0);
    expect(st.tiers.find((t) => t.tier === 'cold')?.count).toBe(1);

    // Idempotent: a second run moves nothing more.
    const again = await s.run('media.run-tiering', {}, s.nodeCtx);
    expect((again.output as { moved: number }).moved).toBe(0);
  });

  test('resumable: a run stops at its scan budget and the next continues', async () => {
    const ports = memoryPorts({ clock: new FakeClock(Date.now()) });
    const cold = new MemoryBlobStore();
    const kernel: Kernel = await createKernel({
      runtime: 'test',
      ports,
      config: parseConfig({ relays: [{ id: 'main', hosts: [HOST] }], modules: tiered(1) }),
      modules: [createBlossomModule({ tiering: { coldStore: cold, maxScan: 2 } })],
    });
    const key = makeKey();
    for (let i = 0; i < 5; i++) {
      const data = enc(`file ${i}`);
      const r = await kernel.http.request(`https://${HOST}/upload`, {
        method: 'PUT',
        body: data as BodyInit,
        headers: { authorization: authHeader(key, 'upload', { x: [hashOf(data)] }) },
      });
      expect(r.status).toBe(200);
    }
    ports.clock.advance(2 * DAY);
    await ports.scheduler.tick(BLOSSOM_TIERING_JOB);
    expect((await cold.list()).items).toHaveLength(2);
    for (let i = 0; i < 5; i++) await ports.scheduler.tick(BLOSSOM_TIERING_JOB);
    expect((await cold.list()).items).toHaveLength(5);
  });

  test('promote back on access', async () => {
    const s = await setup({ modules: tiered(1, { promoteOnAccess: true }) });
    const data = enc('come back');
    expect((await upload(s, makeKey(), data)).status).toBe(200);
    s.ports.clock.advance(2 * DAY);
    await s.ports.scheduler.tick(BLOSSOM_TIERING_JOB);
    expect(await s.cold!.head(hashOf(data))).not.toBeNull();
    expect(await (await s.req(`/${hashOf(data)}`)).text()).toBe('come back');
    await s.svc.settled();
    expect(await s.hot.head(hashOf(data))).not.toBeNull();
    expect(await s.cold!.head(hashOf(data))).toBeNull();
  });

  test('per-tier caps: hot full → uploads go cold, or are refused with a plain message', async () => {
    const goCold = await setup({
      modules: {
        blossom: {
          tiers: { hot: { maxBytes: 30 }, cold: { store: { driver: 'memory' } } },
        },
      },
    });
    const key = makeKey();
    const first = enc('x'.repeat(25));
    const second = enc('y'.repeat(25));
    expect((await upload(goCold, key, first)).status).toBe(200);
    expect((await upload(goCold, key, second)).status).toBe(200);
    expect(await goCold.cold!.head(hashOf(second))).not.toBeNull();
    expect(await goCold.hot.head(hashOf(second))).toBeNull();

    const refuse = await setup({
      cold: null,
      modules: { blossom: { tiers: { hot: { maxBytes: 30 }, whenHotFull: 'refuse' } } },
    });
    expect((await upload(refuse, key, first)).status).toBe(200);
    const res = await upload(refuse, key, second);
    expect(res.status).toBe(507);
    expect(res.headers.get('x-reason')).toContain('storage is full');
    // BUD-06 pre-flight refuses early too.
    const pre = await refuse.req('/upload', {
      method: 'HEAD',
      headers: {
        authorization: authHeader(key, 'upload', { x: [hashOf(second)] }),
        'x-sha-256': hashOf(second),
        'x-content-length': String(second.length),
      },
    });
    expect(pre.status).toBe(507);
  });

  test('health check and card at 80% / 95%', async () => {
    const s = await setup({
      modules: {
        blossom: { tiers: { hot: { maxBytes: 100 }, cold: { store: { driver: 'memory' } } } },
      },
    });
    const key = makeKey();
    expect((await upload(s, key, enc('z'.repeat(85)))).status).toBe(200);
    await s.run('media.run-tiering', {}, s.nodeCtx);
    const check = s.kernel.health.find((h) => h.id === 'blossom.tiers');
    const r = await check!.run(null);
    expect(r.status).toBe('warn');
    expect(r.message).toBe('Main storage is 85% full');
    const cards = await s.kernel.cards.find((c) => c.id === 'blossom.tiers')!.cards(null);
    expect(cards[0]?.title).toBe('Main storage is 85% full');
    expect(cards[0]?.primary?.actionId).toBe('media.run-tiering');
    expect((await upload(s, key, enc('q'.repeat(12)))).status).toBe(200);
    expect((await check!.run(null)).status).toBe('critical');
  });
});

describe('quarantine review', () => {
  test('list hides abuse matches, release makes it servable, undo re-quarantines', async () => {
    const s = await setup({ cold: null });
    const key = makeKey();
    const ok = enc('held by a rule');
    const bad = enc('abuse match');
    expect((await upload(s, key, ok)).status).toBe(200);
    expect((await upload(s, key, bad)).status).toBe(200);
    await s.svc.quarantine('main', hashOf(ok), 'Held for review', 'plugin:keyword-filter');
    await s.svc.quarantine('main', hashOf(bad), 'Matched a known-abuse image list', 'media.scan');

    const list = (await s.run('media.list-quarantine', {})).output as {
      items: Array<{
        sha256: string;
        abuse: boolean;
        reason: string;
        uploader: string;
        previewable: boolean;
      }>;
    };
    expect(list.items).toHaveLength(2);
    const abuse = list.items.find((i) => i.sha256 === hashOf(bad));
    expect(abuse).toMatchObject({
      abuse: true,
      reason: 'Matched a known-abuse list',
      previewable: false,
    });
    expect(list.items.find((i) => i.sha256 === hashOf(ok))).toMatchObject({
      abuse: false,
      uploader: key.pk,
    });
    await expect(s.run('media.quarantine-preview', { sha256: hashOf(bad) })).rejects.toThrow(
      'never shown',
    );

    expect((await s.req(`/${hashOf(ok)}`)).status).toBe(403);
    const rel = s.kernel.actions.get('media.release-quarantine')!;
    const input = rel.input.parse({ sha256: hashOf(ok), note: 'false alarm' });
    expect((await rel.preview!(input, s.ctx))[0]?.text).toContain('available to everyone again');
    expect(
      (await rel.preview!(rel.input.parse({ sha256: hashOf(bad) }), s.ctx)).some(
        (l) => l.kind === 'warning',
      ),
    ).toBe(true);
    const r = await rel.run(input, s.ctx);
    expect((await s.req(`/${hashOf(ok)}`)).status).toBe(200);
    await rel.undo!(r.undo!.payload, s.ctx);
    expect((await s.req(`/${hashOf(ok)}`)).status).toBe(403);
  });

  test('confirm deletes for good, blocks re-uploads, notifies for abuse matches', async () => {
    const s = await setup({ cold: null });
    const notes: string[] = [];
    s.kernel.setNotifier(async (n) => {
      notes.push(`${n.category}:${n.title}`);
    });
    const key = makeKey();
    const bad = enc('abuse bytes');
    expect((await upload(s, key, bad)).status).toBe(200);
    await s.svc.quarantine('main', hashOf(bad), 'Matched a known-abuse image list', 'media.scan');
    const conf = s.kernel.actions.get('media.confirm-quarantine')!;
    const input = conf.input.parse({ sha256: hashOf(bad) });
    const preview = await conf.preview!(input, s.ctx);
    expect(preview.at(-1)?.text).toBe('This cannot be undone.');
    const r = await conf.run(input, s.ctx);
    expect(r.undo).toBeUndefined();
    expect(r.output).toMatchObject({ removed: 1, erased: true, blocked: true });
    expect(await s.hot.head(hashOf(bad))).toBeNull();
    expect(await s.ports.docs.get(BLOCKED, hashOf(bad))).toMatchObject({ abuse: true });
    expect(await s.ports.docs.get(QUARANTINE, hashOf(bad))).toBeNull();
    expect(notes).toEqual(['safety:A blocked image was deleted for good']);
    const again = await upload(s, makeKey(), bad);
    expect(again.status).toBe(403);
    expect(again.headers.get('x-reason')).toBe('This file is not allowed on this server');
  });

  test('confirm keeps bytes under legal hold', async () => {
    const holds = new Set<string>();
    const s = await setup({ cold: null, holds });
    const data = enc('held evidence');
    expect((await upload(s, makeKey(), data)).status).toBe(200);
    await s.svc.quarantine('main', hashOf(data), 'Held for review', 'plugin:x');
    holds.add(hashOf(data));
    const conf = s.kernel.actions.get('media.confirm-quarantine')!;
    const input = conf.input.parse({ sha256: hashOf(data) });
    expect((await conf.preview!(input, s.ctx)).some((l) => l.text.includes('legal hold'))).toBe(
      true,
    );
    await conf.run(input, s.ctx);
    expect(await s.hot.head(hashOf(data))).not.toBeNull();
    expect((await s.req(`/${hashOf(data)}`)).status).toBe(404);
  });
});

describe('cleanup status', () => {
  test('reports last run, freed bytes and next run', async () => {
    const s = await setup({ cold: null });
    let st = (await s.run('media.cleanup-status', {}, s.nodeCtx)).output as {
      lastRun: number | null;
    };
    expect(st.lastRun).toBeNull();
    const data = enc('orphan bytes');
    await s.hot.put({ sha256: hashOf(data), size: data.length, type: 'text/plain' }, data);
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    const out = (await s.run('media.cleanup-status', {}, s.nodeCtx)).output as {
      lastRun: number;
      nextRun: number;
      freedBytes: number;
      erased: number;
      orphans: number;
    };
    st = out;
    expect(out.lastRun).toBe(s.ports.clock.now());
    expect(out.nextRun).toBe(out.lastRun + 3600);
    expect(out.freedBytes).toBe(data.length);
    expect(out.erased).toBe(1);
    expect(out.orphans).toBe(0);
  });
});

describe('BUD-03 server lists', () => {
  test('missing blob with an author hint redirects to their next server', async () => {
    const s = await setup({ cold: null });
    const key = makeKey();
    const list = makeEvent(key, {
      kind: 10063,
      tags: [
        ['server', `https://${HOST}`],
        ['server', 'https://cdn.example.org/'],
      ],
    });
    await s.ports.events.save('main', list);
    const sha = hashOf(enc('elsewhere'));
    const res = await s.req(`/${sha}.png?as=${key.pk}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://cdn.example.org/${sha}.png`);
    // Without a hint: plain 404.
    expect((await s.req(`/${sha}.png`)).status).toBe(404);
    // Unknown author: 404.
    expect((await s.req(`/${sha}?as=${'e'.repeat(64)}`)).status).toBe(404);
  });
});
