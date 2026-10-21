// SPDX-License-Identifier: AGPL-3.0-or-later
/** The Bun server wires the signature worker pool into the relay engine. */
import { afterEach, describe, expect, test } from 'bun:test';
import { relayModule } from '@beamhop/relay';
import { makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import { type RunningServer, VerifyPool, parseArgs, startServer } from '../src/index.ts';
import { canBind, openWs, testConfig, waitFor } from './helpers.ts';

const d = canBind() ? describe : describe.skip;
const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop('test');
});

async function boot(verifyWorkers?: number) {
  const base = testConfig();
  const s = await startServer({
    config: { ...base, node: { ...base.node, verifyWorkers } },
    modules: [relayModule],
    ports: memoryPorts(),
    hostname: '127.0.0.1',
    port: 0,
    print: () => {},
    shutdownTimeoutMs: 500,
  });
  running.push(s);
  return s;
}

describe('--verify-workers', () => {
  test('is parsed as a number of threads', () => {
    expect(parseArgs(['--verify-workers', '3']).verifyWorkers).toBe(3);
    expect(parseArgs(['--verify-workers=0']).verifyWorkers).toBe(0);
    expect(parseArgs(['--verify-workers', 'lots']).verifyWorkers).toBeUndefined();
  });
});

d('signature checking threads', () => {
  test('events posted over WebSocket are checked by the pool, in order', async () => {
    const s = await boot(2);
    const pool = s.ports.verifier;
    expect(pool).toBeInstanceOf(VerifyPool);
    const k = makeKey();
    const now = s.ports.clock.now();
    const good = makeEvent(k, { created_at: now });
    const other = makeEvent(k, { created_at: now, content: 'two' });
    const bad = { ...other, sig: other.sig.replace(/^./, other.sig[0] === 'a' ? 'b' : 'a') };
    const c = openWs(s.url.replace(/^http/, 'ws'), { host: 'alpha.test' });
    await c.opened;
    c.ws.send(JSON.stringify(['EVENT', good]));
    c.ws.send(JSON.stringify(['EVENT', bad]));
    const oks = () => c.messages.filter((m) => m.startsWith('["OK"'));
    await waitFor(() => oks().length >= 2);
    expect(oks().map((m) => JSON.parse(m))).toEqual([
      ['OK', good.id, true, ''],
      ['OK', bad.id, false, 'invalid: bad signature'],
    ]);
    expect((pool as VerifyPool).stats().verified).toBe(2);
    c.ws.close();
    await s.stop('test');
    expect((pool as VerifyPool).stats().live).toBe(0);
  });

  test('0 keeps checks on the main thread', async () => {
    const s = await boot(0);
    expect(s.ports.verifier).toBeUndefined();
  });
});
