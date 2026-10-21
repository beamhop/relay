// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Process entry shared by `bin.ts` and the compiled single binary
 * (runtime-bun `scripts/build.ts` generates an entry that calls this):
 * `beamhop` / `beamhop serve` / server flags start the server, anything else
 * is a CLI command.
 */
import { main } from '@beamhop/runtime-bun';
import { runCli } from './cli.ts';

export async function runBinary(argv = process.argv.slice(2)): Promise<void> {
  let serving = false;
  const code = await runCli(argv, {
    serve: async (args) => {
      serving = true;
      return main(args);
    },
  });
  // The server keeps running until a signal; every other command exits now
  // (a NIP-46 relay pool or timer must not keep a finished command alive).
  if (!serving || code !== 0) process.exit(code || 0);
}
