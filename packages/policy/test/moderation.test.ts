// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type BeamhopConfig, type NostrEvent, finalizeEvent } from '@beamhop/core';
import { type TestKey, makeKey } from '@beamhop/testkit';
import { parseReport } from '../src/moderation.ts';
import { setup } from './helpers.ts';

const GOALS = { goals: { openness: 100, spamTolerance: 100 } };

function report(
  reporter: TestKey,
  target: { e?: string; p?: string; x?: string },
  type = 'spam',
  at = 1_700_000_000,
): NostrEvent {
  const tags: string[][] = [];
  if (target.e) tags.push(['e', target.e, type]);
  if (target.p) tags.push(['p', target.p, target.e ? '' : type]);
  if (target.x) tags.push(['x', target.x, type]);
  return finalizeEvent({ kind: 1984, tags, content: 'please look', created_at: at }, reporter.sk);
}

describe('NIP-56 parsing', () => {
  test('subjects and types', () => {
    const k = makeKey();
    const id = 'a'.repeat(64);
    expect(parseReport(report(k, { e: id, p: k.pk }, 'nudity'))).toMatchObject({
      eventId: id,
      pubkey: k.pk,
      type: 'nudity',
    });
    expect(parseReport(report(k, { p: k.pk }, 'weird'))).toMatchObject({ type: 'other' });
    expect(parseReport({ ...report(k, { p: k.pk }), kind: 1 })).toBeUndefined();
    expect(
      parseReport(finalizeEvent({ kind: 1984, tags: [], content: '', created_at: 1 }, k.sk)),
    ).toBeUndefined();
  });
});

describe('queue intake from the bus', () => {
  test('reports merge per subject; same reporter counted once', async () => {
    const { kernel, svc, ports } = await setup(GOALS);
    const author = makeKey();
    const post = finalizeEvent({ kind: 1, tags: [], content: 'bad', created_at: 1 }, author.sk);
    await ports.events.save('main', post);
    const [r1, r2] = [makeKey(), makeKey()];
    kernel.bus.emit('report.received', {
      relayId: 'main',
      report: report(r1, { e: post.id, p: author.pk }),
    });
    await svc.idle();
    kernel.bus.emit('report.received', {
      relayId: 'main',
      report: report(r1, { e: post.id, p: author.pk }, 'spam', 2),
    });
    kernel.bus.emit('report.received', {
      relayId: 'main',
      report: report(r2, { e: post.id, p: author.pk }),
    });
    await svc.idle();
    const items = await svc.queue.list('main', { status: 'pending' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'report',
      batchKey: 'report:spam',
      eventId: post.id,
      pubkey: author.pk,
      reason: 'A post was reported for spam',
    });
    expect(items[0]?.reports).toHaveLength(2);
    expect(items[0]?.event?.id).toBe(post.id);
  });

  test('held events and quarantined blobs become items', async () => {
    const { kernel, svc, ev } = await setup(GOALS);
    const e = ev(makeKey());
    kernel.bus.emit('event.held', {
      relayId: 'main',
      event: e,
      by: 'policy.duplicate',
      reason: 'copy',
    });
    kernel.bus.emit('blob.quarantined', {
      relayId: 'main',
      sha256: 'b'.repeat(64),
      reason: 'hash list match',
    });
    await svc.idle();
    const items = await svc.queue.list('main');
    expect(items.map((i) => i.type).sort()).toEqual(['blob', 'event']);
    expect(items.find((i) => i.type === 'event')?.batchKey).toBe('held:policy.duplicate');
  });
});

describe('moderation actions', () => {
  test('keep: held post becomes visible; undo hides it again', async () => {
    const { kernel, svc, ev, act, ports } = await setup(GOALS);
    const e = ev(makeKey());
    kernel.bus.emit('event.held', { relayId: 'main', event: e, by: 'policy.duplicate' });
    await svc.idle();
    const { preview, result, undo } = await act('moderation.keep', { itemIds: [`held-${e.id}`] });
    expect(preview[0]?.text).toBe('This held post will become visible');
    expect(result.undo?.expiresAt).toBe(ports.clock.now() + 300);
    expect(await ports.events.getById('main', e.id)).not.toBeNull();
    expect((await svc.queue.get('main', `held-${e.id}`))?.status).toBe('kept');
    await undo();
    expect(await ports.events.getById('main', e.id)).toBeNull();
    expect((await svc.queue.get('main', `held-${e.id}`))?.status).toBe('pending');
  });

  test('remove is soft: recycle bin, re-publish refused, undo and restore work', async () => {
    const { kernel, svc, act, ports, run } = await setup(GOALS);
    const author = makeKey();
    const post = finalizeEvent(
      { kind: 1, tags: [], content: 'spam!', created_at: ports.clock.now() },
      author.sk,
    );
    await ports.events.save('main', post);
    const deleted: string[][] = [];
    kernel.bus.on('event.deleted', (p) => deleted.push(p.ids));
    kernel.bus.emit('report.received', {
      relayId: 'main',
      report: report(makeKey(), { e: post.id }),
    });
    await svc.idle();
    const itemId = `report-e-${post.id}`;
    const { preview, undo } = await act('moderation.remove', { itemIds: [itemId], reason: 'spam' });
    expect(preview[0]?.text).toBe('1 post will be hidden (restorable for 30 days)');
    expect(await ports.events.getById('main', post.id)).toBeNull();
    expect(deleted).toEqual([[post.id]]);
    expect(await run(post)).toMatchObject({ by: 'policy.recycled' });
    const bin = await act('moderation.recycle-bin', {});
    expect((bin.result.output as { items: unknown[] }).items).toHaveLength(1);
    await undo();
    expect(await ports.events.getById('main', post.id)).not.toBeNull();
    expect((await svc.queue.get('main', itemId))?.status).toBe('pending');
    // remove by event id, then restore via action (and undo the restore)
    await act('moderation.remove', { eventIds: [post.id] });
    const restored = await act('moderation.restore', { ids: [post.id] });
    expect(restored.result.output).toMatchObject({ restored: [post.id], failed: [] });
    expect(await ports.events.getById('main', post.id)).not.toBeNull();
    await restored.undo();
    expect(await ports.events.getById('main', post.id)).toBeNull();
    expect(await svc.state.isRecycled('main', post.id)).toBe(true);
  });

  test('purge after 30 days is permanent and blocks re-publishing', async () => {
    const { svc, act, ports, run } = await setup(GOALS);
    const k = makeKey();
    const post = finalizeEvent(
      { kind: 1, tags: [], content: 'x', created_at: ports.clock.now() },
      k.sk,
    );
    await ports.events.save('main', post);
    await act('moderation.remove', { eventIds: [post.id] });
    await ports.scheduler.tick('policy.recycle-purge');
    expect(await svc.state.isRecycled('main', post.id)).toBe(true);
    ports.clock.advance(30 * 86400 + 1);
    await ports.scheduler.tick('policy.recycle-purge');
    expect(await svc.state.isRecycled('main', post.id)).toBe(false);
    expect((await ports.events.save('main', post)).status).toBe('deleted');
    expect(await ports.events.getById('main', post.id)).toBeNull();
    expect((await run(post)).action).toBe('accept'); // policy no longer blocks; store refuses
    const r = await act('moderation.restore', { ids: [post.id] });
    expect((r.result.output as { failed: unknown[] }).failed).toHaveLength(1);
  });

  test('legal hold freezes recycle-bin purge until released', async () => {
    let held = true;
    const holdsModule = {
      id: 'fake-holds',
      register(k: import('@beamhop/core').Kernel) {
        k.provide('lifecycle.holds', {
          active: () => true,
          isHeld: async (_r: string, s: { pubkey?: string }) => held && s.pubkey === author.pk,
        });
      },
    };
    const author = makeKey();
    const { svc, act, ports } = await setup(GOALS, {}, {}, [holdsModule]);
    const post = finalizeEvent(
      { kind: 1, tags: [], content: 'x', created_at: ports.clock.now() },
      author.sk,
    );
    await ports.events.save('main', post);
    await act('moderation.remove', { eventIds: [post.id] });
    ports.clock.advance(30 * 86400 + 1);
    expect(await svc.queue.purge(ports.clock.now())).toBe(0);
    expect(await svc.state.isRecycled('main', post.id)).toBe(true);
    held = false;
    expect(await svc.queue.purge(ports.clock.now())).toBe(1);
    expect(await svc.state.isRecycled('main', post.id)).toBe(false);
  });

  test('restore refuses events the author deleted (NIP-09)', async () => {
    const { act, ports } = await setup(GOALS);
    const k = makeKey();
    const post = finalizeEvent({ kind: 1, tags: [], content: 'x', created_at: 10 }, k.sk);
    await ports.events.save('main', post);
    await act('moderation.remove', { eventIds: [post.id] });
    // author deletes it meanwhile: store tombstones the id once it holds it
    await ports.events.save('main', post);
    await ports.events.applyDeletion(
      'main',
      finalizeEvent({ kind: 5, tags: [['e', post.id]], content: '', created_at: 11 }, k.sk),
    );
    const r = await act('moderation.restore', { ids: [post.id] });
    expect(r.result.output).toMatchObject({
      failed: [{ id: post.id, reason: 'deleted by its author' }],
    });
  });

  test('blob removal stops serving; purge drops owners', async () => {
    const { kernel, svc, act, ports, ctx } = await setup(GOALS);
    const sha = 'c'.repeat(64);
    const owner = makeKey().pk;
    await ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: owner,
      size: 1,
      type: 'image/png',
      uploadedAt: 0,
    });
    kernel.bus.emit('blob.quarantined', { relayId: 'main', sha256: sha, reason: 'match' });
    await svc.idle();
    const deleted: string[] = [];
    kernel.bus.on('blob.deleted', (p) => deleted.push(p.sha256));
    const { preview } = await act('moderation.remove', { itemIds: [`blob-${sha}`] });
    expect(preview[0]?.text).toContain('1 file will stop being served');
    expect(await kernel.policy.run('onBlobServe', [sha, ctx()])).toMatchObject({
      action: 'reject',
    });
    expect(await ports.blobIndex.owners('main', sha)).toHaveLength(1);
    ports.clock.advance(31 * 86400);
    await svc.purgeRecycleBin();
    expect(await ports.blobIndex.owners('main', sha)).toHaveLength(0);
    expect(deleted).toEqual([sha]);
  });

  test('ban with removeRecent, then undo restores everything', async () => {
    const { act, ports, run, ev, svc } = await setup(GOALS);
    const spammer = makeKey();
    const posts = [ev(spammer), ev(spammer), ev(spammer)];
    for (const p of posts) await ports.events.save('main', p);
    const { preview, result, undo } = await act('moderation.ban-pubkey', {
      pubkeys: [spammer.pk],
      reason: 'spam',
      removeRecent: true,
    });
    expect(preview[0]?.text).toBe('1 account will be blocked');
    expect(preview[1]?.text).toContain('Their posts (up to 3)');
    expect(result.summary).toBe('Blocked 1 account and hid 3 posts');
    expect(await run(ev(spammer))).toMatchObject({ by: 'policy.banned' });
    expect(await ports.events.count('main', [{ authors: [spammer.pk] }])).toBe(0);
    await undo();
    expect((await run(ev(spammer))).action).toBe('accept');
    expect(await ports.events.count('main', [{ authors: [spammer.pk] }])).toBe(3);
    expect(await svc.state.listBans('main')).toHaveLength(0);
  });

  test('owner cannot be banned or muted', async () => {
    const owner = makeKey();
    const { act, svc } = await setup({ ...GOALS, info: { pubkey: owner.pk } });
    const { preview } = await act('moderation.ban-pubkey', { pubkeys: [owner.pk] });
    expect(preview.some((l) => l.kind === 'warning')).toBe(true);
    expect(await svc.state.isBanned('main', owner.pk)).toBe(false);
    await act('moderation.mute-pubkey', { pubkeys: [owner.pk] });
    expect(await svc.state.getMute('main', owner.pk)).toBeUndefined();
  });

  test('unban / mute / unmute with undo', async () => {
    const { act, run, ev } = await setup(GOALS);
    const k = makeKey();
    await act('moderation.ban-pubkey', { pubkeys: [k.pk] });
    const unban = await act('moderation.unban-pubkey', { pubkeys: [k.pk] });
    expect((await run(ev(k))).action).toBe('accept');
    await unban.undo();
    expect((await run(ev(k))).action).toBe('reject');
    await act('moderation.unban-pubkey', { pubkeys: [k.pk] });

    const mute = await act('moderation.mute-pubkey', { pubkeys: [k.pk], hours: 2 });
    expect(mute.preview[0]?.text).toBe('1 account will be muted for 2 hours');
    expect((await run(ev(k))).action).toBe('shadow');
    await mute.undo();
    expect((await run(ev(k))).action).toBe('accept');
    await act('moderation.mute-pubkey', { pubkeys: [k.pk] });
    const unmute = await act('moderation.unmute-pubkey', { pubkeys: [k.pk] });
    expect((await run(ev(k))).action).toBe('accept');
    await unmute.undo();
    expect((await run(ev(k))).action).toBe('shadow');
  });

  test('queue action lists by status and batch', async () => {
    const { kernel, svc, act } = await setup(GOALS);
    for (let i = 0; i < 3; i++)
      kernel.bus.emit('report.received', {
        relayId: 'main',
        report: report(makeKey(), { p: makeKey().pk }, 'impersonation'),
      });
    await svc.idle();
    const { result } = await act('moderation.queue', {
      batchKey: 'report:impersonation',
      limit: 2,
    });
    expect(result.output).toMatchObject({ total: 3 });
    expect((result.output as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('cards and health', () => {
  test('reports are batched into one card; health reflects the backlog', async () => {
    const { kernel, svc, ports } = await setup(GOALS);
    const health = kernel.health.find((h) => h.id === 'policy.moderation-backlog');
    expect(await health?.run('main')).toMatchObject({ status: 'ok', score: 100 });
    for (let i = 0; i < 14; i++)
      kernel.bus.emit('report.received', {
        relayId: 'main',
        report: report(makeKey(), { p: makeKey().pk }),
      });
    await svc.idle();
    const cards = await kernel.cards.find((c) => c.id === 'policy.moderation')?.cards(null);
    expect(cards).toHaveLength(1);
    expect(cards?.[0]).toMatchObject({
      title: '14 reports to review',
      batchKey: 'report:spam',
      severity: 'warning',
      primary: { actionId: 'moderation.queue' },
    });
    expect(await health?.run(null)).toMatchObject({ status: 'ok', score: 90 });
    ports.clock.advance(49 * 3600);
    expect(await health?.run('main')).toMatchObject({ status: 'warn' });
    for (let i = 0; i < 100; i++)
      kernel.bus.emit('report.received', {
        relayId: 'main',
        report: report(makeKey(), { p: makeKey().pk }),
      });
    await svc.idle();
    expect(await health?.run('main')).toMatchObject({ status: 'critical' });
  });

  test('spam wave card suggests blocking new keys (never applied automatically)', async () => {
    const { kernel, svc, run, ev, act } = await setup(
      { goals: { openness: 100, spamTolerance: 50 } },
      { spamWave: { minKeys: 5, windowMinutes: 30 } },
    );
    const keys = Array.from({ length: 6 }, makeKey);
    const text = 'Join the best crypto signals group today and earn more';
    await run(ev(makeKey(), { content: text }));
    for (const k of keys) await run(ev(k, { content: text }));
    await svc.idle();
    const cards = (await kernel.cards[0]?.cards('main')) ?? [];
    const wave = cards.find((c) => c.batchKey === 'spam-wave');
    expect(wave?.title).toBe('Spam wave from 6 new keys');
    const input = wave?.primary?.input as { pubkeys: string[] };
    expect(input.pubkeys.sort()).toEqual(keys.map((k) => k.pk).sort());
    // nothing was banned automatically
    expect(await svc.state.listBans('main')).toHaveLength(0);
    // approving the suggestion runs the normal action
    await act(wave?.primary?.actionId as string, input);
    expect(await svc.state.listBans('main')).toHaveLength(6);
  });
});

describe('config.apply-persona', () => {
  test('without admin.config: returns patch + diff, not committed', async () => {
    const { act, kernel } = await setup();
    const { preview, result } = await act('config.apply-persona', { persona: 'private-team' });
    expect(preview.some((l) => l.text.startsWith('Who can post'))).toBe(true);
    expect(result.output).toMatchObject({
      committed: false,
      relay: { access: { mode: 'allowlist' } },
    });
    expect(result.undo).toBeUndefined();
    expect(kernel.relay('main')?.access.mode).toBe('open');
  });

  test('with admin.config: commits and undo restores the previous relay config', async () => {
    const applied: string[] = [];
    const cfgModule = {
      id: 'admin-config-fake',
      register(k: Parameters<NonNullable<Parameters<typeof setup>[3]>[number]['register']>[0]) {
        k.provide('admin.config', {
          async apply(next: BeamhopConfig, meta: { summary: string }) {
            applied.push(meta.summary);
            await k.applyConfig(next);
          },
        });
      },
    };
    const { act, kernel } = await setup({}, {}, {}, [cfgModule]);
    const { result, undo } = await act('config.apply-persona', { persona: 'wot-community' });
    expect(result.output).toMatchObject({ committed: true });
    expect(kernel.relay('main')?.access.mode).toBe('wot');
    expect(kernel.relay('main')?.persona).toBe('wot-community');
    await undo();
    expect(kernel.relay('main')?.access.mode).toBe('open');
    expect(applied).toEqual(['Relay set up as Web-of-trust community', 'Undo relay type change']);
  });
});

describe('action registry hygiene', () => {
  test('every action has plain title, technical lens and permission; changes have preview + undo', async () => {
    const { kernel } = await setup();
    const ids = kernel.actions.list().map((a) => a.id);
    for (const id of [
      'moderation.keep',
      'moderation.remove',
      'moderation.restore',
      'moderation.ban-pubkey',
      'moderation.unban-pubkey',
      'moderation.mute-pubkey',
      'users.set-tier',
      'access.add-allowlist',
      'access.remove-allowlist',
      'access.create-invite',
      'config.apply-persona',
    ])
      expect(ids).toContain(id);
    for (const a of kernel.actions.list()) {
      expect(a.title.length).toBeGreaterThan(2);
      expect(a.technical?.length ?? 0).toBeGreaterThan(5);
      expect(a.title).not.toMatch(/NIP|kind \d/);
      if (!a.readOnly) {
        expect(typeof a.preview).toBe('function');
        expect(typeof a.undo).toBe('function');
      }
    }
  });

  test('explain-limits and stats are available as read-only actions', async () => {
    const { act } = await setup({ limits: { maxLimit: 9 } });
    const { result } = await act('policy.explain-limits', {});
    expect((result.output as { limits: { maxLimit: number } }).limits.maxLimit).toBe(9);
    const s = await act('policy.stats', {});
    expect(s.result.output).toMatchObject({ total: { rejected: 0 } });
  });
});
