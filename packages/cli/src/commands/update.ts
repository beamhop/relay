// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop update` / `beamhop rollback` for the single binary.
 *
 * update: release manifest → download next to the binary → verify SHA-256
 * and the minisign signature → smoke test the new binary (`--version` must report the
 * release; `--healthcheck` must pass when a server is running) → keep the
 * current binary as `<bin>.previous` → atomic rename over `<bin>`.
 * rollback: put `<bin>.previous` back (the replaced one is kept as `<bin>.rolled-back`).
 *
 * Manifest URL: --manifest, $BEAMHOP_UPDATE_MANIFEST, `modules.updates.manifestUrl`
 * in beamhop.yaml, else the default below. Format:
 *   { "version": "0.2.0", "notes": "…", "assets": { "linux-x64": { "url", "sha256", "signature"? } } }
 * Asset and signature URLs may be relative to the manifest URL. `signature` is the
 * minisign `.minisig` text, or a URL/path of it.
 *
 * Signatures (minisign, Ed25519): the release public key comes from
 * $BEAMHOP_UPDATE_PUBLIC_KEY, `modules.updates.publicKey`, else the built-in
 * {@link RELEASE_PUBLIC_KEY}. Once a key is known, unsigned downloads are refused
 * unless `--allow-unsigned` is given; a bad signature is always refused.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { VERSION } from '@beamhop/runtime-bun';
import { type FlagSpec, type FlagValues, bool, parseFlags, str } from '../args.ts';
import type { FetchLike } from '../client.ts';
import { type CliContext, localOptions } from '../context.ts';
import { json } from '../format.ts';
import { CliError, EXIT, UsageError, line, paint } from '../io.ts';
import { resolveLocalConfig, serverRunning } from '../local.ts';
import { verifyMinisign } from '../minisign.ts';

export const DEFAULT_MANIFEST_URL = 'https://get.beamhop.dev/releases/latest.json';

/**
 * Built-in release signing key (minisign public key line, `RW…`). Placeholder:
 * empty until the project publishes its release key; set `modules.updates.publicKey`
 * (or $BEAMHOP_UPDATE_PUBLIC_KEY) to require signatures today.
 */
export const RELEASE_PUBLIC_KEY = '';

export interface ReleaseAsset {
  url: string;
  sha256: string;
  signature?: string;
}

export interface ReleaseManifest {
  version: string;
  notes?: string;
  assets: Record<string, ReleaseAsset>;
}

export interface UpdateDeps {
  /** Run a binary with args; resolves exit code + stdout. */
  run?: (
    bin: string,
    args: string[],
    env: Record<string, string | undefined>,
  ) => Promise<{ code: number; stdout: string }>;
  /** Signature check override (tests). Default: minisign with the configured public key. */
  verifySignature?: (
    asset: ReleaseAsset,
    sha256: string,
    data: Uint8Array,
  ) => Promise<'ok' | 'unsigned' | 'bad'>;
  /** Is a server running (decides whether --healthcheck must pass). */
  serverUrl?: () => Promise<string | null>;
  platform?: string;
  currentVersion?: string;
}

const FLAGS: FlagSpec[] = [
  { name: 'manifest', type: 'string', description: 'Release manifest URL' },
  { name: 'binary', type: 'string', description: 'Binary to update (default: this one)' },
  { name: 'check', type: 'boolean', description: 'Only check for a newer version' },
  { name: 'force', type: 'boolean', description: 'Install even if not newer' },
  {
    name: 'allow-unsigned',
    type: 'boolean',
    description: 'Install a release without a signature even though a release key is set',
  },
];

export function hostPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

/** -1 / 0 / 1; pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

async function defaultRun(bin: string, args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn([bin, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout };
}

interface UpdatesSettings {
  manifestUrl?: string;
  publicKey?: string;
}

function updatesSettings(ctx: CliContext, globals: FlagValues): UpdatesSettings {
  try {
    return (
      (resolveLocalConfig(localOptions(ctx, globals)).config.modules.updates as
        | UpdatesSettings
        | undefined) ?? {}
    );
  } catch {
    return {}; // no settings file
  }
}

function manifestUrl(ctx: CliContext, flags: FlagValues, globals: FlagValues): string {
  const flag = str(flags.manifest) ?? ctx.env.BEAMHOP_UPDATE_MANIFEST;
  if (flag) return flag;
  return updatesSettings(ctx, globals).manifestUrl || DEFAULT_MANIFEST_URL;
}

/** Release public key: env, then `modules.updates.publicKey`, then the built-in one. */
export function releasePublicKey(ctx: CliContext, globals: FlagValues): string | null {
  const k =
    ctx.env.BEAMHOP_UPDATE_PUBLIC_KEY?.trim() ||
    updatesSettings(ctx, globals).publicKey?.trim() ||
    RELEASE_PUBLIC_KEY;
  return k || null;
}

/** Resolve an asset/signature URL that may be relative to the manifest URL. */
export function resolveAgainst(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

const looksLikeLocation = (s: string) =>
  !s.includes('\n') &&
  (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\.minisig(\?.*)?$/.test(s) || /^\.{0,2}\//.test(s));

/** The `.minisig` text for an asset (inline, or fetched from a URL relative to the manifest). */
export async function signatureText(
  fetchFn: FetchLike,
  asset: ReleaseAsset,
  manifest: string,
): Promise<string | null> {
  const s = asset.signature?.trim();
  if (!s) return null;
  if (!looksLikeLocation(s)) return s;
  const url = resolveAgainst(s, manifest);
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new CliError('Could not download the release signature.', 1, `${url}: ${String(err)}`);
  }
  if (!res.ok)
    throw new CliError(
      'Could not download the release signature.',
      1,
      `${url}: HTTP ${res.status}`,
    );
  return res.text();
}

export async function fetchManifest(fetchFn: FetchLike, url: string): Promise<ReleaseManifest> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new CliError('Could not reach the release server.', 1, `${url}: ${String(err)}`);
  }
  if (!res.ok)
    throw new CliError(
      'The release server did not answer properly.',
      1,
      `${url}: HTTP ${res.status}`,
    );
  const m = (await res.json()) as ReleaseManifest;
  if (!m?.version || !m.assets) throw new CliError('The release information is not valid.', 1, url);
  return m;
}

function binaryPath(ctx: CliContext, flags: FlagValues): string {
  const bin = str(flags.binary) ?? ctx.execPath ?? process.execPath;
  if (!str(flags.binary) && /^bun(\.exe)?$/.test(basename(bin)))
    throw new CliError(
      'Beamhop is running from source (bun), not as a single binary. Update with git instead.',
    );
  return bin;
}

export async function updateCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
  deps: UpdateDeps = {},
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const { flags } = parseFlags(argv, FLAGS);
  const current = deps.currentVersion ?? VERSION;
  const mUrl = manifestUrl(ctx, flags, globals);
  const manifest = await fetchManifest(ctx.fetch, mUrl);
  const newer = compareVersions(manifest.version, current) > 0;
  if (bool(flags.check) || (!newer && !bool(flags.force))) {
    if (bool(globals.json))
      json(io, {
        current,
        latest: manifest.version,
        updateAvailable: newer,
        notes: manifest.notes,
      });
    else if (newer) {
      line(io, `Version ${manifest.version} is available (you have ${current}).`);
      if (manifest.notes) line(io, `\n${manifest.notes.trim()}\n`);
      line(io, 'Install it with `beamhop update`.');
    } else line(io, `${p.green('✓')} You have the latest version (${current}).`);
    return EXIT.ok;
  }
  const platform = deps.platform ?? hostPlatform();
  const listed = manifest.assets[platform];
  if (!listed)
    throw new CliError(`There is no ${manifest.version} download for this system (${platform}).`);
  const asset: ReleaseAsset = { ...listed, url: resolveAgainst(listed.url, mUrl) };
  const publicKey = releasePublicKey(ctx, globals);
  const sigText = deps.verifySignature ? null : await signatureText(ctx.fetch, asset, mUrl);
  if (!deps.verifySignature && publicKey && !sigText && !bool(flags['allow-unsigned']))
    throw new CliError(
      'This release is not signed, so it was not installed. Use --allow-unsigned to install it anyway.',
      1,
      `manifest ${mUrl}: assets.${platform}.signature is missing`,
    );
  const bin = binaryPath(ctx, flags);
  if (!existsSync(bin)) throw new UsageError(`${bin} does not exist`);
  const tmp = join(dirname(bin), `.${basename(bin)}.download-${process.pid}`);

  line(io, `Updating Beamhop ${current} → ${manifest.version}`);
  if (manifest.notes)
    line(
      io,
      p.dim(
        manifest.notes
          .trim()
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      ),
    );
  try {
    // 1. Download.
    const res = await ctx.fetch(asset.url).catch((err) => {
      throw new CliError('The download failed.', 1, String(err));
    });
    if (!res.ok || !res.body) throw new CliError('The download failed.', 1, `HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    writeFileSync(tmp, data, { mode: 0o755 });
    // 2. Verify.
    const sha = new Bun.CryptoHasher('sha256').update(data).digest('hex');
    if (sha !== asset.sha256.toLowerCase())
      throw new CliError(
        'The download is damaged (checksum mismatch); nothing was changed.',
        1,
        `sha256 ${sha} ≠ ${asset.sha256}`,
      );
    let why = '';
    const verify =
      deps.verifySignature ??
      (async (): Promise<'ok' | 'unsigned' | 'bad'> => {
        if (!publicKey || !sigText) return 'unsigned';
        const r = verifyMinisign(data, sigText, publicKey);
        if (!r.ok) why = r.reason;
        return r.ok ? 'ok' : 'bad';
      });
    const sig = await verify(asset, sha, data);
    if (sig === 'bad')
      throw new CliError(
        'The download is not signed by Beamhop; nothing was changed.',
        1,
        why || 'signature check failed',
      );
    if (sig === 'unsigned')
      line(
        io,
        p.dim(
          publicKey
            ? '  Checksum verified; the release is NOT signed (--allow-unsigned).'
            : '  Checksum verified (no release key is set, so signatures are not checked).',
        ),
      );
    else line(io, p.dim('  Checksum and signature verified.'));
    chmodSync(tmp, 0o755);
    // 3. Smoke test the new binary before it replaces anything.
    const run = deps.run ?? defaultRun;
    const v = await run(tmp, ['--version'], { ...ctx.env });
    if (v.code !== 0 || !v.stdout.includes(manifest.version.replace(/^v/, '')))
      throw new CliError(
        'The new version did not start correctly; nothing was changed.',
        1,
        `--version → exit ${v.code}: ${v.stdout.trim()}`,
      );
    const running = await (
      deps.serverUrl ??
      (async () => {
        try {
          return await serverRunning(
            resolveLocalConfig(localOptions(ctx, globals)).config,
            ctx.fetch,
          );
        } catch {
          return null;
        }
      })
    )();
    if (running) {
      const hc = await run(tmp, ['--healthcheck'], {
        ...ctx.env,
        BEAMHOP_LISTEN: new URL(running).host,
      });
      if (hc.code !== 0)
        throw new CliError(
          'The new version failed its health check; nothing was changed.',
          1,
          `--healthcheck → exit ${hc.code}`,
        );
    }
    // 4. Swap atomically, keeping the current binary for rollback.
    const previous = `${bin}.previous`;
    copyFileSync(bin, `${previous}.tmp`);
    chmodSync(`${previous}.tmp`, 0o755);
    renameSync(`${previous}.tmp`, previous);
    writeFileSync(
      `${previous}.json`,
      JSON.stringify({ version: current, replacedAt: new Date(ctx.now()).toISOString() }),
    );
    renameSync(tmp, bin);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${bin}.previous.tmp`, { force: true });
  }
  if (bool(globals.json))
    json(io, { updated: true, from: current, to: manifest.version, previous: `${bin}.previous` });
  else {
    line(
      io,
      `${p.green('✓')} Installed ${manifest.version}. The previous version is kept for \`beamhop rollback\`.`,
    );
    line(
      io,
      '  Restart the service to use it (e.g. `systemctl restart beamhop`); if anything looks wrong, run `beamhop rollback`.',
    );
  }
  return EXIT.ok;
}

export async function rollbackCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const { io } = ctx;
  const { flags } = parseFlags(argv, FLAGS);
  const bin = binaryPath(ctx, flags);
  const previous = `${bin}.previous`;
  if (!existsSync(previous)) throw new CliError('There is no previous version to go back to.');
  let version = 'the previous version';
  try {
    version = (JSON.parse(readFileSync(`${previous}.json`, 'utf8')) as { version: string }).version;
  } catch {
    // unknown
  }
  copyFileSync(bin, `${bin}.rolled-back.tmp`);
  renameSync(`${bin}.rolled-back.tmp`, `${bin}.rolled-back`);
  renameSync(previous, bin);
  rmSync(`${previous}.json`, { force: true });
  if (bool(globals.json)) json(io, { rolledBack: true, version });
  else {
    line(io, `${paint(io).green('✓')} Went back to ${version}. Restart the service to use it.`);
    line(io, paint(io).dim(`  The version you left is kept as ${bin}.rolled-back`));
  }
  return EXIT.ok;
}
