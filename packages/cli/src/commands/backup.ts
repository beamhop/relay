// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop backup now|list|restore`. Uses the lifecycle module's backup
 * actions when the node registers them; otherwise falls back to a local
 * snapshot: SQLite online backup (`VACUUM INTO`) + settings + keys + a blob
 * manifest, written to <dataDir>/backups (0600), pruned to `backups.keep`.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type FlagSpec, type FlagValues, bool, parseFlags, str } from '../args.ts';
import type { Catalog, CatalogEntry } from '../catalog.ts';
import { type AdminClient, remoteClient } from '../client.ts';
import { type CliContext, localOptions, resolveTarget } from '../context.ts';
import { bytes, json } from '../format.ts';
import { CliError, EXIT, UsageError, line, paint } from '../io.ts';
import { bootLocal, resolveLocalConfig, serverRunning } from '../local.ts';
import {
  blobInventory,
  blobsDirOf,
  countMismatches,
  createSnapshot,
  inspectSnapshot,
  restoreSnapshot,
  sqlitePathOf,
} from '../snapshot.ts';
import { fetchCatalog, runActionCommand } from './actions.ts';
import { previewAndConfirm } from './shared.ts';

const FLAGS: FlagSpec[] = [
  { name: 'to', type: 'string', description: 'Where to write the backup file' },
  {
    name: 'keys',
    type: 'boolean',
    description: 'Include node keys (default yes; --no-keys to leave out)',
  },
];

export const BACKUP_HELP = `Backups

  beamhop backup now [--to file] [--no-keys]   Make a backup now
  beamhop backup list                          Show backups
  beamhop backup restore <file> [--yes]        Put a backup back (the server must be stopped)

Uses the server's backup feature when it has one; otherwise makes a consistent
copy of the database, settings and keys plus a list of media files.
`;

const VERBS: Record<string, string[]> = {
  now: ['now', 'run', 'create'],
  list: ['list'],
  restore: ['restore'],
};

export function findLifecycleAction(catalog: Catalog, verb: string): CatalogEntry | undefined {
  const ids = (VERBS[verb] ?? [verb]).flatMap((v) => [
    `backups.${v}`,
    `backup.${v}`,
    `lifecycle.backup-${v}`,
    `lifecycle.backups-${v}`,
  ]);
  return catalog.actions.find((a) => ids.includes(a.id));
}

const stampOf = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Try the node's own backup action; returns null when none is registered (use the fallback). */
async function viaAction(
  ctx: CliContext,
  verb: string,
  rest: string[],
  globals: FlagValues,
): Promise<number | null> {
  const target = resolveTarget(ctx, globals);
  let client: AdminClient;
  if (ctx.client) client = await ctx.client();
  else if (target.kind === 'remote') client = remoteClient(target.url!, target.token, ctx.fetch);
  else {
    try {
      client = (await (ctx.bootLocal ?? bootLocal)(localOptions(ctx, globals))).client;
    } catch {
      return null; // server running or data dir missing: the fallback explains
    }
  }
  try {
    const entry = findLifecycleAction(await fetchCatalog(client), verb);
    if (!entry) {
      if (target.kind === 'remote' && !ctx.client)
        throw new CliError(
          'This server has no backup feature to call remotely. Run `beamhop backup now` on the server itself.',
        );
      return null;
    }
    return await runActionCommand(ctx, client, entry, rest, globals);
  } finally {
    await client.close();
  }
}

export async function backupCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const [verb, ...rest] = argv;
  if (!verb || !(verb in VERBS) || bool(globals.help)) {
    io.out(BACKUP_HELP);
    return verb && !(verb in VERBS) ? EXIT.usage : EXIT.ok;
  }
  // Lifecycle action first (its own flags), then the local fallback.
  const viaNode = await viaAction(ctx, verb, rest, globals);
  if (viaNode !== null) return viaNode;

  const { flags, positionals } = parseFlags(rest, FLAGS);
  const loaded = resolveLocalConfig(localOptions(ctx, globals));
  const config = loaded.config;
  const backupsDir = join(config.node.dataDir, 'backups');

  if (verb === 'now') {
    if (config.storage.driver !== 'sqlite')
      throw new CliError(
        `This server keeps its data in ${config.storage.driver}; back that up with its own tools (e.g. pg_dump).`,
      );
    const now = ctx.now();
    const out = resolve(
      ctx.cwd,
      str(flags.to) ?? join(backupsDir, `beamhop-backup-${stampOf(now)}.tar.gz`),
    );
    const m = await createSnapshot({
      kind: 'backup',
      config,
      ...(loaded.file ? { configFile: loaded.file } : {}),
      out,
      includeBlobs: false,
      includeKeys: flags.keys !== false,
      now,
    });
    // Keep the newest `backups.keep` automatic backups.
    const pruned: string[] = [];
    if (!str(flags.to)) {
      const mine = listBackups(backupsDir);
      for (const old of mine.slice(config.backups.keep)) {
        rmSync(old.path, { force: true });
        pruned.push(old.path);
      }
    }
    if (bool(globals.json))
      json(io, { file: out, manifest: { ...m, blobs: m.blobs.length }, pruned });
    else {
      line(io, `${p.green('✓')} Backup saved: ${out} (${bytes(statSync(out).size)})`);
      line(
        io,
        `  ${m.counts.events ?? 0} events, ${m.blobStorage.count} media files listed (${bytes(m.blobStorage.bytes)}; media files themselves are not copied).`,
      );
      if (pruned.length)
        line(
          io,
          p.dim(`  Removed ${pruned.length} older backup(s) (keeping ${config.backups.keep}).`),
        );
    }
    return EXIT.ok;
  }

  if (verb === 'list') {
    const items = listBackups(backupsDir);
    if (bool(globals.json)) json(io, { backups: items });
    else if (!items.length)
      line(io, `No backups in ${backupsDir} yet. Make one with \`beamhop backup now\`.`);
    else
      for (const b of items)
        line(
          io,
          `  ${b.createdAt.slice(0, 16).replace('T', ' ')}  ${bytes(b.size).padStart(8)}  ${b.path}`,
        );
    return EXIT.ok;
  }

  // restore
  const file = positionals[0];
  if (!file) throw new UsageError('Usage: beamhop backup restore <file>');
  const path = resolve(ctx.cwd, file);
  if (!existsSync(path)) throw new CliError(`${path} does not exist`);
  const running = await serverRunning(config, ctx.fetch);
  if (running)
    throw new CliError(`Stop the server first (it is running at ${running}), then restore.`);
  const { manifest, problems } = await inspectSnapshot(path);
  if (problems.length) throw new CliError(`This backup is damaged:\n  ${problems.join('\n  ')}`);
  const dbPath = sqlitePathOf(config);
  const d = await previewAndConfirm(
    ctx,
    globals,
    `Restore the backup from ${manifest.createdAt.slice(0, 16).replace('T', ' ')} UTC`,
    [
      {
        kind: 'change',
        text: `The database will be replaced by the backup (${manifest.counts.events ?? 0} events)`,
        technical: `${dbPath} ← data/db/beamhop.sqlite`,
      },
      {
        kind: 'info',
        text: 'The current database is kept next to it, so this can be reversed by hand',
      },
    ],
  );
  if (!d.apply) return d.exitCode;
  const r = await restoreSnapshot(path, {
    dataDir: config.node.dataDir,
    blobsDir: blobsDirOf(config),
    dbPath,
    only: ['data/db/', 'data/state.json'],
    now: ctx.now(),
  });
  const mismatches = countMismatches(manifest.counts, r.counts);
  if (mismatches.length)
    throw new CliError(
      `The restored database does not match the backup:\n  ${mismatches.join('\n  ')}`,
    );
  const have = new Set(
    config.blobStorage.driver === 'fs' ? blobInventory(blobsDirOf(config)).map(([h]) => h) : [],
  );
  const missing =
    config.blobStorage.driver === 'fs' ? manifest.blobs.filter(([h]) => !have.has(h)).length : 0;
  line(io, `${p.green('✓')} Restored. Counts match the backup.`);
  for (const a of r.movedAside) line(io, p.dim(`  Previous file kept as ${a}`));
  if (missing)
    line(
      io,
      p.yellow(`  ! ${missing} media file(s) listed in the backup are not in the media folder.`),
    );
  line(io, '  Start the server again with `beamhop serve`.');
  return EXIT.ok;
}

export function listBackups(dir: string): Array<{ path: string; size: number; createdAt: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^beamhop-backup-.*\.tar\.gz$/.test(n))
    .map((n) => {
      const st = statSync(join(dir, n));
      return { path: join(dir, n), size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.path.localeCompare(a.path));
}
