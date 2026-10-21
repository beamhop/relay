#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release tooling: build every target, then write checksums, optional signatures and the
 * update manifest that `beamhop update` reads.
 *
 *   bun scripts/release.ts --version 0.2.0                  # build all targets into dist/release
 *   bun scripts/release.ts --version 0.2.0 --skip-build     # binaries already in dist/release/v0.2.0
 *   bun scripts/release.ts --version 0.2.0 --target linux-x64,linux-arm64 --notes-file NOTES.md
 *
 * Output (upload everything under v<version>/ plus latest.json as release assets):
 *   dist/release/v<version>/beamhop-<os>-<arch>[.exe]   the single-file binaries (the download,
 *                                                         and what `beamhop update` swaps in)
 *   dist/release/v<version>/SHA256SUMS                    `sha256  filename` lines
 *   dist/release/v<version>/<binary>.minisig              when MINISIGN_KEY_FILE is set
 *   dist/release/latest.json                              { version, notes, assets:{<os-arch>:{url,sha256,signature?}} }
 *
 * Asset URLs default to the GitHub release download URL; pass --base-url to host elsewhere
 * (the air-gap bundle uses file:// URLs). Signatures use minisign; the manifest carries the
 * full .minisig text so offline verification needs no second download.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { ReleaseManifest } from '../packages/cli/src/index.ts';

export const REPO = 'beamhop/beamhop';
export const ROOT = resolve(import.meta.dir, '..');
export const BUILD_SCRIPT = join(ROOT, 'packages/runtime-bun/scripts/build.ts');

/** Targets published for every release. Keys match `hostPlatform()` in the CLI. */
export const RELEASE_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'windows-x64',
] as const;

export function assetName(target: string): string {
  return `beamhop-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `SHA256SUMS` text (GNU coreutils format, sorted by file name). */
export function checksumsText(sums: Record<string, string>): string {
  return `${Object.keys(sums)
    .sort()
    .map((f) => `${sums[f]}  ${f}`)
    .join('\n')}\n`;
}

export function defaultBaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}`;
}

export interface BuiltAsset {
  target: string;
  file: string;
  sha256: string;
  signature?: string;
}

export function buildManifest(opts: {
  version: string;
  notes?: string;
  baseUrl: string;
  assets: BuiltAsset[];
}): ReleaseManifest {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const assets: ReleaseManifest['assets'] = {};
  for (const a of opts.assets) {
    assets[a.target] = {
      url: `${base}/${a.file}`,
      sha256: a.sha256,
      ...(a.signature ? { signature: a.signature } : {}),
    };
  }
  return {
    version: opts.version,
    ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
    assets,
  };
}

/** Sign with minisign when a secret key file is available; returns the .minisig text. */
export function signFile(
  file: string,
  keyFile: string | undefined,
  password = process.env.MINISIGN_PASSWORD,
): string | undefined {
  if (!keyFile) return undefined;
  if (!Bun.which('minisign')) throw new Error('MINISIGN_KEY_FILE is set but minisign is missing');
  const proc = Bun.spawnSync(
    ['minisign', '-S', '-s', keyFile, '-m', file, '-t', `beamhop ${file.split('/').pop()}`],
    { stdin: password ? new TextEncoder().encode(`${password}\n`) : 'ignore' },
  );
  if (proc.exitCode !== 0) throw new Error(`minisign failed: ${proc.stderr.toString()}`);
  return readFileSync(`${file}.minisig`, 'utf8');
}

/** Write SHA256SUMS (+ signatures) for the binaries in `dir`; returns the asset list. */
export function finalizeDir(dir: string, targets: readonly string[], keyFile?: string) {
  const assets: BuiltAsset[] = [];
  const sums: Record<string, string> = {};
  for (const target of targets) {
    const file = assetName(target);
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`missing binary: ${path}`);
    const sha256 = sha256File(path);
    sums[file] = sha256;
    assets.push({ target, file, sha256, signature: signFile(path, keyFile) });
  }
  writeFileSync(join(dir, 'SHA256SUMS'), checksumsText(sums));
  if (keyFile) signFile(join(dir, 'SHA256SUMS'), keyFile);
  return assets;
}

export async function build(
  targets: readonly string[],
  outDir: string,
  version: string,
): Promise<void> {
  const proc = Bun.spawn(
    [
      process.execPath,
      BUILD_SCRIPT,
      '--target',
      targets.join(','),
      '--outdir',
      outDir,
      '--version',
      version,
    ],
    {
      cwd: ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, BEAMHOP_BUILD_VERSION: version },
    },
  );
  if ((await proc.exited) !== 0) throw new Error('build failed');
  // Keep the release folder to uploadable files: drop the generated entry, park source maps
  // next to it (useful for crash reports, not for users).
  rmSync(join(outDir, '.gen'), { recursive: true, force: true });
  const maps = join(outDir, '..', 'sourcemaps', basename(outDir));
  for (const f of readdirSync(outDir).filter((n) => n.endsWith('.map'))) {
    mkdirSync(maps, { recursive: true });
    renameSync(join(outDir, f), join(maps, f));
  }
  // Bun appends .exe for Windows targets on its own; normalise if it did not.
  for (const t of targets) {
    const want = join(outDir, assetName(t));
    const plain = join(outDir, `beamhop-${t}`);
    if (!existsSync(want) && existsSync(plain)) await Bun.write(want, Bun.file(plain));
  }
}

/** The host binary must report the release version, or `beamhop update` rejects it. */
function checkHostVersion(dir: string, version: string): void {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const host = `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const bin = join(dir, assetName(host));
  if (!existsSync(bin)) return;
  const out = Bun.spawnSync([bin, '--version']).stdout.toString().trim();
  if (!out.includes(version)) {
    const msg = `${assetName(host)} --version prints "${out}", not ${version}; \`beamhop update\` will reject it until runtime-bun embeds the build version (see scripts/README.md).`;
    console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `warning: ${msg}`);
  }
}

export interface ReleaseArgs {
  version: string;
  targets: string[];
  outDir: string;
  baseUrl?: string;
  notes?: string;
  skipBuild: boolean;
}

export function parseReleaseArgs(argv: string[], env = process.env): ReleaseArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = (get('version') ?? env.GITHUB_REF_NAME ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`--version must be semver (got "${version}")`);
  const notesFile = get('notes-file');
  return {
    version,
    targets: (get('target') ?? RELEASE_TARGETS.join(',')).split(',').filter(Boolean),
    outDir: resolve(get('outdir') ?? join(ROOT, 'dist/release')),
    baseUrl: get('base-url'),
    notes: notesFile ? readFileSync(notesFile, 'utf8') : get('notes'),
    skipBuild: argv.includes('--skip-build'),
  };
}

export async function release(args: ReleaseArgs, keyFile = process.env.MINISIGN_KEY_FILE) {
  const dir = join(args.outDir, `v${args.version}`);
  mkdirSync(dir, { recursive: true });
  if (!args.skipBuild) await build(args.targets, dir, args.version);
  checkHostVersion(dir, args.version);
  const assets = finalizeDir(dir, args.targets, keyFile);
  const manifest = buildManifest({
    version: args.version,
    notes: args.notes,
    baseUrl: args.baseUrl ?? defaultBaseUrl(args.version),
    assets,
  });
  writeFileSync(join(args.outDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // A copy next to the binaries so every release directory is self-describing.
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest, files: readdirSync(dir).sort() };
}

if (import.meta.main) {
  const args = parseReleaseArgs(process.argv.slice(2));
  const { dir, files } = await release(args);
  console.log(`release ${args.version} ready in ${dir}:\n  ${files.join('\n  ')}`);
}
