// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs the real Beamhop server entry (`packages/runtime-bun/src/main.ts`, the same code the
 * single binary runs) in its own process, plus an event-loop lag meter and an RSS sampler.
 * Spawned by `load.ts` with an IPC channel; answers `{type:'stats'}` and `{type:'reset'}`.
 *
 *   bun scripts/bench/server.ts --config <file> --data-dir <dir> --listen 127.0.0.1:<port>
 */
import { main } from '../../packages/runtime-bun/src/main.ts';
import { lagMeter } from './lib.ts';

const lag = lagMeter(10);
let rssPeak = 0;
const sample = () => {
  const rss = process.memoryUsage().rss / 1024 / 1024;
  if (rss > rssPeak) rssPeak = rss;
  return rss;
};
setInterval(sample, 250).unref();

const running = await main(process.argv.slice(2), {
  ...process.env,
  BEAMHOP_LOG_LEVEL: process.env.BEAMHOP_LOG_LEVEL ?? 'warn',
});
if (!running) process.exit(1);

process.on('message', (msg: { type: string }) => {
  if (msg.type === 'reset') {
    lag.reset();
    rssPeak = sample();
    process.send?.({ type: 'reset-ok' });
  } else if (msg.type === 'stats') {
    const rss = sample();
    process.send?.({
      type: 'stats',
      rssMb: rss,
      rssPeakMb: rssPeak,
      lag: lag.stats(),
      connections: running.connections(),
    });
  }
});
process.send?.({ type: 'listening', url: running.url });
