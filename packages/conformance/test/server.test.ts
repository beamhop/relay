// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CI harness: boots the real Bun server (`startServer`) on an ephemeral port
 * with memory storage and the relay + policy + blossom modules, then runs the
 * full suite over real WebSockets and HTTP. Skips cleanly when the sandbox
 * does not allow binding a local port.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@beamhop/core';
import { type RunningServer, startServer } from '@beamhop/runtime-bun';
import { memoryPorts } from '@beamhop/testkit';
import { formatReport, runSuite } from '../src/index.ts';
import { canBind, harnessModules, harnessRelay, realClock } from './helpers.ts';

const BIND = canBind();
if (!BIND) {
  console.warn(
    '[conformance] local port binding is not permitted here; the real-server conformance run is skipped (the in-process run still covers the suite)',
  );
}
const d = BIND ? describe : describe.skip;

d('conformance suite against startServer (real sockets)', () => {
  let server: RunningServer;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'beamhop-conf-'));
    server = await startServer({
      config: parseConfig({
        node: { dataDir, listen: '127.0.0.1:0', tls: { mode: 'off' } },
        relays: [harnessRelay(['127.0.0.1', 'localhost'])],
      }),
      modules: harnessModules(),
      ports: memoryPorts({ clock: realClock }),
      hostname: '127.0.0.1',
      port: 0,
      print: () => {},
      shutdownTimeoutMs: 500,
    });
  });

  afterAll(async () => {
    await server?.stop('test');
  });

  test('all advertised NIPs and BUDs pass over WebSocket/HTTP', async () => {
    const http = server.url;
    const report = await runSuite({
      relayUrl: http.replace(/^http/, 'ws'),
      blossomUrl: http,
      allowPrivateMirror: true,
      timeoutMs: 4000,
      fuzz: 150,
      seed: 4242,
    });
    const failed = report.results.filter((r) => r.status === 'fail');
    if (failed.length) console.log(formatReport(report));
    expect(failed.map((r) => `${r.id}: ${r.message}`)).toEqual([]);
    expect(report.summary.pass).toBeGreaterThan(30);
  }, 120_000);
});
