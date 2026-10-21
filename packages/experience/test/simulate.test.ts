// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type NostrEvent, computeEventId, finalizeEvent } from '@beamhop/core';
import { type PolicyService, leadingZeroBits } from '@beamhop/policy';
import { type TestKey, makeKey } from '@beamhop/testkit';
import { OverlayDocStore, applyPatch, mergePatch, proposedConfig } from '../src/index.ts';
import { setup } from './helpers.ts';

function mine(key: TestKey, bits: number, createdAt: number): NostrEvent {
  const pubkey = finalizeEvent({ kind: 1, tags: [], content: '', created_at: 0 }, key.sk).pubkey;
  const content = `mined ${Math.random()}`;
  for (let n = 0; ; n++) {
    const tags = [['nonce', String(n), String(bits)]];
    const id = computeEventId({ pubkey, created_at: createdAt, kind: 1, tags, content });
    if (leadingZeroBits(id) >= bits)
      return finalizeEvent({ kind: 1, tags, content, created_at: createdAt }, key.sk);
  }
}

async function seeded() {
  // Openness 100 → no PoW today; spam tolerance relaxed so content filters stay quiet.
  const env = await setup({ relay: { goals: { openness: 100, spamTolerance: 100 } } });
  const now = env.ports.clock.now();
  const events: NostrEvent[] = [];
  for (let i = 0; i < 30; i++) {
    const key = makeKey();
    events.push(
      finalizeEvent(
        {
          kind: 1,
          tags: [],
          content: `post number ${i} ${Math.random()}`,
          created_at: now - 3600 + i,
        },
        key.sk,
      ),
    );
  }
  const strong = mine(makeKey(), 10, now - 1800);
  events.push(strong);
  // An old event outside the window.
  events.push(
    finalizeEvent(
      { kind: 1, tags: [], content: 'ancient', created_at: now - 3 * 86400 },
      makeKey().sk,
    ),
  );
  for (const e of events) await env.ports.events.save('main', e);
  return { ...env, events, strong, now };
}

describe('simulate-change (sandbox)', () => {
  test('tightening proof of work changes the would-reject counts', async () => {
    const { act, kernel, events, strong } = await seeded();
    expect(kernel.limits('main').minPowDifficulty).toBe(0);
    const { output } = await act('experience.simulate-change', {
      merge: { limits: { minPowDifficulty: 10 } },
      hours: 24,
    });
    const inWindow = events.slice(0, 31);
    const weak = inWindow.filter((e) => leadingZeroBits(e.id) < 10);
    expect(output.replayed).toBe(31);
    expect(output.truncated).toBe(false);
    expect(output.current.accepted).toBe(31);
    expect(output.current.rejected).toBe(0);
    expect(output.proposed.rejected).toBe(weak.length);
    expect(output.proposed.accepted).toBe(31 - weak.length);
    const pow = output.proposed.byReason.find((r: { by: string }) => r.by === 'policy.pow');
    expect(pow.count).toBe(weak.length);
    expect(pow.label).toContain('proof of work');
    expect(pow.examples.length).toBeLessThanOrEqual(5);
    for (const id of pow.examples) expect(weak.map((e) => e.id)).toContain(id);
    expect(output.changes.newlyBlocked).toBe(weak.length);
    expect(output.changes.newlyAllowed).toBe(0);
    expect(output.changes.examplesBlocked).not.toContain(strong.id);
    expect(output.summary).toContain('would be stopped');
  });

  test('loosening shows newly allowed posts; no-op shows no difference', async () => {
    const { act } = await seeded();
    const same = await act('experience.simulate-change', { merge: { goals: { media: 51 } } });
    expect(same.output.changes).toMatchObject({ newlyBlocked: 0, newlyAllowed: 0 });
    expect(same.output.summary).toContain('No difference');
    const blocked = await act('experience.simulate-change', {
      patch: [{ op: 'add', path: '/limits/blockedKinds', value: [1] }],
    });
    expect(blocked.output.proposed.rejected).toBe(31);
    expect(blocked.output.proposed.byReason[0].by).toBe('policy.kinds');
  });

  test('never mutates state', async () => {
    const { act, kernel, ports } = await seeded();
    const policy = kernel.use<PolicyService>('policy')!;
    const before = {
      config: kernel.config(),
      stats: JSON.stringify(policy.stats()),
      count: await ports.events.count('main', [{}]),
    };
    const writes: string[] = [];
    const docs = ports.docs;
    const origPut = docs.put.bind(docs);
    const origDel = docs.delete.bind(docs);
    const origCas = docs.cas.bind(docs);
    docs.put = (async (c: string, k: string, v: unknown) => {
      writes.push(`put ${c}/${k}`);
      return origPut(c, k, v);
    }) as typeof docs.put;
    docs.delete = (async (c: string, k: string) => {
      writes.push(`delete ${c}/${k}`);
      return origDel(c, k);
    }) as typeof docs.delete;
    docs.cas = (async (c: string, k: string, e: unknown, n: unknown) => {
      writes.push(`cas ${c}/${k}`);
      return origCas(c, k, e, n);
    }) as typeof docs.cas;
    const origSave = ports.events.save.bind(ports.events);
    ports.events.save = async (r, e) => {
      writes.push(`save ${e.id}`);
      return origSave(r, e);
    };
    const accepted: unknown[] = [];
    kernel.bus.on('event.rejected', (e) => accepted.push(e));

    await act('experience.simulate-change', {
      merge: { limits: { minPowDifficulty: 12, newKeyPowDifficulty: 20 }, access: { mode: 'wot' } },
    });
    await policy.idle();
    expect(writes).toEqual([]);
    expect(accepted).toEqual([]);
    expect(kernel.config()).toBe(before.config);
    expect(kernel.limits('main').minPowDifficulty).toBe(0);
    expect(JSON.stringify(policy.stats())).toBe(before.stats);
    expect(await ports.events.count('main', [{}])).toBe(before.count);
  });

  test('invalid changes are refused in plain words', async () => {
    const { act } = await seeded();
    await expect(
      act('experience.simulate-change', { merge: { goals: { openness: 500 } } }),
    ).rejects.toThrow(/not valid/);
  });

  test('caps the replay size', async () => {
    const { act } = await seeded();
    const { output } = await act('experience.simulate-change', {
      merge: { limits: { minPowDifficulty: 4 } },
      limit: 10,
    });
    expect(output.replayed).toBe(10);
    expect(output.truncated).toBe(true);
    expect(output.notes.join(' ')).toContain('newest 10');
  });
});

describe('sandbox helpers', () => {
  test('overlay doc store keeps writes private', async () => {
    const { ports } = await setup();
    await ports.docs.put('c', 'a', 1);
    const o = new OverlayDocStore(ports.docs);
    await o.put('c', 'a', 2);
    await o.put('c', 'b', 3);
    expect(await o.get('c', 'a')).toBe(2);
    expect(await ports.docs.get('c', 'a')).toBe(1);
    expect(await ports.docs.get('c', 'b')).toBeNull();
    await o.delete('c', 'a');
    expect(await o.get('c', 'a')).toBeNull();
    expect((await o.list('c')).items).toEqual([]);
    expect(await ports.docs.get('c', 'a')).toBe(1);
  });

  test('patch helpers match the proposal shape', async () => {
    const { kernel } = await setup();
    expect(applyPatch({ a: [1, 2] }, [{ op: 'add', path: '/a/-', value: 3 }])).toEqual({
      a: [1, 2, 3],
    });
    expect(mergePatch({ a: 1, b: 2 }, { b: null, c: 3 })).toEqual({ a: 1, c: 3 });
    const next = proposedConfig(kernel.config(), 'main', { merge: { goals: { openness: 10 } } });
    expect(next.relays[0]?.goals.openness).toBe(10);
    expect(kernel.config().relays[0]?.goals.openness).toBe(70);
    const node = proposedConfig(kernel.config(), 'main', {
      target: 'node',
      patch: [{ op: 'replace', path: '/backups/enabled', value: true }],
    });
    expect(node.backups.enabled).toBe(true);
  });
});
