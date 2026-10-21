// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_CATALOG,
  BUILTIN_PLUGINS,
  keywordFilterPlugin,
  kindAllowlistPlugin,
  nip05RequiredPlugin,
  parseNip05,
  rateLimitBurstPlugin,
  wotStrictPlugin,
} from '../src/builtin/index.ts';
import { createPluginTestbed, expectAccept, expectReject } from '../src/testing/index.ts';

describe('built-in catalog', () => {
  test('lists every built-in plugin with matching manifest data', () => {
    expect(BUILTIN_CATALOG.plugins.map((e) => e.id).sort()).toEqual(
      Object.keys(BUILTIN_PLUGINS).sort(),
    );
    for (const e of BUILTIN_CATALOG.plugins) {
      const m = BUILTIN_PLUGINS[e.id]!.manifest;
      expect(e.package).toBe(`builtin:${e.id}`);
      expect(e.version).toBe(m.version);
      expect(e.name).toBe(m.name);
      expect(e.description).toBe(m.description);
      expect(e.permissions).toEqual(m.permissions);
    }
  });
});

describe('kind-allowlist', () => {
  test('accepts listed kinds and ranges, rejects others', async () => {
    const tb = await createPluginTestbed({
      plugin: kindAllowlistPlugin,
      config: { kinds: [1], ranges: [[30000, 30010]] },
    });
    expectAccept(await tb.event({ kind: 1 }));
    expectAccept(await tb.event({ kind: 30005 }));
    expectReject(await tb.event({ kind: 4 }), 'blocked', 'kind 4');
  });
  test('defaults allow common social kinds', async () => {
    const tb = await createPluginTestbed({ plugin: kindAllowlistPlugin });
    expectAccept(await tb.event({ kind: 7 }));
    expectReject(await tb.event({ kind: 1063 }));
  });
});

describe('keyword-filter', () => {
  test('whole-word, case-insensitive matching', async () => {
    const tb = await createPluginTestbed({
      plugin: keywordFilterPlugin,
      config: { keywords: ['buy now', 'ass'] },
    });
    expectReject(await tb.event({ content: 'Please BUY NOW!' }), 'blocked');
    expectAccept(await tb.event({ content: 'a classic class' }));
    expectReject(await tb.event({ content: 'what an ass.' }));
  });
  test('patterns, kinds, tags and actions', async () => {
    const tb = await createPluginTestbed({
      plugin: keywordFilterPlugin,
      config: { patterns: ['free\\s+\\$\\d+'], kinds: [1], checkTags: true, action: 'hold' },
    });
    expect((await tb.event({ content: 'get free $100' })).action).toBe('hold');
    expectAccept(await tb.event({ kind: 30023, content: 'get free $100' }));
    expect((await tb.event({ content: 'x', tags: [['t', 'free $5']] })).action).toBe('hold');
  });
  test('shadow action and invalid pattern', async () => {
    const tb = await createPluginTestbed({
      plugin: keywordFilterPlugin,
      config: { keywords: ['spam'], action: 'shadow' },
    });
    expect((await tb.event({ content: 'spam' })).action).toBe('shadow');
    const bad = await createPluginTestbed({
      plugin: keywordFilterPlugin,
      config: { patterns: ['(unclosed'] },
    });
    expect(bad.status()[0]!.status).toBe('error');
    expect(bad.status()[0]!.error).toContain('not a valid pattern');
  });
});

describe('rate-limit-burst', () => {
  test('allows a burst, then refills over time', async () => {
    const tb = await createPluginTestbed({
      plugin: rateLimitBurstPlugin,
      config: { burst: 3, perMinute: 6 },
    });
    for (let i = 0; i < 3; i++) expectAccept(await tb.event({ content: `${i}` }));
    expectReject(await tb.event(), 'rate-limited');
    // Other authors are unaffected.
    expectAccept(await tb.event({}, { key: tb.newKey() }));
    tb.ports.clock.advance(10); // 6/min → one token per 10 s
    expectAccept(await tb.event());
    expectReject(await tb.event(), 'rate-limited');
  });
  test('dry runs do not consume tokens; exempt pubkeys and per-connection keys', async () => {
    const tb = await createPluginTestbed({
      plugin: rateLimitBurstPlugin,
      config: { burst: 1, perMinute: 1, by: 'connection' },
    });
    expectAccept(await tb.event({}, { dryRun: true, conn: { id: 'a' } }));
    expectAccept(await tb.event({}, { conn: { id: 'a' } }));
    expectReject(await tb.event({}, { conn: { id: 'a' } }));
    expectAccept(await tb.event({}, { conn: { id: 'b' } }));
    const ex = await createPluginTestbed({ plugin: rateLimitBurstPlugin });
    const key = ex.newKey();
    await ex.configure('rate-limit-burst', { burst: 1, exempt: [key.pk] });
    for (let i = 0; i < 3; i++) expectAccept(await ex.event({}, { key }));
  });
});

describe('wot-strict', () => {
  test('accepts seeds and follows within depth, rejects strangers', async () => {
    const tb = await createPluginTestbed({ plugin: wotStrictPlugin, config: { seeds: [] } });
    // seeds is required: invalid config is reported, not loaded.
    expect(tb.status()[0]!.status).toBe('error');

    const owner = tb.newKey();
    const friend = tb.newKey();
    const fof = tb.newKey();
    const far = tb.newKey();
    const stranger = tb.newKey();
    await tb.store({ kind: 3, tags: [['p', friend.pk]] }, { key: owner });
    await tb.store({ kind: 3, tags: [['p', fof.pk]] }, { key: friend });
    await tb.store({ kind: 3, tags: [['p', far.pk]] }, { key: fof });
    await tb.configure('wot-strict', { seeds: [owner.pk], depth: 2 });

    expectAccept(await tb.event({}, { key: owner }));
    expectAccept(await tb.event({}, { key: friend }));
    expectAccept(await tb.event({}, { key: fof }));
    expectReject(await tb.event({}, { key: far }), 'restricted');
    expectReject(await tb.event({}, { key: stranger }), 'restricted');
  });
  test('exempt kinds and background refresh', async () => {
    const tb = await createPluginTestbed({
      plugin: wotStrictPlugin,
      config: { seeds: ['a'.repeat(64)] },
    });
    const owner = tb.newKey();
    const newbie = tb.newKey();
    await tb.configure('wot-strict', {
      seeds: [owner.pk],
      depth: 1,
      exemptKinds: [0],
      refreshSeconds: 60,
    });
    expectAccept(await tb.event({ kind: 0 }, { key: newbie }));
    expectReject(await tb.event({ kind: 1 }, { key: newbie }));
    await tb.store({ kind: 3, tags: [['p', newbie.pk]] }, { key: owner });
    tb.ports.clock.advance(120);
    await tb.event({ kind: 1 }, { key: newbie }); // triggers refresh, still uses old graph
    await new Promise((r) => setTimeout(r, 10));
    expectAccept(await tb.event({ kind: 1 }, { key: newbie }));
  });
});

describe('nip05-required', () => {
  test('parses identifiers', () => {
    expect(parseNip05('Bob@Example.com')).toEqual({ name: 'bob', domain: 'example.com' });
    expect(parseNip05('example.com')).toEqual({ name: '_', domain: 'example.com' });
    expect(parseNip05('bad@@x')).toBeNull();
    expect(parseNip05('bob@localhost')).toBeNull();
  });

  test('requires a verified address, caches results', async () => {
    let calls = 0;
    const names: Record<string, string> = {};
    const fetch = (async (input: string | URL | Request) => {
      calls++;
      const url = new URL(String(input));
      if (url.hostname !== 'example.com') throw new Error('unreachable');
      return Response.json({ names });
    }) as typeof globalThis.fetch;
    const tb = await createPluginTestbed({ plugin: nip05RequiredPlugin, fetch });
    const alice = tb.newKey();
    names.alice = alice.pk;

    // No profile → rejected; kind 0 is exempt so the profile can be published.
    expectReject(await tb.event({}, { key: alice }), 'restricted', 'add a verified');
    expectAccept(await tb.event({ kind: 0 }, { key: alice }));
    await tb.store(
      { kind: 0, content: JSON.stringify({ nip05: 'alice@example.com' }) },
      { key: alice },
    );
    expectAccept(await tb.event({}, { key: alice }));
    expectAccept(await tb.event({}, { key: alice }));
    expect(calls).toBe(1); // cached

    const bob = tb.newKey();
    await tb.store(
      { kind: 0, content: JSON.stringify({ nip05: 'bob@example.com' }) },
      { key: bob },
    );
    expectReject(await tb.event({}, { key: bob }), 'restricted', 'could not be verified');
    names.bob = bob.pk;
    expectReject(await tb.event({}, { key: bob })); // negative cache
    tb.ports.clock.advance(301);
    expectAccept(await tb.event({}, { key: bob }));

    const eve = tb.newKey();
    await tb.store({ kind: 0, content: JSON.stringify({ nip05: 'eve@10.0.0.1' }) }, { key: eve });
    expectReject(await tb.event({}, { key: eve })); // private address never fetched
  });

  test('allowed domains', async () => {
    const tb = await createPluginTestbed({
      plugin: nip05RequiredPlugin,
      config: { allowedDomains: ['corp.example'] },
      fetch: (async () => Response.json({ names: {} })) as unknown as typeof fetch,
    });
    const k = tb.newKey();
    await tb.store({ kind: 0, content: JSON.stringify({ nip05: 'k@other.example' }) }, { key: k });
    expectReject(await tb.event({}, { key: k }), 'restricted', 'accepted domain');
  });
});
