// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Boot a throwaway Beamhop server (memory storage, generous rate limits) for
 * load tests and manual conformance runs:
 *   bun bench/serve.ts [--port 8080]
 *   bun bench/load.ts --url ws://127.0.0.1:8080 …
 *   bun src/cli.ts ws://127.0.0.1:8080 --blossom http://127.0.0.1:8080 --allow-private-mirror
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@beamhop/core';
import { startServer } from '@beamhop/runtime-bun';
import { memoryPorts } from '@beamhop/testkit';
import { harnessModules, harnessRelay, realClock } from '../test/helpers.ts';

const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : 8080;
const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'beamhop-bench-'));
const server = await startServer({
  config: parseConfig({
    node: { dataDir, listen: `127.0.0.1:${port}`, tls: { mode: 'off' } },
    relays: [harnessRelay(['127.0.0.1', 'localhost'])],
    modules: { relay: { maxPendingMessages: 10_000 } },
  }),
  modules: harnessModules(),
  ports: memoryPorts({ clock: realClock }),
  hostname: '127.0.0.1',
  port,
  print: () => {},
});
console.log(`Beamhop (memory) listening on ${server.url.replace(/^http/, 'ws')}`);
process.on('SIGINT', () => {
  void server.stop('SIGINT').then(() => process.exit(0));
});
