// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Process entry shared by `bin.ts` and the compiled single binary
 * (runtime-bun `scripts/build.ts` generates an entry that calls this):
 * `beamhop` / `beamhop serve` / server flags start the server, anything else
 * is a CLI command.
 *
 * Serving also adds the in-app updater and doctor (`binarySystemModule`) and
 * runs the crash-loop guard of a pending update.
 */
import { VERSION, embeddedAssets, main } from '@beamhop/runtime-bun';
import { runCli } from './cli.ts';
import { binarySystemModule } from './system.ts';
import { bootGuard } from './updater.ts';

/** What this binary contains (`beamhop --build-info`, checked by the root `bun run build`). */
export function buildInfo(): {
  version: string;
  platform: string;
  arch: string;
  assets: { admin: number; team: number };
} {
  return {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    assets: {
      admin: Object.keys(embeddedAssets('admin')).length,
      team: Object.keys(embeddedAssets('team')).length,
    },
  };
}

export async function runBinary(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === '--build-info') {
    process.stdout.write(`${JSON.stringify(buildInfo())}\n`);
    process.exit(0);
  }
  let serving = false;
  const code = await runCli(argv, {
    serve: async (args) => {
      serving = true;
      const execPath = process.execPath;
      try {
        if (bootGuard(execPath, VERSION) === 'rolled-back') {
          process.stderr.write(
            'The new version kept failing to start, so the previous version was put back. Start Beamhop again.\n',
          );
          process.exit(1);
        }
      } catch {
        // never block the start on the guard
      }
      const env = process.env as Record<string, string | undefined>;
      // Restarts run `beamhop <server flags>` (server flags alone start the server too).
      return main(args, process.env, {
        modules: [binarySystemModule({ execPath, argv: args, env })],
      });
    },
  });
  // The server keeps running until a signal; every other command exits now
  // (a NIP-46 relay pool or timer must not keep a finished command alive).
  if (!serving || code !== 0) process.exit(code || 0);
}
