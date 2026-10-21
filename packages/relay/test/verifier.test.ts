// SPDX-License-Identifier: AGPL-3.0-or-later
/** The relay engine with an offloaded `ports.verifier` (worker pool on Bun). */
import { describe, expect, test } from 'bun:test';
import { type NostrEvent, type SignatureVerifier, verifyEventSig } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { type Frame, setup } from './helpers.ts';

type SigInput = Pick<NostrEvent, 'id' | 'pubkey' | 'sig'>;

/** Real checks, answered after a per-call delay (later calls may finish first). */
function slowVerifier(delays: number[]): SignatureVerifier & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async verify(events: readonly SigInput[]) {
      for (const e of events) calls.push(e.id);
      const d = delays[n++ % delays.length] ?? 0;
      await new Promise((r) => setTimeout(r, d));
      return events.map((e) => verifyEventSig(e as NostrEvent));
    },
  };
}

const oks = (frames: Frame[]) => frames.filter((f) => f[0] === 'OK');

describe('relay engine: offloaded signature checks', () => {
  test('OK answers keep the order events were sent on a connection', async () => {
    const verifier = slowVerifier([30, 1, 15, 0, 5]);
    const h = await setup({ ports: { verifier } });
    const c = await h.connect();
    const k = makeKey();
    const evs = Array.from({ length: 5 }, () => h.event(k));
    const bad = { ...evs[2]!, sig: evs[2]!.sig.replace(/^./, evs[2]!.sig[0] === 'a' ? 'b' : 'a') };
    const sent = [evs[0]!, evs[1]!, bad, evs[3]!, evs[4]!];
    // Fire without awaiting each one, like a client pipelining EVENTs.
    await Promise.all(sent.map((e) => h.engine.handle(c, JSON.stringify(['EVENT', e]))));
    const got = oks(c.frames);
    expect(got.map((f) => f[1])).toEqual(sent.map((e) => e.id));
    expect(got.map((f) => f[2])).toEqual([true, true, false, true, true]);
    expect(got[2]![3]).toBe('invalid: bad signature');
    // Each one checked once (queued ones start early, so not necessarily in order).
    expect([...verifier.calls].sort()).toEqual(sent.map((e) => e.id).sort());
  });

  test('queued EVENTs are checked while earlier ones are still in progress', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const verifier: SignatureVerifier = {
      async verify(events) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return events.map((e) => verifyEventSig(e as NostrEvent));
      },
    };
    const h = await setup({ ports: { verifier } });
    const c = await h.connect();
    const k = makeKey();
    const evs = Array.from({ length: 6 }, () => h.event(k));
    const tampered = { ...evs[3]!, content: 'tampered' };
    const sent = [evs[0]!, evs[1]!, evs[2]!, tampered, evs[4]!, evs[5]!];
    const t0 = performance.now();
    await Promise.all(sent.map((e) => h.engine.handle(c, JSON.stringify(['EVENT', e]))));
    // One check at a time would take 6 × 10 ms.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(performance.now() - t0).toBeLessThan(55);
    const got = oks(c.frames);
    expect(got.map((f) => f[1])).toEqual(sent.map((e) => e.id));
    expect(got.map((f) => f[2])).toEqual([true, true, true, false, true, true]);
    expect(got[3]![3]).toBe('invalid: event id does not match its content');
  });

  test('duplicates are answered before (and without) a signature check', async () => {
    const verifier = slowVerifier([0]);
    const h = await setup({ ports: { verifier } });
    const c = await h.connect();
    const ev = h.event(makeKey());
    expect((await h.publish(c, ev))[2]).toBe(true);
    expect(await h.publish(c, ev)).toEqual([
      'OK',
      ev.id,
      true,
      'duplicate: already have this event',
    ]);
    expect(verifier.calls).toEqual([ev.id]);
  });

  test('a failed check is "could not verify", never accepted', async () => {
    const verifier: SignatureVerifier = {
      verify: () => Promise.reject(new Error('worker crashed')),
    };
    const h = await setup({ ports: { verifier } });
    const c = await h.connect();
    const ev = h.event(makeKey());
    expect(await h.publish(c, ev)).toEqual([
      'OK',
      ev.id,
      false,
      'invalid: could not verify the signature, please try again',
    ]);
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
  });

  test('a bad id is rejected before the verifier is asked', async () => {
    const verifier = slowVerifier([0]);
    const h = await setup({ ports: { verifier } });
    const c = await h.connect();
    const tampered = { ...h.event(makeKey()), content: 'tampered' };
    const ok = await h.publish(c, tampered);
    expect(ok[2]).toBe(false);
    expect(ok[3]).toBe('invalid: event id does not match its content');
    expect(verifier.calls).toEqual([]);
  });

  test('AUTH uses the verifier too', async () => {
    const verifier = slowVerifier([0]);
    const h = await setup({ ports: { verifier } });
    const c = await h.connect();
    const k = makeKey();
    const ok = await h.auth(c, k);
    expect(ok[2]).toBe(true);
    expect(verifier.calls.length).toBe(1);
    const failing = await setup({
      ports: { verifier: { verify: () => Promise.reject(new Error('down')) } },
    });
    const c2 = await failing.connect();
    const r = await failing.auth(c2, k);
    expect(r[2]).toBe(false);
    expect(r[3]).toBe('invalid: could not verify the signature, please try again');
    expect(c2.authed.size).toBe(0);
  });
});
