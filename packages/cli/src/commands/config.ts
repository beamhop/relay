// SPDX-License-Identifier: AGPL-3.0-or-later
/** `beamhop config export|import|diff|history|restore` over the admin settings API. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type FlagSpec, type FlagValues, bool, parseFlags, str } from '../args.ts';
import { type AdminClient, NODE, expectOk } from '../client.ts';
import type { CliContext } from '../context.ts';
import { type DiffLine, json, renderDiff, when } from '../format.ts';
import { EXIT, UsageError, line, paint } from '../io.ts';
import { previewAndConfirm } from './shared.ts';

const FLAGS: FlagSpec[] = [
  {
    name: 'output',
    type: 'string',
    short: 'o',
    description: 'Write to a file instead of the screen',
  },
  { name: 'revision', type: 'string', description: 'Use a past revision' },
  { name: 'limit', type: 'string', description: 'How many entries' },
];

export const CONFIG_HELP = `Settings (the same ones the admin app edits)

  beamhop config export [--revision N] [-o file]   Save settings as beamhop.yaml
  beamhop config import <file> [--yes]             Preview, then apply a beamhop.yaml
  beamhop config diff <file | revision>            What importing a file / restoring a revision would change
  beamhop config history [--limit N]               Past changes (time machine)
  beamhop config restore <revision> [--yes]        Go back to a past revision (undoable)
`;

const revNumber = (s: string | undefined) => {
  const n = Number(s);
  if (!s || !Number.isInteger(n) || n < 1)
    throw new UsageError(`“${s ?? ''}” is not a revision number`);
  return n;
};

async function showCommit(
  ctx: CliContext,
  flags: FlagValues,
  res: {
    revision: { revision: number; summary: string };
    undo?: { token: string; expiresAt: number };
  },
) {
  const p = paint(ctx.io);
  if (bool(flags.json)) return json(ctx.io, res);
  line(
    ctx.io,
    `${p.green('✓')} Saved as revision ${res.revision.revision}: ${res.revision.summary}`,
  );
  if (res.undo)
    line(ctx.io, p.dim(`  Undo until ${when(res.undo.expiresAt)}: beamhop undo ${res.undo.token}`));
}

export async function configCommand(
  ctx: CliContext,
  client: AdminClient,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const { io } = ctx;
  const { flags: own, positionals } = parseFlags(argv, FLAGS);
  const flags = { ...globals, ...own };
  const [sub, arg] = positionals;
  switch (sub) {
    case 'export': {
      const rev = str(flags.revision);
      const res = await expectOk(
        client.request(
          'GET',
          `${NODE}/config/export.yaml${rev ? `?revision=${revNumber(rev)}` : ''}`,
        ),
      );
      const out = str(flags.output);
      if (out) {
        // Exports can contain secrets (storage credentials): keep the file private.
        writeFileSync(resolve(ctx.cwd, out), res.text, { mode: 0o600 });
        line(io, `${paint(io).green('✓')} Wrote ${resolve(ctx.cwd, out)}`);
      } else io.out(res.text);
      return EXIT.ok;
    }
    case 'import':
    case 'diff': {
      if (!arg) throw new UsageError(`Usage: beamhop config ${sub} <file>`);
      if (sub === 'diff' && /^\d+$/.test(arg)) {
        const res = await expectOk(
          client.request('GET', `${NODE}/config/revisions/${revNumber(arg)}/diff`),
        );
        if (bool(flags.json)) json(io, res.json);
        else io.out(renderDiff(io, res.json.diff as DiffLine[], bool(flags.technical)));
        return EXIT.ok;
      }
      const yaml = arg === '-' ? await io.readStdin() : readFileSync(resolve(ctx.cwd, arg), 'utf8');
      const proposal = (await expectOk(client.request('POST', `${NODE}/config/import`, { yaml })))
        .json as {
        id: string;
        changed: boolean;
        diff: DiffLine[];
        summary: string;
      };
      if (sub === 'diff') {
        if (bool(flags.json)) json(io, proposal);
        else io.out(renderDiff(io, proposal.diff, bool(flags.technical)));
        return EXIT.ok;
      }
      if (!proposal.changed) {
        line(io, 'The file matches the current settings; nothing to do.');
        return EXIT.ok;
      }
      const d = await previewAndConfirm(ctx, flags, `Import ${arg}`, proposal.diff);
      if (!d.apply) return d.exitCode;
      const res = await expectOk(
        client.request('POST', `${NODE}/config/commit`, { proposalId: proposal.id }),
      );
      await showCommit(ctx, flags, res.json);
      return EXIT.ok;
    }
    case 'history': {
      const limit = str(flags.limit);
      const res = await expectOk(
        client.request('GET', `${NODE}/config/revisions${limit ? `?limit=${Number(limit)}` : ''}`),
      );
      const items = (res.json?.items ?? []) as Array<{
        revision: number;
        at: number;
        authorName: string;
        summary: string;
        source: string;
        changes: number;
      }>;
      if (bool(flags.json)) json(io, res.json);
      else if (!items.length) line(io, 'No settings changes yet.');
      else
        for (const r of items)
          line(
            io,
            `  ${String(r.revision).padStart(4)}  ${when(r.at)}  ${r.authorName.padEnd(18).slice(0, 18)}  ${r.summary}`,
          );
      return EXIT.ok;
    }
    case 'restore': {
      const rev = revNumber(arg);
      const diff = (await expectOk(client.request('GET', `${NODE}/config/revisions/${rev}/diff`)))
        .json.diff as DiffLine[];
      const d = await previewAndConfirm(ctx, flags, `Restore revision ${rev}`, diff);
      if (!d.apply) return d.exitCode;
      const res = await expectOk(client.request('POST', `${NODE}/config/revisions/${rev}/restore`));
      await showCommit(ctx, flags, res.json);
      return EXIT.ok;
    }
    default:
      io.out(CONFIG_HELP);
      return sub ? EXIT.usage : EXIT.ok;
  }
}
