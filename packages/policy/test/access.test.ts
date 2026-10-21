// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type NostrEvent, createKernel, parseConfig } from '@beamhop/core';
import { type TestKey, makeKey, memoryPorts } from '@beamhop/testkit';
import { type PolicyService, policyModule } from '../src/index.ts';
import { computeWot, followListsFromEvents } from '../src/wot.ts';
import { follows, setup } from './helpers.ts';

const OPEN_GOALS = { openness: 100, spamTolerance: 100 };

describe('multi-node cache invalidation', () => {
  test('a ban on one node is seen by another node sharing DocStore + PubSub', async () => {
    const a = memoryPorts();
    const b = memoryPorts({ docs: a.docs, pubsub: a.pubsub, events: a.events });
    const config = parseConfig({
      relays: [{ id: 'main', hosts: ['x'], goals: { openness: 100 } }],
    });
    const boot = (ports: ReturnType<typeof memoryPorts>) =>
      createKernel({ runtime: 'test', ports, config, modules: [policyModule] });
    const [ka, kb] = await Promise.all([boot(a), boot(b)]);
    const spammer = makeKey();
    const e = follows(spammer, []);
    const ctx = { relayId: 'main', now: a.clock.now() };
    expect((await kb.policy.run('onEvent', [e, ctx])).action).toBe('accept'); // warms b's cache
    await (ka.use<PolicyService>('policy') as PolicyService).state.ban('main', {
      pubkey: spammer.pk,
      at: 0,
      by: 'x',
    });
    expect(await kb.policy.run('onEvent', [e, ctx])).toMatchObject({ by: 'policy.banned' });
  });
});

describe('allowlist mode', () => {
  test('owner and members can post; others are restricted', async () => {
    const owner = makeKey();
    const { run, ev, act } = await setup({
      goals: OPEN_GOALS,
      info: { pubkey: owner.pk },
      access: { mode: 'allowlist' },
    });
    const member = makeKey();
    const stranger = makeKey();
    expect((await run(ev(owner))).action).toBe('accept');
    expect(await run(ev(stranger))).toMatchObject({ prefix: 'restricted', by: 'policy.access' });
    const { preview, undo } = await act('access.add-allowlist', { pubkeys: [member.pk] });
    expect(preview[0]?.text).toBe('1 person will be added as members');
    expect((await run(ev(member))).action).toBe('accept');
    await undo();
    expect((await run(ev(member))).action).toBe('reject');
  });

  test('remove-allowlist and undo', async () => {
    const { run, ev, act } = await setup({ goals: OPEN_GOALS, access: { mode: 'allowlist' } });
    const m = makeKey();
    await act('access.add-allowlist', { pubkeys: [m.pk], note: 'team' });
    const { undo } = await act('access.remove-allowlist', { pubkeys: [m.pk] });
    expect((await run(ev(m))).action).toBe('reject');
    await undo();
    expect((await run(ev(m))).action).toBe('accept');
  });

  test('open relays ignore the allowlist', async () => {
    const { run, ev } = await setup({ goals: OPEN_GOALS });
    expect((await run(ev(makeKey()))).action).toBe('accept');
  });

  test('another module resolver earlier in the chain can decide', async () => {
    const { run, ev, kernel } = await setup({ goals: OPEN_GOALS, access: { mode: 'allowlist' } });
    const k = makeKey();
    kernel.access.unshift({ id: 'enterprise.binding', canWrite: async () => true });
    expect((await run(ev(k))).action).toBe('accept');
  });
});

describe('invites', () => {
  test('codes expire and have a use limit', async () => {
    const { act, svc, ports, run, ev } = await setup({
      goals: OPEN_GOALS,
      access: { mode: 'allowlist' },
    });
    const { result } = await act('access.create-invite', { expiresInHours: 1, maxUses: 2 });
    const { code } = result.output as { code: string };
    const [a, b, c] = [makeKey(), makeKey(), makeKey()];
    expect(await svc.redeemInvite('main', code, a.pk)).toMatchObject({ ok: true });
    expect((await run(ev(a))).action).toBe('accept');
    // redeeming twice by the same person does not use up the invite
    expect(await svc.redeemInvite('main', code, a.pk)).toMatchObject({ ok: true });
    expect(await svc.redeemInvite('main', code, b.pk)).toMatchObject({ ok: true });
    expect(await svc.redeemInvite('main', code, c.pk)).toEqual({ ok: false, reason: 'used-up' });
    expect(await svc.redeemInvite('main', 'nope', c.pk)).toEqual({ ok: false, reason: 'unknown' });
    const { result: r2 } = await act('access.create-invite', { expiresInHours: 1 });
    ports.clock.advance(3601);
    expect(await svc.redeemInvite('main', (r2.output as { code: string }).code, c.pk)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const entry = await svc.state.getAllow('main', a.pk);
    expect(entry).toMatchObject({ via: 'invite', invite: code });
  });

  test('undo deletes the invite', async () => {
    const { act, svc } = await setup({ access: { mode: 'allowlist' } });
    const { result, undo } = await act('access.create-invite', {});
    await undo();
    expect(
      await svc.redeemInvite('main', (result.output as { code: string }).code, makeKey().pk),
    ).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('tiers', () => {
  const tiers = [
    { id: 'default', name: 'Default' },
    { id: 'plus', name: 'Plus', eventsPerMinute: 500 },
    { id: 'pro', name: 'Pro' },
  ];

  test('explicit > rules > default', async () => {
    const k = makeKey();
    const { svc, act } = await setup(
      { tiers, access: { mode: 'allowlist' } },
      { tierRules: [{ tier: 'plus', when: { allowlisted: true } }] },
    );
    expect(await svc.resolveTier('main', k.pk)).toBe('default');
    await act('access.add-allowlist', { pubkeys: [k.pk] });
    expect(await svc.resolveTier('main', k.pk)).toBe('plus');
    const { preview, undo } = await act('users.set-tier', { pubkey: k.pk, tier: 'pro' });
    expect(preview[0]?.text).toContain('from Plus to Pro');
    expect(await svc.resolveTier('main', k.pk)).toBe('pro');
    await undo();
    expect(await svc.resolveTier('main', k.pk)).toBe('plus');
    await act('users.set-tier', { pubkey: k.pk, tier: null });
    expect(await svc.resolveTier('main', k.pk)).toBe('plus');
  });

  test('unknown tiers are refused', async () => {
    const { act } = await setup({ tiers });
    await expect(act('users.set-tier', { pubkey: makeKey().pk, tier: 'gold' })).rejects.toThrow(
      'unknown tier',
    );
  });

  test('WoT depth rule and limits per tier', async () => {
    const owner = makeKey();
    const friend = makeKey();
    const { svc, ports, kernel, run, ev } = await setup(
      {
        tiers,
        goals: OPEN_GOALS,
        info: { pubkey: owner.pk },
        access: { mode: 'wot', wot: { depth: 1 } },
      },
      { tierRules: [{ tier: 'plus', when: { wotDepthAtMost: 1 } }] },
    );
    await ports.events.save('main', follows(owner, [friend.pk]));
    await svc.refreshWot('main');
    expect(await svc.resolveTier('main', friend.pk)).toBe('plus');
    expect(await svc.resolveTier('main', makeKey().pk)).toBe('default');
    const ctx = { relayId: 'main', now: ports.clock.now() } as {
      relayId: string;
      now: number;
      tier?: string;
    };
    await kernel.policy.run('onEvent', [ev(friend), ctx]);
    expect(ctx.tier).toBe('plus');
    expect(kernel.limits('main', ctx.tier).eventsPerMinute).toBe(500);
    expect((await run(ev(friend))).action).toBe('accept');
  });
});

describe('web of trust', () => {
  /** Synthetic graph: map of key → followed keys. */
  function graph(edges: Array<[TestKey, TestKey[]]>): NostrEvent[] {
    return edges.map(([from, to]) =>
      follows(
        from,
        to.map((t) => t.pk),
      ),
    );
  }
  const loader = (events: NostrEvent[]) => {
    const lists = followListsFromEvents(events);
    let calls = 0;
    const fn = async (authors: string[]) => {
      calls++;
      return new Map(authors.filter((a) => lists.has(a)).map((a) => [a, lists.get(a) as string[]]));
    };
    return { fn, calls: () => calls };
  };

  test('BFS respects depth and minFollowers', async () => {
    const [o, a, b, c, d, e, f] = [
      makeKey(),
      makeKey(),
      makeKey(),
      makeKey(),
      makeKey(),
      makeKey(),
      makeKey(),
    ];
    // o → a, b ; a → c, d ; b → c ; c → e ; d → f
    const evs = graph([
      [o, [a, b]],
      [a, [c, d]],
      [b, [c]],
      [c, [e]],
      [d, [f]],
    ]);
    const l = loader(evs);
    const g1 = await computeWot(
      'r',
      { roots: [o.pk], depth: 1, minFollowers: 5, maxMembers: 100 },
      l.fn,
      0,
    );
    expect(Object.keys(g1.members).sort()).toEqual([o.pk, a.pk, b.pk].sort());
    const g2 = await computeWot(
      'r',
      { roots: [o.pk], depth: 2, minFollowers: 2, maxMembers: 100 },
      l.fn,
      0,
    );
    expect(g2.members[c.pk]).toEqual({ depth: 2, followers: 2 });
    expect(g2.members[d.pk]).toBeUndefined(); // only one trusted follower
    const g3 = await computeWot(
      'r',
      { roots: [o.pk], depth: 3, minFollowers: 1, maxMembers: 100 },
      l.fn,
      0,
    );
    expect(g3.members[e.pk]?.depth).toBe(3);
    expect(g3.members[f.pk]?.depth).toBe(3);
    expect(g3.members[o.pk]).toEqual({ depth: 0, followers: 0 });
  });

  test('seeds are roots; cycles terminate; maxMembers truncates', async () => {
    const [o, s, a, b] = [makeKey(), makeKey(), makeKey(), makeKey()];
    const evs = graph([
      [o, [a]],
      [a, [o, b]],
      [b, [a]],
      [s, [b]],
    ]);
    const l = loader(evs);
    const g = await computeWot(
      'r',
      { roots: [o.pk, s.pk], depth: 3, minFollowers: 1, maxMembers: 100 },
      l.fn,
      0,
    );
    expect(g.members[b.pk]?.depth).toBe(1); // followed by seed directly
    expect(Object.keys(g.members).length).toBe(4);
    const t = await computeWot(
      'r',
      { roots: [o.pk, s.pk], depth: 3, minFollowers: 1, maxMembers: 3 },
      l.fn,
      0,
    );
    expect(t.truncated).toBe(true);
    expect(Object.keys(t.members).length).toBe(3);
  });

  test('followListsFromEvents keeps only the newest list per author', () => {
    const k = makeKey();
    const x = makeKey();
    const y = makeKey();
    const lists = followListsFromEvents([
      follows(k, [x.pk], 10),
      follows(k, [y.pk, 'bad', k.pk], 20),
    ]);
    expect(lists.get(k.pk)).toEqual([y.pk]);
  });

  test('module: members can post, strangers cannot; cache + scheduled refresh', async () => {
    const owner = makeKey();
    const a = makeKey();
    const b = makeKey();
    const c = makeKey();
    const { run, ev, ports, svc } = await setup({
      goals: OPEN_GOALS,
      info: { pubkey: owner.pk },
      access: { mode: 'wot', wot: { depth: 2, minFollowers: 1, refreshMinutes: 60 } },
    });
    await ports.events.save('main', follows(owner, [a.pk]));
    await ports.events.save('main', follows(a, [b.pk]));
    expect((await run(ev(owner))).action).toBe('accept');
    expect((await run(ev(a))).action).toBe('accept');
    expect((await run(ev(b))).action).toBe('accept');
    expect(await run(ev(c))).toMatchObject({ prefix: 'restricted', by: 'policy.access' });
    expect((await run(ev(c))).action === 'reject' && (await run(ev(c)))).toMatchObject({
      message: 'only people trusted by this community can post here',
    });
    // graph persisted in DocStore
    const stored = await ports.docs.get<{ members: Record<string, unknown> }>('policy.wot', 'main');
    expect(Object.keys(stored?.members ?? {})).toContain(b.pk);
    // new follow → visible after the scheduled refresh
    await ports.events.save('main', follows(a, [b.pk, c.pk], 1_700_000_100));
    expect((await run(ev(c))).action).toBe('reject');
    expect(ports.scheduler.jobs.get('policy.wot:main')?.interval).toBe(3600);
    await ports.scheduler.tick('policy.wot:main');
    expect((await run(ev(c))).action).toBe('accept');
    expect(await svc.wotMember('main', c.pk)).toEqual({ depth: 2, followers: 1 });
  });

  test('module: allowlisted people pass in WoT mode too', async () => {
    const owner = makeKey();
    const { run, ev, act } = await setup({
      goals: OPEN_GOALS,
      info: { pubkey: owner.pk },
      access: { mode: 'wot' },
    });
    const k = makeKey();
    expect((await run(ev(k))).action).toBe('reject');
    await act('access.add-allowlist', { pubkeys: [k.pk] });
    expect((await run(ev(k))).action).toBe('accept');
  });

  test('upstream fetcher contributes verified follow lists', async () => {
    const owner = makeKey();
    const a = makeKey();
    const forged = { ...follows(a, [makeKey().pk]), sig: 'f'.repeat(128) };
    const other = makeKey();
    const { svc } = await setup(
      { info: { pubkey: owner.pk }, access: { mode: 'wot', wot: { depth: 2 } } },
      {},
      {
        fetchFollowLists: async (authors) =>
          [follows(owner, [a.pk]), forged, follows(other, [owner.pk])].filter((e) =>
            authors.includes(e.pubkey),
          ),
      },
    );
    const g = await svc.refreshWot('main');
    expect(g?.members[a.pk]).toEqual({ depth: 1, followers: 1 });
    expect(Object.keys(g?.members ?? {}).length).toBe(2);
  });

  test('a cached graph is reused across restarts unless parameters changed', async () => {
    const owner = makeKey();
    const a = makeKey();
    const env = await setup({
      info: { pubkey: owner.pk },
      access: { mode: 'wot', wot: { depth: 1 } },
    });
    await env.ports.events.save('main', follows(owner, [a.pk]));
    await env.svc.refreshWot('main');
    // "Restart": a new kernel sharing only the DocStore (event store is empty).
    const relay = { id: 'main', hosts: ['x'], info: { pubkey: owner.pk } };
    const boot = async (wot: Record<string, unknown>) => {
      const kernel = await createKernel({
        runtime: 'test',
        ports: memoryPorts({ docs: env.ports.docs }),
        config: parseConfig({ relays: [{ ...relay, access: { mode: 'wot', wot } }] }),
        modules: [policyModule],
      });
      return kernel.use<PolicyService>('policy') as PolicyService;
    };
    expect(await (await boot({ depth: 1 })).wotMember('main', a.pk)).toEqual({
      depth: 1,
      followers: 1,
    });
    // different parameters → recomputed from the (empty) local store
    expect(await (await boot({ depth: 2 })).wotMember('main', a.pk)).toBeUndefined();
  });
});
