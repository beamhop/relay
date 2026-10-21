#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline (air-gapped) bundle: everything needed to install, run and update Beamhop on a
 * network with no internet access. Built on a connected machine, carried across, verified.
 *
 *   bun scripts/airgap-bundle.ts --version 0.2.0
 *   bun scripts/airgap-bundle.ts --version 0.2.0 --target linux-x64 --release-dir dist/release/v0.2.0
 *
 * Options
 *   --version <v>         release version (required)
 *   --target <list>       comma-separated targets (default linux-x64,linux-arm64)
 *   --release-dir <dir>   take binaries from here (e.g. the output of scripts/release.ts);
 *                         without it the binaries are built
 *   --base-url <url>      where the bundle will live on the servers
 *                         (default file:///opt/beamhop/bundle) — used in the update manifest
 *   --pwa-dir <dir>       admin app build (default packages/pwa/build)
 *   --team-dir <dir>      team client build (default packages/team-client/build)
 *   --catalog <file>      plugin catalog snapshot (JSON); default: an empty catalog
 *   --plugins-dir <dir>   plugin packages (*.tgz) referenced by the catalog
 *   --litestream-dir <d>  Litestream packages to include (otherwise instructions only)
 *   --out <dir>           output directory (default dist/airgap)
 *
 * Output: <out>/beamhop-airgap-<version>.tar.gz (+ .sha256, + .minisig with MINISIGN_KEY_FILE).
 * Inside: releases/latest/ (binaries + SHA256SUMS, the layout install.sh expects),
 * releases/latest.json (for `beamhop update`), web/, plugins/, litestream/, config/,
 * docs/, install.sh, SHA256SUMS of every file, BUNDLE.json.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  ROOT,
  assetName,
  build,
  buildManifest,
  checksumsText,
  finalizeDir,
  sha256File,
  signFile,
} from './release.ts';

export const DEFAULT_BASE_URL = 'file:///opt/beamhop/bundle';
export const DEFAULT_TARGETS = ['linux-x64', 'linux-arm64'];

/** Settings for a network without internet access (§12.12). */
export function airgapConfig(baseUrl: string, version: string): string {
  return `# Beamhop settings for an air-gapped network (bundle ${version}).
# Copy to /var/lib/beamhop/beamhop.yaml (systemd install) or <data-dir>/beamhop.yaml.
# Nothing here calls the internet; review the commented lines for your network.

node:
  tls:
    # No public certificate authority is reachable, so automatic certificates (ACME) are off.
    # Put Beamhop behind your internal TLS proxy ("proxy"), or use "off" for plain HTTP.
    mode: proxy
  trustProxy: true

ai:
  # Optional assistant on your own Ollama server (OpenAI-compatible API). Off by default.
  enabled: false
  baseUrl: http://ollama.internal:11434/v1
  model: llama3.1:8b

alerts:
  # Web push and Telegram/Discord/Slack need the internet. Use email via your SMTP relay
  # or Nostr DMs to an internal relay.
  channels: []

modules:
  updates:
    # \`beamhop update\` and the admin app read new versions from the extracted bundle.
    manifestUrl: ${baseUrl}/releases/latest.json
  plugins:
    # Plugin catalog snapshot shipped with the bundle.
    catalogUrl: ${baseUrl}/plugins/catalog.json

# Per relay (after the setup wizard), also consider:
# relays:
#   - id: main
#     blossom:
#       mirror: false            # do not fetch media from other (internet) servers
#       scanning: { lists: [] }  # abuse hash lists must be loaded from files, not URLs
`;
}

export const LITESTREAM_README = `# Litestream (database replication) — add before carrying the bundle across

Litestream is a separate open-source program (Apache-2.0) and is not built by Beamhop.
On a connected machine:

1. Download the package for your servers from https://github.com/benbjohnson/litestream/releases
   (Beamhop is tested with v0.3.13), e.g. litestream-v0.3.13-linux-amd64.deb and
   litestream-v0.3.13-linux-arm64.deb.
2. Check them against the checksums published on that release page.
3. Put them in this folder, then run \`sha256sum -c SHA256SUMS\` again after re-signing, or
   build the bundle with \`--litestream-dir <folder>\` so they are covered by the bundle checksums.

On the server: \`sudo dpkg -i litestream-*.deb\`, then follow docs/operations.md (backups / HA).
Replicate to an internal S3-compatible store (e.g. MinIO) or a file path (\`type: file\`).
`;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function copyDirOrNote(src: string | undefined, dest: string, what: string): boolean {
  mkdirSync(dest, { recursive: true });
  if (src && existsSync(src) && statSync(src).isDirectory()) {
    cpSync(src, dest, { recursive: true });
    return true;
  }
  writeFileSync(
    join(dest, 'NOT-INCLUDED.txt'),
    `The ${what} build was not available when this bundle was made (${src ?? 'no path'}).\nBuild it on a connected machine and rebuild the bundle.\n`,
  );
  return false;
}

export interface AirgapArgs {
  version: string;
  targets: string[];
  releaseDir?: string;
  baseUrl: string;
  pwaDir: string;
  teamDir: string;
  catalog?: string;
  pluginsDir?: string;
  litestreamDir?: string;
  outDir: string;
}

export function parseAirgapArgs(argv: string[]): AirgapArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = (get('version') ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`--version must be semver (got "${version}")`);
  const abs = (p: string | undefined) => (p ? resolve(p) : undefined);
  return {
    version,
    targets: (get('target') ?? DEFAULT_TARGETS.join(',')).split(',').filter(Boolean),
    releaseDir: abs(get('release-dir')),
    baseUrl: (get('base-url') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    pwaDir: abs(get('pwa-dir')) ?? join(ROOT, 'packages/pwa/build'),
    teamDir: abs(get('team-dir')) ?? join(ROOT, 'packages/team-client/build'),
    catalog: abs(get('catalog')),
    pluginsDir: abs(get('plugins-dir')),
    litestreamDir: abs(get('litestream-dir')),
    outDir: abs(get('out')) ?? join(ROOT, 'dist/airgap'),
  };
}

export async function airgapBundle(args: AirgapArgs, keyFile = process.env.MINISIGN_KEY_FILE) {
  const name = `beamhop-airgap-${args.version}`;
  const dir = join(args.outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const contents: Record<string, unknown> = {};

  // 1. Binaries in the layout install.sh expects + the update manifest.
  const relDir = join(dir, 'releases/latest');
  mkdirSync(relDir, { recursive: true });
  if (args.releaseDir) {
    for (const t of args.targets)
      copyFileSync(join(args.releaseDir, assetName(t)), join(relDir, assetName(t)));
  } else {
    await build(args.targets, relDir, args.version);
  }
  const assets = finalizeDir(relDir, args.targets, keyFile);
  const manifest = buildManifest({
    version: args.version,
    notes: `Offline bundle ${args.version}.`,
    baseUrl: `${args.baseUrl}/releases/latest`,
    assets,
  });
  writeFileSync(join(dir, 'releases/latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  contents.binaries = args.targets;

  // 2. Web apps (the admin app is also embedded in the binary; shipped for BEAMHOP_PWA_DIR).
  contents.adminApp = copyDirOrNote(args.pwaDir, join(dir, 'web/admin'), 'admin app');
  contents.teamClient = copyDirOrNote(args.teamDir, join(dir, 'web/team'), 'team client');

  // 3. Plugin catalog snapshot (+ packages).
  const pluginsOut = join(dir, 'plugins');
  mkdirSync(pluginsOut, { recursive: true });
  if (args.catalog) copyFileSync(args.catalog, join(pluginsOut, 'catalog.json'));
  else
    writeFileSync(
      join(pluginsOut, 'catalog.json'),
      `${JSON.stringify({ version: 1, source: 'airgap-bundle', plugins: [] }, null, 2)}\n`,
    );
  if (args.pluginsDir) cpSync(args.pluginsDir, join(pluginsOut, 'packages'), { recursive: true });
  contents.pluginCatalog = args.catalog ? 'snapshot' : 'empty';

  // 4. Litestream (third-party binary): instructions, or packages supplied by the operator.
  const lsOut = join(dir, 'litestream');
  mkdirSync(lsOut, { recursive: true });
  writeFileSync(join(lsOut, 'README.md'), LITESTREAM_README);
  if (args.litestreamDir) cpSync(args.litestreamDir, lsOut, { recursive: true });

  // 5. Config, installer, docs.
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config/beamhop.yaml'), airgapConfig(args.baseUrl, args.version));
  copyFileSync(join(ROOT, 'scripts/install.sh'), join(dir, 'install.sh'));
  const docsOut = join(dir, 'docs');
  mkdirSync(docsOut, { recursive: true });
  for (const f of ['quickstart.md', 'operations.md', 'airgap.md', 'enterprise.md'])
    if (existsSync(join(ROOT, 'docs', f))) copyFileSync(join(ROOT, 'docs', f), join(docsOut, f));
  if (existsSync(join(ROOT, 'docs/reference')))
    cpSync(join(ROOT, 'docs/reference'), join(docsOut, 'reference'), {
      recursive: true,
      filter: (src) => !src.endsWith('.ts'),
    });
  cpSync(join(ROOT, 'deploy/ha'), join(dir, 'ha'), { recursive: true });
  writeFileSync(
    join(dir, 'README.txt'),
    `Beamhop ${args.version} — offline bundle

Install (as root, on the server):
  mkdir -p /opt/beamhop/bundle
  tar xzf ${name}.tar.gz -C /opt/beamhop/bundle --strip-components=1
  cd /opt/beamhop/bundle && sha256sum -c SHA256SUMS
  sh install.sh --base-url ${args.baseUrl}/releases --systemd --no-start
  cp config/beamhop.yaml /var/lib/beamhop/beamhop.yaml   # review it first
  systemctl enable --now beamhop

Update later: extract the new bundle over /opt/beamhop/bundle the same way, then
  beamhop update --manifest ${args.baseUrl}/releases/latest.json && systemctl restart beamhop

Full guide: docs/airgap.md
`,
  );

  writeFileSync(
    join(dir, 'BUNDLE.json'),
    `${JSON.stringify({ name: 'beamhop-airgap', version: args.version, baseUrl: args.baseUrl, contents }, null, 2)}\n`,
  );

  // 6. Checksums of every file, signature, tarball.
  const sums: Record<string, string> = {};
  for (const f of walk(dir)) {
    const rel = relative(dir, f);
    if (rel === 'SHA256SUMS' || rel === 'SHA256SUMS.minisig') continue;
    sums[rel] = sha256File(f);
  }
  writeFileSync(join(dir, 'SHA256SUMS'), checksumsText(sums));
  signFile(join(dir, 'SHA256SUMS'), keyFile);

  const tarball = join(args.outDir, `${name}.tar.gz`);
  const tar = Bun.spawnSync(['tar', '-czf', tarball, '-C', dirname(dir), name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  const tarSha = sha256File(tarball);
  writeFileSync(`${tarball}.sha256`, `${tarSha}  ${name}.tar.gz\n`);
  signFile(tarball, keyFile);
  return { dir, tarball, sha256: tarSha, files: Object.keys(sums).sort() };
}

if (import.meta.main) {
  const args = parseAirgapArgs(process.argv.slice(2));
  const res = await airgapBundle(args);
  console.log(
    `offline bundle: ${res.tarball}\n  sha256 ${res.sha256}\n  ${res.files.length} files`,
  );
}
