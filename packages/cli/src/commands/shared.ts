// SPDX-License-Identifier: AGPL-3.0-or-later
import { type FlagValues, bool } from '../args.ts';
import type { CliContext } from '../context.ts';
import { type DiffLine, renderDiff } from '../format.ts';
import { EXIT, paint } from '../io.ts';

/**
 * Show a plain-language preview and decide whether to apply it:
 * `--preview` → never; `--yes` → always; terminal → ask; otherwise → no
 * (exit code 3 tells scripts nothing changed).
 */
export async function previewAndConfirm(
  ctx: CliContext,
  flags: FlagValues,
  title: string,
  diff: DiffLine[],
): Promise<{ apply: true } | { apply: false; exitCode: number }> {
  const { io } = ctx;
  const quiet = bool(flags.json) && bool(flags.yes);
  if (!quiet) {
    const write = io.isTTY ? io.out.bind(io) : io.err.bind(io);
    write(`${paint(io).bold(title)}\n${renderDiff(io, diff, bool(flags.technical))}`);
  }
  if (bool(flags.preview)) return { apply: false, exitCode: EXIT.ok };
  if (bool(flags.yes)) return { apply: true };
  if (!io.interactive) {
    io.err('Nothing was changed. Run again with --yes to apply.\n');
    return { apply: false, exitCode: EXIT.notApplied };
  }
  const answer = (await io.prompt('Apply this change? (y/N)')).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return { apply: true };
  io.err('Nothing was changed.\n');
  return { apply: false, exitCode: EXIT.notApplied };
}
