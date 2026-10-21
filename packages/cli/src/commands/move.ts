// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop move` (§16 "Move / clone relay"): export everything (settings,
 * database snapshot, media files, node keys) to one .tar.gz — locally or to
 * an S3-compatible bucket — import it on the new host, verify every file's
 * SHA-256 and the database row counts, then explain the DNS switch.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localPublicIps } from '@beamhop/runtime-bun';
import { AwsClient } from 'aws4fetch';
import { type FlagSpec, type FlagValues, bool, parseFlags, str } from '../args.ts';
import { type CliContext, localOptions } from '../context.ts';
import { bytes, json } from '../format.ts';
import { CliError, EXIT, UsageError, line, paint } from '../io.ts';
import { resolveLocalConfig, serverRunning } from '../local.ts';
import {
  type SnapshotManifest,
  blobInventory,
  blobsDirOf,
  countMismatches,
  createSnapshot,
  inspectSnapshot,
  restoreSnapshot,
  sqlitePathOf,
} from '../snapshot.ts';
import { previewAndConfirm } from './shared.ts';

const FLAGS: FlagSpec[] = [
  { name: 'to', type: 'string', description: 'File or s3://bucket/key to write' },
  {
    name: 'blobs',
    type: 'boolean',
    description: 'Include media files (default yes; --no-blobs to skip)',
  },
  {
    name: 'endpoint',
    type: 'string',
    description: 'S3 endpoint (default $AWS_ENDPOINT_URL or AWS)',
  },
  { name: 'force', type: 'boolean', description: 'Import even if this host already has data' },
];

export const MOVE_HELP = `Move this relay to another server

  On the old server:  beamhop move export [--to file.tar.gz | s3://bucket/key] [--no-blobs]
  On the new server:  beamhop move import <file | s3://bucket/key> [--yes]
  Check a file:       beamhop move verify <file>

The file contains settings, the database, media files and the server's keys:
keep it private. S3 uses $AWS_ACCESS_KEY_ID, $AWS_SECRET_ACCESS_KEY, $AWS_REGION.
`;

interface S3Target {
  bucket: string;
  key: string;
}

export function parseS3(url: string): S3Target | null {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(url);
  return m ? { bucket: m[1]!, key: m[2]! } : null;
}

function s3Client(ctx: CliContext, flags: FlagValues): { aws: AwsClient; endpoint: string } {
  const accessKeyId = ctx.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = ctx.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey)
    throw new UsageError('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to use an S3 bucket.');
  const region = ctx.env.AWS_REGION ?? 'us-east-1';
  const endpoint = (
    str(flags.endpoint) ??
    ctx.env.AWS_ENDPOINT_URL ??
    `https://s3.${region}.amazonaws.com`
  ).replace(/\/+$/, '');
  const opts: ConstructorParameters<typeof AwsClient>[0] = {
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region,
  };
  if (ctx.env.AWS_SESSION_TOKEN) opts.sessionToken = ctx.env.AWS_SESSION_TOKEN;
  return { aws: new AwsClient(opts), endpoint };
}

const objectUrl = (endpoint: string, t: S3Target) =>
  `${endpoint}/${t.bucket}/${t.key.split('/').map(encodeURIComponent).join('/')}`;

export async function s3Upload(
  ctx: CliContext,
  flags: FlagValues,
  t: S3Target,
  file: string,
): Promise<void> {
  const { aws, endpoint } = s3Client(ctx, flags);
  const signed = await aws.sign(objectUrl(endpoint, t), {
    method: 'PUT',
    headers: {
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'content-type': 'application/gzip',
      'content-length': String(statSync(file).size),
    },
  });
  const res = await ctx.fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: Bun.file(file),
  });
  if (!res.ok)
    throw new CliError(
      'Uploading to the bucket failed.',
      1,
      `PUT ${t.bucket}/${t.key}: HTTP ${res.status} ${await res.text().catch(() => '')}`,
    );
}

export async function s3Download(
  ctx: CliContext,
  flags: FlagValues,
  t: S3Target,
  dest: string,
): Promise<void> {
  const { aws, endpoint } = s3Client(ctx, flags);
  const signed = await aws.sign(objectUrl(endpoint, t), {
    method: 'GET',
    headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  });
  const res = await ctx.fetch(signed.url, { method: 'GET', headers: signed.headers });
  if (!res.ok)
    throw new CliError(
      'Downloading from the bucket failed.',
      1,
      `GET ${t.bucket}/${t.key}: HTTP ${res.status}`,
    );
  await Bun.write(dest, res);
}

const stampOf = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function domainsFromYaml(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  try {
    const doc = Bun.YAML.parse(readFileSync(path, 'utf8')) as {
      relays?: Array<{ hosts?: string[] }>;
    };
    return [
      ...new Set(
        (doc?.relays ?? [])
          .flatMap((r) => r.hosts ?? [])
          .filter((h) => h !== '*' && !h.includes('*')),
      ),
    ];
  } catch {
    return [];
  }
}

export function dnsInstructions(domains: string[], ips: string[]): string[] {
  const out = ['Switch your domain to this server:'];
  if (!domains.length)
    out.push('  (No domain is configured; set one in beamhop.yaml or the admin app.)');
  const v4 = ips.filter((ip) => !ip.includes(':'));
  const v6 = ips.filter((ip) => ip.includes(':'));
  for (const d of domains) {
    if (!ips.length) out.push(`  ${d}  →  this server's public address`);
    for (const ip of v4) out.push(`  ${d}  A     ${ip}`);
    for (const ip of v6) out.push(`  ${d}  AAAA  ${ip}`);
  }
  out.push(
    '  1. Start Beamhop here (`beamhop serve`) and run `beamhop doctor`.',
    '  2. Change the DNS records above at your domain provider.',
    '  3. Keep the old server running until the change has spread (up to the old TTL, often an hour), then stop it.',
    '  4. Run `beamhop doctor` again to confirm the certificate and connections.',
  );
  return out;
}

function summarize(m: SnapshotManifest): string {
  return `${m.counts.events ?? 0} events, ${m.blobStorage.count} media files (${bytes(m.blobStorage.bytes)}${m.blobStorage.included ? '' : ', not included'}), ${m.files.length} files in total`;
}

export async function moveCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const { flags: own, positionals } = parseFlags(argv, FLAGS);
  const flags = { ...globals, ...own };
  let [sub, arg] = positionals;
  if (!sub && io.interactive && !bool(globals.help)) {
    io.out(MOVE_HELP);
    const a = (
      await io.prompt('Is this the old server (export) or the new one (import)?', 'export')
    )
      .trim()
      .toLowerCase();
    sub = a.startsWith('i') ? 'import' : 'export';
    if (sub === 'import') arg = (await io.prompt('Path or s3:// address of the move file')).trim();
  }
  if (!sub || bool(globals.help)) {
    io.out(MOVE_HELP);
    return sub || bool(globals.help) ? EXIT.ok : EXIT.usage;
  }

  if (sub === 'export') {
    const loaded = resolveLocalConfig(localOptions(ctx, globals));
    const config = loaded.config;
    if (config.storage.driver === 'memory')
      throw new CliError('This server keeps its data in memory; there is nothing to move.');
    const now = ctx.now();
    const to = str(flags.to);
    const s3 = to ? parseS3(to) : null;
    const out =
      s3 || !to
        ? resolve(config.node.dataDir, 'backups', `beamhop-move-${stampOf(now)}.tar.gz`)
        : resolve(ctx.cwd, to);
    const running = await serverRunning(config, ctx.fetch);
    if (running)
      io.err(
        p.yellow(
          '! The server is running: anything posted after this moment will not be in the file. For a clean move, stop it first.\n',
        ),
      );
    if (config.storage.driver !== 'sqlite')
      io.err(
        p.yellow(
          `! The database (${config.storage.driver}) is not included; move it with its own tools (e.g. pg_dump).\n`,
        ),
      );
    if (config.blobStorage.driver !== 'fs')
      io.err(
        p.dim(
          `  Media files stay in your ${config.blobStorage.driver} bucket; the new server just needs the same settings.\n`,
        ),
      );
    const m = await createSnapshot({
      kind: 'move',
      config,
      ...(loaded.file ? { configFile: loaded.file } : {}),
      out,
      includeBlobs: flags.blobs !== false,
      includeKeys: true,
      now,
    });
    let where = out;
    if (s3) {
      try {
        await s3Upload(ctx, flags, s3, out);
      } finally {
        rmSync(out, { force: true });
      }
      where = to!;
    }
    if (bool(globals.json)) {
      json(io, { file: where, manifest: { ...m, blobs: m.blobs.length } });
      return EXIT.ok;
    }
    line(io, `${p.green('✓')} Exported to ${where}${s3 ? '' : ` (${bytes(statSync(out).size)})`}`);
    line(io, `  ${summarize(m)}`);
    line(io, p.yellow('  This file contains the server’s keys and settings: keep it private.'));
    line(io, '\nNext, on the new server:');
    line(io, '  1. Install Beamhop:  curl -fsSL https://get.beamhop.dev | sh');
    if (!s3) line(io, `  2. Copy the file:    scp ${where} <new-server>:`);
    line(io, `  ${s3 ? 2 : 3}. Import it:        beamhop move import ${s3 ? to : '<file>'}`);
    return EXIT.ok;
  }

  if (sub === 'verify' || sub === 'import') {
    if (!arg) throw new UsageError(`Usage: beamhop move ${sub} <file | s3://bucket/key>`);
    const s3 = parseS3(arg);
    let file = resolve(ctx.cwd, arg);
    let downloaded: string | null = null;
    if (s3) {
      downloaded = join(ctx.env.TMPDIR ?? tmpdir(), `beamhop-move-${process.pid}.tar.gz`);
      await s3Download(ctx, flags, s3, downloaded);
      file = downloaded;
    }
    try {
      if (!existsSync(file)) throw new CliError(`${file} does not exist`);
      const { manifest, problems } = await inspectSnapshot(file);
      if (problems.length)
        throw new CliError(
          `The file failed its integrity check:\n  ${problems.slice(0, 10).join('\n  ')}`,
        );
      if (sub === 'verify') {
        if (bool(globals.json))
          json(io, { ok: true, manifest: { ...manifest, blobs: manifest.blobs.length } });
        else
          line(
            io,
            `${p.green('✓')} All ${manifest.files.length} files are intact. ${summarize(manifest)}.`,
          );
        return EXIT.ok;
      }
      // import
      const configDest0 = resolve(ctx.cwd, str(globals.config) ?? 'beamhop.yaml');
      const hasYaml = manifest.files.some((f) => f.path === 'beamhop.yaml');
      const configDest =
        hasYaml && existsSync(configDest0) && !bool(flags.force)
          ? resolve(ctx.cwd, 'beamhop.imported.yaml')
          : configDest0;
      const loaded = (() => {
        try {
          return resolveLocalConfig(localOptions(ctx, globals));
        } catch {
          return null;
        }
      })();
      const dataDir = resolve(
        ctx.cwd,
        str(globals['data-dir']) ?? loaded?.config.node.dataDir ?? './data',
      );
      const target = loaded ? { ...loaded.config, node: { ...loaded.config.node, dataDir } } : null;
      const dbPath = target ? sqlitePathOf(target) : join(dataDir, 'db', 'beamhop.sqlite');
      const blobsDir =
        target && target.blobStorage.driver === 'fs' ? blobsDirOf(target) : join(dataDir, 'blobs');
      if (target && (await serverRunning(target, ctx.fetch)))
        throw new CliError('Stop the server on this host before importing.');
      if (existsSync(dbPath) && !bool(flags.force))
        throw new CliError(
          `This host already has a database (${dbPath}). Use --force to replace it (the old one is kept next to it).`,
        );
      const d = await previewAndConfirm(ctx, flags, 'Import the relay', [
        {
          kind: 'add',
          text: `Settings, database and keys into ${dataDir}`,
          technical: `db → ${dbPath}`,
        },
        { kind: 'add', text: summarize(manifest) },
        ...(configDest !== configDest0
          ? [
              {
                kind: 'info' as const,
                text: `Your existing beamhop.yaml is kept; the imported one is saved as ${configDest}`,
              },
            ]
          : []),
      ]);
      if (!d.apply) return d.exitCode;
      const r = await restoreSnapshot(file, {
        dataDir,
        blobsDir,
        dbPath,
        configDest,
        now: ctx.now(),
      });
      const mismatches = countMismatches(manifest.counts, r.counts);
      const haveBlobs = manifest.blobStorage.included
        ? blobInventory(blobsDir).length
        : manifest.blobStorage.count;
      if (manifest.blobStorage.included && haveBlobs < manifest.blobStorage.count)
        mismatches.push(`media files: expected ${manifest.blobStorage.count}, found ${haveBlobs}`);
      if (mismatches.length)
        throw new CliError(`The import does not match the export:\n  ${mismatches.join('\n  ')}`);
      // The imported settings may name the old host's data folder: point it here.
      if (hasYaml && existsSync(configDest)) {
        const text = readFileSync(configDest, 'utf8');
        const fixed = text.replace(/^(\s+dataDir:\s*).*$/m, `$1${JSON.stringify(dataDir)}`);
        if (fixed !== text) writeFileSync(configDest, fixed, { mode: 0o600 });
      }
      const ips = (ctx.env.BEAMHOP_PUBLIC_IP ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const domains = domainsFromYaml(hasYaml ? configDest : configDest0);
      if (bool(globals.json)) {
        json(io, {
          imported: true,
          dataDir,
          restored: r.restored.length,
          counts: r.counts,
          domains,
        });
        return EXIT.ok;
      }
      line(
        io,
        `${p.green('✓')} Imported and verified: ${summarize(manifest)}; database counts match.`,
      );
      for (const a of r.movedAside) line(io, p.dim(`  Previous file kept as ${a}`));
      line(io, '');
      for (const l of dnsInstructions(domains, ips.length ? ips : localPublicIps())) line(io, l);
      return EXIT.ok;
    } finally {
      if (downloaded) rmSync(downloaded, { force: true });
    }
  }
  io.out(MOVE_HELP);
  return EXIT.usage;
}
