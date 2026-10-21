// SPDX-License-Identifier: AGPL-3.0-or-later
/** create-beamhop: `npm create beamhop@latest -- --cf` sets up Beamhop on Cloudflare. */
import { type SetupDeps, setupCloudflare } from './cloudflare.ts';
import { type Io, nodeFiles, nodeRunner, terminalIo } from './io.ts';
import { parseOptions } from './util.ts';

export { setupCloudflare, SetupError, showCommand } from './cloudflare.ts';
export type { SetupDeps, SetupResult } from './cloudflare.ts';
export type { Files, Io, RunOptions, RunResult, Runner } from './io.ts';
export { beamhopConfig, packageJson, wranglerToml, DEFAULT_RUNTIME_SPEC } from './templates.ts';
export { parseOptions, parsePubkey, slugify, normalizeDomain, type Options } from './util.ts';

export const INSTALL_TEXT = `Beamhop: your own Nostr relay and media server.

  Any Linux or macOS machine:  curl -fsSL https://get.beamhop.dev | sh
  Docker:                      docker run -p 3334:3334 -v beamhop:/data ghcr.io/beamhop/beamhop
  Cloudflare (no server):      npm create beamhop@latest -- --cf

Then open the link it prints and follow the steps.`;

export const HELP_TEXT = `Usage: npm create beamhop@latest -- [--cf] [options]

  --cf                 Set up Beamhop on your Cloudflare account (Workers, D1, R2)
  --dry-run            Show every command and file without running or writing anything
  -y, --yes            Do not ask; use flags or defaults
  --name <text>        Relay name (default "My Beamhop Relay")
  --domain <host>      Your own domain, or "workers.dev" (default) for a free address
  --owner <npub>       Your Nostr public key, shown as the relay owner (optional)
  --dir <path>         Project folder (default: the relay name)
  --runtime <spec>     Worker bundle to install (default @beamhop/runtime-cf@latest;
                       a release tarball URL or file: path works too)
  -h, --help           Show this help

Running it again is safe: the existing database, bucket and secrets are reused.`;

/** CLI entry; returns the process exit code. */
export async function main(
  argv: string[],
  deps: Partial<SetupDeps> & { io?: Io } = {},
): Promise<number> {
  const io = deps.io ?? terminalIo();
  const opts = parseOptions(argv);
  if (opts.help) {
    io.log(HELP_TEXT);
    return 0;
  }
  if (!opts.cf) {
    io.log(INSTALL_TEXT);
    return 0;
  }
  try {
    await setupCloudflare(opts, {
      runner: deps.runner ?? nodeRunner,
      files: deps.files ?? nodeFiles,
      io,
      claimCode: deps.claimCode,
      secret: deps.secret,
      now: deps.now,
    });
    return 0;
  } catch (err) {
    io.log();
    io.log(`Setup stopped: ${err instanceof Error ? err.message : String(err)}`);
    io.log('Fix the problem above and run the same command again; finished steps are skipped.');
    return 1;
  }
}
