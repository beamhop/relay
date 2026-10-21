// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generated action commands: preview → confirm → apply → undo token, plus
 * bulk (`--from-file`) and `beamhop undo <token>`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type FlagValues, bool, parseFlags, str } from '../args.ts';
import {
  ACTION_FLAGS,
  type Catalog,
  type CatalogEntry,
  actionFields,
  actionHelp,
  buildInput,
  fieldFlagSpecs,
} from '../catalog.ts';
import { type AdminClient, NODE, expectOk, relayPath } from '../client.ts';
import type { CliContext } from '../context.ts';
import { type DiffLine, json, renderDiff, renderValue, when } from '../format.ts';
import { CliError, EXIT, UsageError, line, paint } from '../io.ts';

export async function fetchCatalog(client: AdminClient): Promise<Catalog> {
  const raw = await client.request('GET', `${NODE}/actions`);
  if (raw.status === 404 && !raw.json?.error)
    throw new CliError(
      'This server does not offer the admin API (its admin module is not loaded).',
      1,
      'GET /api/v1/nodes/self/actions → 404',
    );
  const res = await expectOk(raw);
  return { actions: (res.json?.actions ?? []) as CatalogEntry[] };
}

/** Pick the relay for a relay-scoped action: --relay, $BEAMHOP_RELAY, or the only one. */
export async function chooseRelay(
  ctx: CliContext,
  client: AdminClient,
  flags: FlagValues,
): Promise<string> {
  const explicit = str(flags.relay) ?? ctx.env.BEAMHOP_RELAY;
  if (explicit) return explicit;
  const res = await expectOk(client.request('GET', '/nodes'));
  const relays = (res.json?.nodes?.[0]?.relays ?? []) as Array<{ id: string; name?: string }>;
  if (relays.length === 1) return relays[0]!.id;
  if (!relays.length) throw new CliError('This server has no relays you can manage.');
  throw new UsageError(
    `This works on one relay. Pick one with --relay:\n${relays.map((r) => `  --relay ${r.id}${r.name ? `   (${r.name})` : ''}`).join('\n')}`,
  );
}

/** Parse a bulk file: a JSON array, or one JSON object per line. */
export function parseBulk(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  let items: unknown[];
  if (t.startsWith('[')) {
    try {
      items = JSON.parse(t) as unknown[];
    } catch (err) {
      throw new UsageError('The file is not a valid JSON array', String(err));
    }
  } else {
    items = t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new UsageError(`Line ${i + 1} of the file is not valid JSON`);
        }
      });
  }
  for (const [i, it] of items.entries())
    if (!it || typeof it !== 'object' || Array.isArray(it))
      throw new UsageError(`Item ${i + 1} in the file must be a JSON object`);
  return items as Record<string, unknown>[];
}

function issuesError(issues: Array<{ flag: string; message: string }>, prefix = ''): UsageError {
  return new UsageError(
    `Some options are not valid:\n${issues.map((i) => `  ${prefix}--${i.flag} ${i.message}`).join('\n')}`,
  );
}

export async function runActionCommand(
  ctx: CliContext,
  client: AdminClient,
  entry: CatalogEntry,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const io = ctx.io;
  const p = paint(io);
  const fields = actionFields(entry);
  const parsed = parseFlags(argv, [...fieldFlagSpecs(fields), ...ACTION_FLAGS]);
  const flags = { ...globals, ...parsed.flags };
  const technical = bool(flags.technical);
  if (bool(flags.help)) {
    io.out(actionHelp(entry, technical));
    return EXIT.ok;
  }
  if (parsed.positionals.length)
    throw new UsageError(
      `Unexpected argument “${parsed.positionals[0]}”. Options are passed as --name value.`,
    );

  let base: Record<string, unknown> = {};
  const rawInput = str(flags.input);
  if (rawInput) {
    try {
      base = JSON.parse(rawInput);
    } catch {
      throw new UsageError('--input must be a JSON object');
    }
  }
  const fromFile = str(flags['from-file']);
  let inputs: Record<string, unknown>[];
  if (fromFile) {
    if (!entry.bulk) throw new UsageError(`“${entry.title}” cannot be run for many items at once.`);
    const text =
      fromFile === '-' ? await io.readStdin() : readFileSync(resolve(ctx.cwd, fromFile), 'utf8');
    const items = parseBulk(text);
    if (!items.length) throw new UsageError('The file has no items.');
    const shared = buildInput(fields, parsed.flags, base, { requireAll: false });
    if (shared.issues.length) throw issuesError(shared.issues);
    inputs = items.map((it, i) => {
      const merged = { ...shared.input, ...it };
      const missing = fields.filter((f) => f.required && merged[f.prop] === undefined);
      if (missing.length)
        throw issuesError(
          missing.map((f) => ({ flag: f.flag, message: 'is required' })),
          `item ${i + 1}: `,
        );
      return merged;
    });
  } else {
    const built = buildInput(fields, parsed.flags, base);
    if (built.issues.length) throw issuesError(built.issues);
    inputs = [built.input];
  }

  const prefix = entry.scope === 'relay' ? relayPath(await chooseRelay(ctx, client, flags)) : NODE;
  const id = encodeURIComponent(entry.id);
  const reason = str(flags['audit-reason']);

  if (entry.readOnly) {
    const res = await expectOk(
      client.request('POST', `${prefix}/actions/${id}`, { input: inputs[0] }),
    );
    if (bool(flags.json)) json(io, res.json);
    else {
      const out = res.json?.output;
      if (out !== undefined && out !== null) line(io, renderValue(out));
      else line(io, res.json?.summary ?? 'Done');
    }
    return EXIT.ok;
  }

  // Preview (all items for bulk, shown up to 20).
  const diff: DiffLine[] = [];
  const shown = inputs.slice(0, 20);
  for (const input of shown) {
    const res = await expectOk(
      client.request('POST', `${prefix}/actions/${id}/preview`, { input }),
    );
    diff.push(...((res.json?.diff ?? []) as DiffLine[]));
  }
  if (inputs.length > shown.length)
    diff.push({ kind: 'info', text: `…and ${inputs.length - shown.length} more like these` });

  const previewOnly = bool(flags.preview);
  if (bool(flags.json) && previewOnly) {
    json(io, { action: entry.id, items: inputs.length, diff });
    return EXIT.ok;
  }
  if (!bool(flags.json) || !bool(flags.yes)) {
    const target = io.isTTY ? io.out.bind(io) : io.err.bind(io);
    target(`${p.bold(entry.title)}${inputs.length > 1 ? ` (${inputs.length} items)` : ''}\n`);
    target(renderDiff(io, diff, technical));
  }
  if (previewOnly) return EXIT.ok;

  if (!bool(flags.yes)) {
    if (!io.interactive) {
      io.err('Nothing was changed. Run again with --yes to apply.\n');
      return EXIT.notApplied;
    }
    const answer = (await io.prompt('Apply this change? (y/N)')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      io.err('Nothing was changed.\n');
      return EXIT.notApplied;
    }
  }

  const body: Record<string, unknown> = {};
  if (reason) body.reason = reason;
  const res =
    inputs.length > 1 || fromFile
      ? await expectOk(client.request('POST', `${prefix}/actions/${id}/bulk`, { ...body, inputs }))
      : await expectOk(
          client.request('POST', `${prefix}/actions/${id}`, { ...body, input: inputs[0] }),
        );
  if (bool(flags.json)) {
    json(io, res.json);
    return bulkFailed(res.json) ? EXIT.error : EXIT.ok;
  }
  line(io, `${p.green('✓')} ${res.json?.summary ?? 'Done'}`);
  const out = res.json?.output;
  if (out !== undefined && out !== null && !(typeof out === 'object' && !Object.keys(out).length))
    line(io, renderValue(out, 2));
  if (Array.isArray(res.json?.results)) {
    for (const [i, r] of (
      res.json.results as Array<{ ok: boolean; error?: { message?: string } }>
    ).entries())
      if (!r.ok) line(io, `  ${p.red('✗')} item ${i + 1}: ${r.error?.message ?? 'failed'}`);
  }
  const undo = res.json?.undo as { token: string; expiresAt: number } | undefined;
  if (undo) line(io, p.dim(`  Undo until ${when(undo.expiresAt)}: beamhop undo ${undo.token}`));
  return bulkFailed(res.json) ? EXIT.error : EXIT.ok;
}

function bulkFailed(body: { results?: Array<{ ok: boolean }> } | undefined): boolean {
  return !!body?.results?.some((r) => !r.ok);
}

export async function undoCommand(
  ctx: CliContext,
  client: AdminClient,
  token: string | undefined,
  flags: FlagValues,
): Promise<number> {
  if (!token) throw new UsageError('Usage: beamhop undo <token>');
  const res = await expectOk(client.request('POST', `${NODE}/undo/${encodeURIComponent(token)}`));
  if (bool(flags.json)) json(ctx.io, res.json);
  else line(ctx.io, `${paint(ctx.io).green('✓')} Undone: ${res.json?.undone ?? 'done'}`);
  return EXIT.ok;
}
