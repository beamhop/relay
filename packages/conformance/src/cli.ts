#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `bunx @beamhop/conformance wss://relay.example [--blossom https://…] [--nips 1,9,11] [--json]`
 *
 * CLI entry (the only file in this package that touches the filesystem/process).
 */
import { writeFileSync } from 'node:fs';
import { USAGE, UsageError, parseArgs } from './args.ts';
import { badgeSvg, formatReport, formatResult, summaryLine, toJson } from './report.ts';
import { runSuite } from './runner.ts';

export async function main(argv: string[]): Promise<number> {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const color = opts.color && !opts.json && !!process.stdout.isTTY && !process.env.NO_COLOR;
  if (!opts.json) {
    process.stdout.write(
      `Checking ${opts.relayUrl}${opts.blossomUrl ? ` and ${opts.blossomUrl}` : ''}…\n\n`,
    );
  }
  const report = await runSuite({
    relayUrl: opts.relayUrl,
    ...(opts.blossomUrl ? { blossomUrl: opts.blossomUrl } : {}),
    ...(opts.nips ? { nips: opts.nips } : {}),
    ...(opts.buds ? { buds: opts.buds } : {}),
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.fuzz !== undefined ? { fuzz: opts.fuzz } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    allowPrivateMirror: opts.allowPrivateMirror,
    all: opts.all,
    onResult: opts.json ? undefined : (r) => process.stdout.write(`${formatResult(r, color)}\n`),
  });
  if (opts.json) process.stdout.write(toJson(report));
  else process.stdout.write(`\n${summaryLine(report)}\n`);
  if (opts.out) writeFileSync(opts.out, toJson(report));
  if (opts.badge) {
    writeFileSync(opts.badge, badgeSvg(report));
    if (!opts.json) process.stdout.write(`Badge written to ${opts.badge}\n`);
  }
  return report.summary.fail > 0 ? 1 : 0;
}

export { formatReport };

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`conformance: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
