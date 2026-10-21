// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop claim-code`: print the one-time code that makes the first person
 * to use it the owner. Reads it from the local data dir by starting only the
 * admin module against the database (safe while the server is running: it
 * only reads the code the server already created).
 */
import { existsSync } from 'node:fs';
import type { AdminClaimService } from '@beamhop/admin-api';
import { createKernel } from '@beamhop/core';
import { createDefaultPorts, dataLayout, withDataDirDefaults } from '@beamhop/runtime-bun';
import { type FlagValues, bool } from '../args.ts';
import { type CliContext, localOptions } from '../context.ts';
import { json } from '../format.ts';
import { CliError, EXIT, line, paint } from '../io.ts';
import { cliLogger, resolveLocalConfig } from '../local.ts';

export async function readClaimCode(
  ctx: CliContext,
  globals: FlagValues,
): Promise<{ claimed: boolean; code: string | null }> {
  const loaded = resolveLocalConfig(localOptions(ctx, globals));
  const layout = dataLayout(loaded.config.node.dataDir);
  if (!existsSync(layout.root))
    throw new CliError(
      `No Beamhop data found at ${layout.root}. Start the server once with \`beamhop serve\`.`,
    );
  if (loaded.config.storage.driver === 'memory')
    throw new CliError(
      'The server keeps its data in memory, so the claim code is only shown in its own output.',
    );
  const config = withDataDirDefaults(loaded.config, layout);
  const logger = cliLogger(ctx.env);
  // Loaded lazily so other commands never pay for (or fail on) the admin module's deps.
  const { adminApiModule } = await import('@beamhop/admin-api');
  const defaults = await createDefaultPorts(config, layout, logger);
  try {
    if (defaults.memoryFallbacks.length)
      throw new CliError(
        'The database could not be opened.',
        1,
        defaults.memoryFallbacks.join(', '),
      );
    const kernel = await createKernel({
      runtime: 'bun',
      ports: defaults.ports,
      config,
      modules: [adminApiModule],
    });
    try {
      const claim = kernel.use<AdminClaimService>('admin.claim');
      if (!claim) throw new CliError('This server has no claim feature.');
      if (await claim.isClaimed()) return { claimed: true, code: null };
      return { claimed: false, code: await claim.code() };
    } finally {
      await adminApiModule.stop?.(kernel);
    }
  } finally {
    await defaults.close();
  }
}

export async function claimCodeCommand(ctx: CliContext, globals: FlagValues): Promise<number> {
  const { io } = ctx;
  const r = await readClaimCode(ctx, globals);
  if (bool(globals.json)) json(io, r);
  else if (r.claimed)
    line(
      io,
      'This server already has an owner. Owners can invite more people from the admin app or with `beamhop admins invite`.',
    );
  else {
    line(io, `${paint(io).bold('Claim code:')} ${r.code}`);
    line(io, '  Open the admin app, sign in with Nostr and enter this code to become the owner.');
    line(io, '  Or from a terminal: beamhop login <url> --claim-code <code>');
  }
  return EXIT.ok;
}
