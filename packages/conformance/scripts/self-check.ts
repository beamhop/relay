// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Print the conformance report for Beamhop itself, run in-process (no sockets).
 *   bun scripts/self-check.ts [--fuzz N] [--seed S] [--json]
 */
import { parseArgs } from '../src/args.ts';
import { formatReport, runSuite, toJson } from '../src/index.ts';
import { inProcessHarness } from '../test/helpers.ts';

const opts = parseArgs(['ws://relay.test', ...process.argv.slice(2)]);
const { target } = await inProcessHarness();
const report = await runSuite({
  relayUrl: target.relayUrl,
  blossomUrl: target.blossomUrl,
  dial: target.dial,
  fetch: target.fetch,
  allowPrivateMirror: true,
  all: opts.all,
  timeoutMs: opts.timeoutMs ?? 3000,
  ...(opts.nips ? { nips: opts.nips } : {}),
  ...(opts.only ? { only: opts.only } : {}),
  ...(opts.fuzz !== undefined ? { fuzz: opts.fuzz } : {}),
  ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
});
process.stdout.write(opts.json ? toJson(report) : `${formatReport(report)}\n`);
process.exit(report.summary.fail ? 1 : 0);
