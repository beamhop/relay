// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop update` / `beamhop rollback` for the single binary (the admin app
 * uses the same primitives through the `system.update` action, see
 * ../system.ts and ../updater.ts).
 *
 * update: release manifest → download next to the binary → verify SHA-256
 * and the minisign signature → smoke test the new binary (`--version` must report the
 * release; `--healthcheck` must pass when a server is running) → keep the
 * current binary as `<bin>.previous` → atomic rename over `<bin>`.
 * rollback: put `<bin>.previous` back (the replaced one is kept as `<bin>.rolled-back`).
 *
 * Manifest URL: --manifest, $BEAMHOP_UPDATE_MANIFEST, `modules.updates.manifestUrl`
 * in beamhop.yaml, else the default. Format:
 *   { "version": "0.2.0", "notes": "…", "assets": { "linux-x64": { "url", "sha256", "signature"?, "size"? } } }
 * Asset and signature URLs may be relative to the manifest URL. `signature` is the
 * minisign `.minisig` text, or a URL/path of it.
 *
 * Signatures (minisign, Ed25519): the release public key comes from
 * $BEAMHOP_UPDATE_PUBLIC_KEY, `modules.updates.publicKey`, else the built-in
 * {@link RELEASE_PUBLIC_KEY} (still a placeholder). A download that cannot be
 * checked — no key, or an unsigned release — is refused unless `--allow-unsigned`
 * (or BEAMHOP_UPDATE_ALLOW_UNSIGNED=1) is given; a bad signature is always refused.
 */
import { basename } from 'node:path';
import { VERSION } from '@beamhop/runtime-bun';
import { type FlagSpec, type FlagValues, bool, parseFlags, str } from '../args.ts';
import { type CliContext, localOptions } from '../context.ts';
import { json } from '../format.ts';
import { CliError, EXIT, line, paint } from '../io.ts';
import { resolveLocalConfig, serverRunning } from '../local.ts';
import {
  type ReleaseSource,
  type RunBinary,
  type SignatureCheck,
  type UpdatesSettings,
  allowUnsignedFromEnv,
  compareVersions,
  fetchManifest,
  hostPlatform,
  resolveManifestUrl,
  resolvePublicKey,
  rollbackBinary,
  stageRelease,
  swapBinary,
} from '../updater.ts';

export {
  DEFAULT_MANIFEST_URL,
  RELEASE_PUBLIC_KEY,
  compareVersions,
  fetchManifest,
  hostPlatform,
  resolveAgainst,
  signatureText,
  type ReleaseAsset,
  type ReleaseManifest,
} from '../updater.ts';

export interface UpdateDeps {
  /** Run a binary with args; resolves exit code + stdout. */
  run?: RunBinary;
  /** Signature check override (tests). Default: minisign with the configured public key. */
  verifySignature?: SignatureCheck;
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
    description: 'Install a release whose signature cannot be checked (developers only)',
  },
];

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

/** Release public key: env, then `modules.updates.publicKey`, then the built-in one. */
export function releasePublicKey(ctx: CliContext, globals: FlagValues): string | null {
  return resolvePublicKey(ctx.env, updatesSettings(ctx, globals));
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
  const settings = updatesSettings(ctx, globals);
  const src: ReleaseSource = {
    manifestUrl: resolveManifestUrl(ctx.env, settings, str(flags.manifest)),
    publicKey: resolvePublicKey(ctx.env, settings),
    allowUnsigned: bool(flags['allow-unsigned']) || allowUnsignedFromEnv(ctx.env),
    platform: deps.platform ?? hostPlatform(),
    fetch: ctx.fetch,
  };
  const manifest = await fetchManifest(ctx.fetch, src.manifestUrl);
  const newer = compareVersions(manifest.version, current) > 0;
  if (bool(flags.check) || (!newer && !bool(flags.force))) {
    if (bool(globals.json))
      json(io, {
        current,
        latest: manifest.version,
        updateAvailable: newer,
        notes: manifest.notes,
        canVerify: !!src.publicKey,
      });
    else if (newer) {
      line(io, `Version ${manifest.version} is available (you have ${current}).`);
      if (manifest.notes) line(io, `\n${manifest.notes.trim()}\n`);
      line(io, 'Install it with `beamhop update`.');
    } else line(io, `${p.green('✓')} You have the latest version (${current}).`);
    return EXIT.ok;
  }
  const bin = binaryPath(ctx, flags);
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
  const staged = await stageRelease(src, manifest, {
    bin,
    env: { ...ctx.env },
    healthcheckUrl: running,
    note: (l) => line(io, p.dim(`  ${l}`)),
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.verifySignature ? { verifySignature: deps.verifySignature } : {}),
  });
  swapBinary(bin, staged, current, ctx.now());
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
  const { version } = rollbackBinary(bin);
  if (bool(globals.json)) json(io, { rolledBack: true, version });
  else {
    line(io, `${paint(io).green('✓')} Went back to ${version}. Restart the service to use it.`);
    line(io, paint(io).dim(`  The version you left is kept as ${bin}.rolled-back`));
  }
  return EXIT.ok;
}
