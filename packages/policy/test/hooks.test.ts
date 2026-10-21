// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import { fakeConn, mine, setup } from './helpers.ts';

const OPEN = { goals: { openness: 100, spamTolerance: 100 } };

describe('hook registration', () => {
  test('hooks sit in the documented priority bands', async () => {
    const { kernel } = await setup();
    const byId = new Map(kernel.policy.list().map((h) => [h.id, h.priority]));
    for (const id of [
      'policy.recycled',
      'policy.banned',
      'policy.auth',
      'policy.access',
      'policy.mute',
    ])
      expect(byId.get(id)).toBeLessThan(100);
    for (const id of [
      'policy.rate-limit',
      'policy.event-size',
      'policy.kinds',
      'policy.created-at',
      'policy.pow',
      'policy.upload-limits',
    ]) {
      expect(byId.get(id)).toBeGreaterThanOrEqual(100);
      expect(byId.get(id)).toBeLessThan(200);
    }
    for (const id of ['policy.duplicate', 'policy.content']) {
      expect(byId.get(id)).toBeGreaterThanOrEqual(200);
      expect(byId.get(id)).toBeLessThan(300);
    }
  });
});

describe('banned / recycled / mute', () => {
  test('banned pubkeys are rejected for events, auth and uploads', async () => {
    const { kernel, svc, run, ev, ctx, ports } = await setup(OPEN);
    const k = makeKey();
    expect((await run(ev(k))).action).toBe('accept');
    await svc.state.ban('main', { pubkey: k.pk, at: ports.clock.now(), by: 'owner' });
    expect(await run(ev(k))).toMatchObject({
      action: 'reject',
      prefix: 'blocked',
      by: 'policy.banned',
    });
    expect(await kernel.policy.run('onAuth', [k.pk, ctx()])).toMatchObject({ action: 'reject' });
    const up = { sha256: 'a'.repeat(64), size: 10, type: 'image/png', pubkey: k.pk };
    expect(await kernel.policy.run('onUpload', [up, ctx()])).toMatchObject({ action: 'reject' });
  });

  test('static known-bad list applies', async () => {
    const k = makeKey();
    const { run, ev } = await setup(OPEN, { bannedPubkeys: [k.pk] });
    expect(await run(ev(k))).toMatchObject({ action: 'reject', by: 'policy.banned' });
  });

  test('recycled events and blobs are refused', async () => {
    const { kernel, svc, run, ev, ctx } = await setup(OPEN);
    const e = ev(makeKey());
    await svc.state.putRecycled('main', {
      id: e.id,
      type: 'event',
      event: e,
      removedAt: 0,
      purgeAt: 1e12,
      by: 'x',
    });
    expect(await run(e)).toMatchObject({ action: 'reject', by: 'policy.recycled' });
    const sha = 'b'.repeat(64);
    expect((await kernel.policy.run('onBlobServe', [sha, ctx()])).action).toBe('accept');
    await svc.state.putRecycled('main', {
      id: sha,
      type: 'blob',
      removedAt: 0,
      purgeAt: 1e12,
      by: 'x',
    });
    expect(await kernel.policy.run('onBlobServe', [sha, ctx()])).toMatchObject({
      action: 'reject',
    });
  });

  test('muted pubkeys are shadowed until the mute expires', async () => {
    const { svc, run, ev, ports } = await setup(OPEN);
    const k = makeKey();
    await svc.state.mute('main', { pubkey: k.pk, at: 0, by: 'x', until: ports.clock.now() + 60 });
    expect(await run(ev(k))).toMatchObject({ action: 'shadow', by: 'policy.mute' });
    ports.clock.advance(61);
    expect((await run(ev(k))).action).toBe('accept');
  });
});

describe('auth gating (NIP-42) and access', () => {
  test('write requires an authenticated author on the connection', async () => {
    const { run, ev } = await setup({ ...OPEN, access: { authRequired: { write: true } } });
    const k = makeKey();
    expect(await run(ev(k), { conn: fakeConn() })).toMatchObject({
      action: 'reject',
      prefix: 'auth-required',
    });
    expect(await run(ev(k), { conn: fakeConn('ip', [makeKey().pk]) })).toMatchObject({
      prefix: 'auth-required',
    });
    expect((await run(ev(k), { conn: fakeConn('ip', [k.pk]) })).action).toBe('accept');
    // Internal/HTTP paths without a connection are not gated here.
    expect((await run(ev(k))).action).toBe('accept');
  });

  test('read requires sign-in and membership in allowlist mode', async () => {
    const owner = makeKey();
    const { kernel, ctx, svc } = await setup({
      ...OPEN,
      info: { pubkey: owner.pk },
      access: { mode: 'allowlist', authRequired: { read: true } },
    });
    const req = (conn: ReturnType<typeof fakeConn>) =>
      kernel.policy.run('onReq', [[{ kinds: [1] }], ctx({ conn })]);
    expect(await req(fakeConn())).toMatchObject({ prefix: 'auth-required' });
    const stranger = makeKey();
    expect(await req(fakeConn('ip', [stranger.pk]))).toMatchObject({ prefix: 'restricted' });
    expect((await req(fakeConn('ip', [owner.pk]))).action).toBe('accept');
    await svc.state.allow('main', { pubkey: stranger.pk, addedAt: 0, by: 'x', via: 'admin' });
    expect((await req(fakeConn('ip2', [stranger.pk]))).action).toBe('accept');
  });

  test('open relay with read auth accepts any signed-in reader', async () => {
    const { kernel, ctx } = await setup({ ...OPEN, access: { authRequired: { read: true } } });
    const r = await kernel.policy.run('onReq', [
      [{}],
      ctx({ conn: fakeConn('ip', [makeKey().pk]) }),
    ]);
    expect(r.action).toBe('accept');
  });
});

describe('rate limits (token bucket)', () => {
  test('per pubkey: burst of eventsPerMinute, then refills over time', async () => {
    const { run, ev, ports } = await setup({
      goals: { openness: 100 },
      limits: { eventsPerMinute: 6 },
    });
    const k = makeKey();
    for (let i = 0; i < 6; i++) expect((await run(ev(k))).action).toBe('accept');
    expect(await run(ev(k))).toMatchObject({ prefix: 'rate-limited', by: 'policy.rate-limit' });
    ports.clock.advance(5); // 6/min → 0.5 token
    expect((await run(ev(k))).action).toBe('reject');
    ports.clock.advance(10); // +1 token
    expect((await run(ev(k))).action).toBe('accept');
    // other keys are unaffected
    expect((await run(ev(makeKey()))).action).toBe('accept');
  });

  test('dry runs do not consume tokens', async () => {
    const { run, ev } = await setup({ goals: { openness: 100 }, limits: { eventsPerMinute: 2 } });
    const k = makeKey();
    for (let i = 0; i < 5; i++) expect((await run(ev(k), { dryRun: true })).action).toBe('accept');
    expect((await run(ev(k))).action).toBe('accept');
    expect((await run(ev(k))).action).toBe('accept');
    expect((await run(ev(k))).action).toBe('reject');
  });

  test('per hashed IP across pubkeys', async () => {
    const { run, ev } = await setup(
      { goals: { openness: 100 }, limits: { eventsPerMinute: 3 } },
      { ipMultiplier: 1 },
    );
    const conn = fakeConn('same-ip');
    for (let i = 0; i < 3; i++) expect((await run(ev(makeKey()), { conn })).action).toBe('accept');
    expect(await run(ev(makeKey()), { conn })).toMatchObject({ prefix: 'rate-limited' });
    expect((await run(ev(makeKey()), { conn: fakeConn('other-ip') })).action).toBe('accept');
  });

  test('tier limits apply per pubkey and the owner is exempt', async () => {
    const owner = makeKey();
    const vip = makeKey();
    const { run, ev, svc } = await setup({
      goals: { openness: 0 },
      info: { pubkey: owner.pk },
      tiers: [
        { id: 'default', name: 'Default', eventsPerMinute: 1 },
        { id: 'plus', name: 'Plus', eventsPerMinute: 4 },
      ],
    });
    await svc.state.setTier('main', { pubkey: vip.pk, tier: 'plus', setAt: 0, by: 'x' });
    // vip has an explicit tier → not a new key → no PoW; default openness 0 needs minPow 12 though.
    for (let i = 0; i < 20; i++) expect((await run(ev(owner))).action).toBe('accept');
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await run(ev(vip))).by);
    expect(results.filter((b) => b === 'policy.rate-limit').length).toBe(1);
  });

  test('REQ rate limit per connection IP', async () => {
    const { kernel, ctx } = await setup({ goals: { openness: 100 }, limits: { reqPerMinute: 2 } });
    const conn = fakeConn('ip-req');
    const req = () => kernel.policy.run('onReq', [[{}], ctx({ conn })]);
    expect((await req()).action).toBe('accept');
    expect((await req()).action).toBe('accept');
    expect(await req()).toMatchObject({ prefix: 'rate-limited' });
  });
});

describe('size, kinds, created_at', () => {
  test('max event size counts UTF-8 bytes', async () => {
    const { run, ev } = await setup({ ...OPEN, limits: { maxEventBytes: 1000 } });
    const k = makeKey();
    expect((await run(ev(k, { content: 'a'.repeat(300) }))).action).toBe('accept');
    expect(await run(ev(k, { content: 'a'.repeat(1000) }))).toMatchObject({
      prefix: 'invalid',
      by: 'policy.event-size',
    });
    // 250 × 3-byte chars = 750 bytes + envelope > 1000
    expect(await run(ev(k, { content: '€'.repeat(250) }))).toMatchObject({
      by: 'policy.event-size',
    });
  });

  test('blocked and allowed kinds; deletions always allowed', async () => {
    const { run, ev } = await setup({
      ...OPEN,
      limits: { blockedKinds: [4], allowedKinds: [1, 4, 7] },
    });
    const k = makeKey();
    expect(await run(ev(k, { kind: 4 }))).toMatchObject({ prefix: 'blocked', by: 'policy.kinds' });
    expect(await run(ev(k, { kind: 30023 }))).toMatchObject({ by: 'policy.kinds' });
    expect((await run(ev(k, { kind: 7, content: '+' }))).action).toBe('accept');
    expect((await run(ev(k, { kind: 5, content: '' }))).action).toBe('accept');
  });

  test('created_at bounds', async () => {
    const { run, ev, ports } = await setup({
      ...OPEN,
      limits: { maxCreatedAtFutureSeconds: 60, maxCreatedAtPastSeconds: 3600 },
    });
    const k = makeKey();
    const now = ports.clock.now();
    expect((await run(ev(k, { created_at: now + 59 }))).action).toBe('accept');
    expect(await run(ev(k, { created_at: now + 120 }))).toMatchObject({ by: 'policy.created-at' });
    expect(await run(ev(k, { created_at: now - 7200 }))).toMatchObject({ by: 'policy.created-at' });
  });
});

describe('proof of work (NIP-13)', () => {
  test('new keys need more work; known keys need the minimum', async () => {
    const { run, ev, ports, svc } = await setup({
      goals: { openness: 50, spamTolerance: 100 },
      limits: { minPowDifficulty: 4, newKeyPowDifficulty: 10 },
    });
    const k = makeKey();
    const now = ports.clock.now();
    expect(await run(mine(k, 4, now))).toMatchObject({ prefix: 'pow', by: 'policy.pow' });
    expect((await run(mine(k, 10, now))).action).toBe('accept');
    // known for longer than newKeyDays (openness 50 → 3 days)
    await svc.state.markSeen('main', k.pk, now);
    ports.clock.advance(4 * 86400);
    const later = ports.clock.now();
    expect((await run(mine(k, 4, later))).action).toBe('accept');
    // committed target below requirement is refused even if the id happens to qualify
    expect(await run(mine(k, 4, later, { target: 2 }))).toMatchObject({ prefix: 'pow' });
    // no work at all
    const plain = ev(k);
    const r = await run(plain);
    if (r.action !== 'accept') expect(r).toMatchObject({ prefix: 'pow' });
  });

  test('allowlisted keys are never "new"', async () => {
    const { run, svc, ports } = await setup({
      goals: { openness: 100 },
      limits: { newKeyPowDifficulty: 12 },
    });
    const k = makeKey();
    await svc.state.allow('main', { pubkey: k.pk, addedAt: 0, by: 'x', via: 'admin' });
    expect((await run(mine(k, 0, ports.clock.now()))).action).toBe('accept');
  });
});

describe('upload limits', () => {
  test('max file size and per-person quota', async () => {
    const { kernel, ctx, ports } = await setup({
      ...OPEN,
      blossom: { maxBlobBytes: 1000, defaultQuotaBytes: 1500 },
    });
    const pk = makeKey().pk;
    const up = (size: number) => ({ sha256: 'c'.repeat(64), size, type: 'image/png', pubkey: pk });
    expect((await kernel.policy.run('onUpload', [up(900), ctx()])).action).toBe('accept');
    expect(await kernel.policy.run('onUpload', [up(1001), ctx()])).toMatchObject({
      by: 'policy.upload-limits',
    });
    await ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: 'd'.repeat(64),
      pubkey: pk,
      size: 1000,
      type: 'image/png',
      uploadedAt: 0,
    });
    expect(await kernel.policy.run('onUpload', [up(600), ctx()])).toMatchObject({
      by: 'policy.upload-limits',
    });
  });
});

describe('duplicates', () => {
  test('exact duplicates (normalized) are refused within the window', async () => {
    const { run, ev, ports } = await setup({ goals: { openness: 100, spamTolerance: 50 } });
    const text = 'Buy my amazing course today, limited offer!!!';
    expect((await run(ev(makeKey(), { content: text }))).action).toBe('accept');
    expect(
      await run(ev(makeKey(), { content: '  buy MY amazing course today limited offer ' })),
    ).toMatchObject({ action: 'reject', by: 'policy.duplicate' });
    ports.clock.advance(901); // window at spamTolerance 50 = 900s
    expect((await run(ev(makeKey(), { content: text }))).action).toBe('accept');
  });

  test('short messages are never treated as duplicates', async () => {
    const { run, ev } = await setup({ goals: { openness: 100, spamTolerance: 0 } });
    for (let i = 0; i < 3; i++)
      expect((await run(ev(makeKey(), { content: 'gm' }))).action).toBe('accept');
  });

  test('near-duplicates are held for review when spam blocking is aggressive', async () => {
    const { run, ev } = await setup({ goals: { openness: 100, spamTolerance: 0 } });
    const a = 'the quick brown fox jumps over the lazy dog near the river bank today at noon';
    const b = 'the quick brown fox jumps over the lazy dog near the river bank today at noon!! 77';
    expect((await run(ev(makeKey(), { content: a }))).action).toBe('accept');
    expect(await run(ev(makeKey(), { content: b }))).toMatchObject({
      action: 'hold',
      by: 'policy.duplicate',
    });
    const unrelated =
      'completely different words about cooking pasta with garlic and olive oil tonight';
    expect((await run(ev(makeKey(), { content: unrelated }))).action).toBe('accept');
  });

  test('non-text kinds and dry runs are not recorded', async () => {
    const { run, ev } = await setup({ goals: { openness: 100, spamTolerance: 0 } });
    const text = 'this is a reasonably long reaction text that repeats';
    expect((await run(ev(makeKey(), { kind: 7, content: text }))).action).toBe('accept');
    expect((await run(ev(makeKey(), { kind: 7, content: text }))).action).toBe('accept');
    expect((await run(ev(makeKey(), { content: text }), { dryRun: true })).action).toBe('accept');
    expect((await run(ev(makeKey(), { content: text }))).action).toBe('accept');
  });
});

describe('links and keyword packs', () => {
  test('too many links', async () => {
    const { run, ev } = await setup({ goals: { openness: 100, spamTolerance: 0 } }); // maxLinks 2
    const k = makeKey();
    expect(
      (await run(ev(k, { content: 'see https://a.example and https://b.example' }))).action,
    ).toBe('accept');
    expect(
      await run(
        ev(k, { content: 'x https://a.example/1 https://b.example/2 https://c.example/3' }),
      ),
    ).toMatchObject({ by: 'policy.content', prefix: 'blocked' });
  });

  test('blocked domains (incl. subdomains), packs and custom keywords', async () => {
    const { run, ev } = await setup(OPEN, {
      content: {
        packs: ['scam', 'shorteners'],
        blockedDomains: ['spam.example'],
        blockedKeywords: ['Buy Followers'],
      },
    });
    const k = makeKey();
    expect(await run(ev(k, { content: 'visit https://www.spam.example/x' }))).toMatchObject({
      by: 'policy.content',
    });
    expect(await run(ev(k, { content: 'look https://bit.ly/abc' }))).toMatchObject({
      by: 'policy.content',
    });
    expect(await run(ev(k, { content: 'FREE AIRDROP for everyone!' }))).toMatchObject({
      by: 'policy.content',
    });
    expect(await run(ev(k, { content: 'cheap: buy followers now' }))).toMatchObject({
      by: 'policy.content',
    });
    expect(
      (await run(ev(k, { content: 'a normal post about https://notspam.example' }))).action,
    ).toBe('accept');
    // encrypted / non-text kinds are not scanned
    expect((await run(ev(k, { kind: 4, content: 'free airdrop' }))).action).toBe('accept');
  });
});

describe('stats', () => {
  test('counts rejections, shadows and holds per hook; dry runs excluded', async () => {
    const { run, ev, svc } = await setup({ ...OPEN, limits: { blockedKinds: [9] } });
    const k = makeKey();
    await run(ev(k, { kind: 9 }));
    await run(ev(k, { kind: 9 }));
    await run(ev(k, { kind: 9 }), { dryRun: true });
    await svc.state.mute('main', { pubkey: k.pk, at: 0, by: 'x' });
    await run(ev(k));
    const s = svc.stats();
    expect(s.hooks['policy.kinds']?.rejected).toBe(2);
    expect(s.hooks['policy.mute']?.shadowed).toBe(1);
    expect(s.total.rejected).toBe(2);
    expect(s.reasons.blocked).toBe(2);
  });
});
