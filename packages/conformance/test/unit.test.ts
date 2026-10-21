// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { UsageError, parseArgs } from '../src/args.ts';
import {
  type Dialer,
  type RawSocket,
  RelayClient,
  type Report,
  badgeSvg,
  httpUrlOf,
  passRatio,
  reasonPrefix,
  runSuite,
  specNumbers,
} from '../src/index.ts';

function report(pass: number, fail: number, skip = 0): Report {
  return {
    target: { relay: 'wss://r.example' },
    supportedNips: [1],
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    results: [],
    summary: { pass, fail, skip, total: pass + fail + skip },
  };
}

describe('args', () => {
  test('parses relay, lists and flags', () => {
    const o = parseArgs([
      'wss://relay.example',
      '--blossom',
      'https://cdn.example',
      '--nips',
      '1,NIP-09,11',
      '--buds=1,2',
      '--json',
      '--fuzz',
      '50',
      '--badge',
      'out.svg',
      '--all',
    ]);
    expect(o.relayUrl).toBe('wss://relay.example');
    expect(o.blossomUrl).toBe('https://cdn.example');
    expect(o.nips).toEqual([1, 9, 11]);
    expect(o.buds).toEqual([1, 2]);
    expect(o.json).toBe(true);
    expect(o.fuzz).toBe(50);
    expect(o.badge).toBe('out.svg');
    expect(o.all).toBe(true);
  });

  test('badge without a file uses the default name', () => {
    expect(parseArgs(['ws://x', '--badge']).badge).toBe('conformance-badge.svg');
    expect(parseArgs(['ws://x', '--badge', '--json']).badge).toBe('conformance-badge.svg');
  });

  test('rejects bad input with plain messages', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(['https://not-ws'])).toThrow(/ws:\/\//);
    expect(() => parseArgs(['ws://x', '--nips', 'a,b'])).toThrow(UsageError);
    expect(() => parseArgs(['ws://x', '--wat'])).toThrow(/Unknown option/);
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('report helpers', () => {
  test('badge shows pass ratio and colour', () => {
    const all = badgeSvg(report(10, 0, 3));
    expect(all).toContain('10/10');
    expect(all).toContain('#4c1');
    const some = badgeSvg(report(5, 5));
    expect(some).toContain('5/10');
    expect(some).toContain('#fe7d37');
    expect(badgeSvg(report(0, 0))).toContain('n/a');
    expect(passRatio(report(3, 1))).toBe(0.75);
    expect(all.startsWith('<svg')).toBe(true);
  });

  test('spec numbers and urls', () => {
    expect(specNumbers('NIP-17/59')).toEqual([17, 59]);
    expect(specNumbers('BUD-02')).toEqual([2]);
    expect(specNumbers('fuzz')).toEqual([]);
    expect(httpUrlOf('wss://a.example/x')).toBe('https://a.example/x');
    expect(httpUrlOf('ws://a.example')).toBe('http://a.example');
    expect(reasonPrefix('invalid: nope')).toBe('invalid');
    expect(reasonPrefix('nope')).toBeUndefined();
  });
});

/** A fake socket whose "relay" logic is a function of each client frame. */
function fakeDialer(
  onFrame: (msg: unknown[], reply: (f: unknown[]) => void) => void,
  greet?: unknown[],
): Dialer {
  return async () => {
    const sock: RawSocket = {
      onmessage: null,
      onclose: null,
      send(data) {
        let msg: unknown[];
        try {
          msg = JSON.parse(data);
        } catch {
          queueMicrotask(() => sock.onmessage?.(JSON.stringify(['NOTICE', 'invalid: json'])));
          return;
        }
        onFrame(msg, (f) => queueMicrotask(() => sock.onmessage?.(JSON.stringify(f))));
      },
      close() {
        queueMicrotask(() => sock.onclose?.(1000, ''));
      },
    };
    if (greet) setTimeout(() => sock.onmessage?.(JSON.stringify(greet)), 0);
    return sock;
  };
}

describe('client', () => {
  test('req collects events until EOSE, ignores garbage frames', async () => {
    let sockRef: RawSocket | undefined;
    const dial: Dialer = async (url, t) => {
      const s = await fakeDialer((msg, reply) => {
        if (msg[0] === 'REQ') {
          sockRef?.onmessage?.('not json');
          reply(['EVENT', msg[1], { id: 'a' }]);
          reply(['EVENT', 'other', { id: 'b' }]);
          reply(['EOSE', msg[1]]);
        }
      })(url, t);
      sockRef = s;
      return s;
    };
    const c = await RelayClient.connect(dial, 'ws://fake', 500);
    const r = await c.req([{}]);
    expect(r.eose).toBe(true);
    expect(r.events.map((e) => e.id)).toEqual(['a']);
    expect(c.garbage).toEqual(['not json']);
    c.close();
  });

  test('times out cleanly when nothing answers', async () => {
    const c = await RelayClient.connect(
      fakeDialer(() => {}),
      'ws://fake',
      50,
    );
    const r = await c.req([{}]);
    expect(r.timedOut).toBe(true);
    expect(await c.publish({ id: 'x' })).toBeNull();
    expect(await c.challenge(20)).toBeNull();
  });
});

describe('the suite is not vacuous', () => {
  test('a relay that accepts everything fails the validation checks', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const dial = fakeDialer(
      (msg, reply) => {
        if (msg[0] === 'EVENT') {
          const ev = msg[1] as Record<string, unknown>;
          stored.push(ev);
          reply(['OK', ev?.id ?? '', true, '']);
        } else if (msg[0] === 'REQ') {
          for (const e of stored) reply(['EVENT', msg[1], e]);
          reply(['EOSE', msg[1]]);
        }
      },
      ['AUTH', 'challenge-1234'],
    );
    const report = await runSuite({
      relayUrl: 'ws://yes.example',
      dial,
      fetch: async () =>
        new Response(JSON.stringify({ name: 'yes', supported_nips: [1, 11, 42] }), {
          headers: { 'content-type': 'application/nostr+json' },
        }),
      only: [
        'nip01.ok-bad-sig',
        'nip01.ok-bad-id',
        'nip01.req-ids',
        'nip11.cors',
        'nip42.auth-wrong-relay',
        'nip40',
      ],
      timeoutMs: 200,
    });
    const status = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
    expect(status['nip01.ok-bad-sig']).toBe('fail');
    expect(status['nip01.ok-bad-id']).toBe('fail');
    expect(status['nip01.req-ids']).toBe('fail');
    expect(status['nip11.cors']).toBe('fail');
    expect(status['nip42.auth-wrong-relay']).toBe('fail');
    // NIP-40 is not advertised → skipped, with a plain explanation.
    const nip40 = report.results.find((r) => r.id === 'nip40.expires');
    expect(nip40?.status).toBe('skip');
    expect(nip40?.message).toContain('Not offered');
  });
});
