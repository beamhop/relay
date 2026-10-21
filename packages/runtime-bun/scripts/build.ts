#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build single-file `beamhop` binaries with `bun build --compile`.
 *
 *   bun scripts/build.ts                 # linux-x64, linux-arm64, darwin-arm64
 *   bun scripts/build.ts --host          # only the current platform
 *   bun scripts/build.ts --target linux-x64 --outdir dist
 *   bun scripts/build.ts --host --no-sharp   # bare binary, no image processing
 *
 * If `packages/pwa/build` exists, every file in it is embedded and registered via a
 * generated asset manifest (served at /admin). Otherwise the PWA is skipped.
 * Likewise `packages/team-client/build` is embedded as the `team` bundle (served
 * at /app when `modules.team.enabled`; `--team <dir>` overrides the path).
 * Cross-compiling downloads the target Bun runtime on first use.
 *
 * Image processing (sharp) is a native addon + libvips and cannot live inside
 * the single file. By default (sharp is part of the standard download) each target
 * is written to `dist/<target>/beamhop` and that platform's sharp,
 * `@img/sharp-<platform>`, `@img/sharp-libvips-<platform>` and their JS dependencies
 * are copied into `dist/<target>/node_modules`; ship the directory as one archive.
 * `--no-sharp` opts out and writes a bare `dist/beamhop-<target>` instead
 * (`--with-sharp` is still accepted; it is the default). At runtime
 * the binary loads sharp from `node_modules` next to itself or from
 * `BEAMHOP_SHARP_PATH` (see src/sharp.ts); without it, media is stored as-is.
 * Cross-target sharp packages must be installed first, e.g.
 * `bun install --os=linux --cpu=arm64`.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

const PKG = resolve(import.meta.dir, '..');
/** sharp is an optional dependency of @beamhop/media: resolve it from there. */
const MEDIA_PKG = resolve(PKG, '../media');
const PWA_BUILD = resolve(PKG, '../pwa/build');
const TEAM_BUILD = resolve(PKG, '../team-client/build');
const ALL_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const;
/** CLI dispatch (`beamhop serve` + CLI subcommands); falls back to the server-only entry. */
const CLI_ENTRY = resolve(PKG, '../cli/src/binary.ts');
/**
 * Plugin sandbox Worker script. Compiled as an extra entrypoint so sandboxed
 * (untrusted) plugins work in the single binary; the entry tells the sandbox where
 * it lives inside the embedded file system.
 */
export const PLUGIN_WORKER = resolve(PKG, '../plugins/src/bun/worker-entry.ts');
const PLUGIN_SANDBOX = resolve(PKG, '../plugins/src/bun/sandbox.ts');
/** Signature verification worker (verify-pool.ts), also an extra entrypoint. */
export const VERIFY_WORKER = resolve(PKG, 'src/verify-worker.ts');
const VERIFY_POOL = resolve(PKG, 'src/verify-pool.ts');

/** Worker scripts compiled as extra entrypoints (those that exist). */
export function workerEntries(): string[] {
  return [PLUGIN_WORKER, VERIFY_WORKER].filter((w) => existsSync(w));
}

/** Deepest directory containing every path (the `bun build --root`). */
export function commonRoot(paths: string[]): string {
  const parts = paths.map((p) => resolve(p).split(sep));
  const first = parts[0] ?? [];
  let n = 0;
  while (n < first.length && parts.every((p) => p[n] === first[n])) n++;
  return first.slice(0, n).join(sep) || sep;
}

/** Path of the worker inside the binary's embedded file system (relative to the build root). */
export function embeddedWorkerPath(
  entry: string,
  worker = PLUGIN_WORKER,
  workers: string[] = workerEntries(),
): string {
  const root = commonRoot([entry, worker, ...workers].map((p) => dirname(p)));
  return `./${relative(root, worker).split(sep).join('/')}`;
}

function hostTarget(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${arch}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function filesIn(dir: string): string[] {
  try {
    return statSync(dir).isDirectory() ? walk(dir) : [];
  } catch {
    return [];
  }
}

/** Generate the compile entry: embeds PWA + Team app files (if any) then runs main(). */
export function generateEntry(
  outDir: string,
  pwaDir = PWA_BUILD,
  teamDir = TEAM_BUILD,
): {
  entry: string;
  assets: number;
  teamAssets: number;
  worker: string | null;
  workers: string[];
} {
  const genDir = join(outDir, '.gen');
  const entry = join(genDir, 'entry.ts');
  const worker = existsSync(PLUGIN_WORKER) ? PLUGIN_WORKER : null;
  const workers = workerEntries();
  rmSync(genDir, { recursive: true, force: true });
  mkdirSync(genDir, { recursive: true });
  const files = filesIn(pwaDir);
  const teamFiles = filesIn(teamDir);
  const lines = [
    '// Generated by packages/runtime-bun/scripts/build.ts — do not edit.',
    // Must evaluate before any module graph that reaches tsyringe (passkeys).
    `import ${JSON.stringify(require.resolve('reflect-metadata', { paths: [PKG] }))};`,
    `import { registerAssets } from ${JSON.stringify(join(PKG, 'src/assets.ts'))};`,
    existsSync(CLI_ENTRY)
      ? `import { runBinary as main } from ${JSON.stringify(CLI_ENTRY)};`
      : `import { main } from ${JSON.stringify(join(PKG, 'src/main.ts'))};`,
  ];
  if (worker) {
    lines.push(
      `import { setSandboxWorkerUrl } from ${JSON.stringify(PLUGIN_SANDBOX)};`,
      `setSandboxWorkerUrl(${JSON.stringify(embeddedWorkerPath(entry, worker, workers))});`,
    );
  }
  if (workers.includes(VERIFY_WORKER)) {
    lines.push(
      `import { setVerifyWorkerUrl } from ${JSON.stringify(VERIFY_POOL)};`,
      `setVerifyWorkerUrl(${JSON.stringify(embeddedWorkerPath(entry, VERIFY_WORKER, workers))});`,
    );
  }
  const manifest: string[] = [];
  files.forEach((f, i) => {
    lines.push(`import a${i} from ${JSON.stringify(f)} with { type: 'file' };`);
    const urlPath = `/${relative(pwaDir, f).split(sep).join('/')}`;
    manifest.push(`  ${JSON.stringify(urlPath)}: a${i},`);
  });
  lines.push(`registerAssets({\n${manifest.join('\n')}\n});`);
  const teamManifest: string[] = [];
  teamFiles.forEach((f, i) => {
    lines.push(`import t${i} from ${JSON.stringify(f)} with { type: 'file' };`);
    const urlPath = `/${relative(teamDir, f).split(sep).join('/')}`;
    teamManifest.push(`  ${JSON.stringify(urlPath)}: t${i},`);
  });
  if (teamFiles.length > 0) lines.push(`registerAssets({\n${teamManifest.join('\n')}\n}, 'team');`);
  lines.push('await main();', '');
  writeFileSync(entry, lines.join('\n'));
  return { entry, assets: files.length, teamAssets: teamFiles.length, worker, workers };
}

/** Release version baked into the binary: BEAMHOP_VERSION env, else the root package.json. */
export function releaseVersion(): string {
  const env = process.env.BEAMHOP_VERSION;
  if (env) return env;
  const pkg = JSON.parse(readFileSync(resolve(PKG, '../../package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? '0.0.0';
}

/** `bun build` arguments: the entry, plus the worker scripts as extra entrypoints. */
export function compileArgs(
  entry: string,
  target: string,
  outfile: string,
  worker: string | string[] | null,
): string[] {
  const entries = [entry, ...(worker === null ? [] : Array.isArray(worker) ? worker : [worker])];
  return [
    'build',
    '--compile',
    '--minify',
    '--sourcemap',
    `--define=__BEAMHOP_VERSION__=${JSON.stringify(releaseVersion())}`,
    // Lets the binary resolve packages shipped next to it (sharp's own dependencies).
    '--compile-autoload-package-json',
    `--target=bun-${target}`,
    // Fixed root so the worker's embedded path matches `embeddedWorkerPath()`.
    `--root=${commonRoot(entries.map((e) => dirname(e)))}`,
    ...entries,
    '--outfile',
    outfile,
  ];
}

async function compile(
  entry: string,
  target: string,
  outfile: string,
  worker: string[],
): Promise<void> {
  const proc = Bun.spawn([process.execPath, ...compileArgs(entry, target, outfile, worker)], {
    cwd: PKG,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`bun build failed for ${target} (exit ${code})`);
}

/** sharp's platform name for a build target (`windows-x64` → `win32-x64`). */
export function sharpPlatform(target: string): string {
  return target.replace(/^windows-/, 'win32-');
}

/** sharp native packages for a target: `linux-x64` → `@img/sharp-linux-x64` + libvips. */
function sharpNativeFor(target: string): Set<string> {
  const p = sharpPlatform(target);
  return new Set([`@img/sharp-${p}`, `@img/sharp-libvips-${p}`]);
}

/**
 * The installed packages sharp needs on `target`: sharp, its JS dependencies,
 * and the target's `@img/sharp-*` native packages (other platforms' optional
 * packages are skipped). Returns name → real directory, plus native packages
 * that are not installed (cross-compiling without `bun install --os/--cpu`).
 */
export function sharpPackages(
  target: string,
  fromDir = MEDIA_PKG,
): { dirs: Map<string, string>; missing: string[] } {
  const native = sharpNativeFor(target);
  const dirs = new Map<string, string>();
  const missing: string[] = [];
  const queue: Array<{ name: string; from: string; optional: boolean }> = [
    { name: 'sharp', from: fromDir, optional: false },
  ];
  while (queue.length > 0) {
    const { name, from, optional } = queue.shift() as (typeof queue)[number];
    if (dirs.has(name)) continue;
    let dir: string;
    try {
      const req = createRequire(join(from, 'package.json'));
      dir = realpathSync(dirname(req.resolve(`${name}/package.json`)));
    } catch {
      if (!optional || native.has(name)) missing.push(name);
      continue;
    }
    dirs.set(name, dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      if (native.has(dep)) queue.push({ name: dep, from: dir, optional: true });
  }
  return { dirs, missing };
}

/** Copy sharp for `target` into `<dest>/node_modules` (flat npm layout). */
export function copySharp(target: string, dest: string, fromDir = MEDIA_PKG): string[] {
  const { dirs, missing } = sharpPackages(target, fromDir);
  const nm = join(dest, 'node_modules');
  for (const [name, dir] of dirs) {
    const to = join(nm, ...name.split('/'));
    rmSync(to, { recursive: true, force: true });
    mkdirSync(dirname(to), { recursive: true });
    cpSync(dir, to, { recursive: true, dereference: true });
  }
  return missing;
}

export interface BuildArgs {
  outDir: string;
  targets: string[];
  pwaDir: string;
  teamDir: string;
  /** Ship sharp next to each binary (default true; `--no-sharp` turns it off). */
  withSharp: boolean;
}

export function parseBuildArgs(argv: string[]): BuildArgs {
  const a: BuildArgs = {
    outDir: join(PKG, 'dist'),
    targets: [...ALL_TARGETS],
    pwaDir: PWA_BUILD,
    teamDir: TEAM_BUILD,
    withSharp: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--with-sharp') a.withSharp = true;
    else if (x === '--no-sharp') a.withSharp = false;
    else if (x === '--host') a.targets = [hostTarget()];
    else if (x === '--target') a.targets = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (x === '--outdir') a.outDir = resolve(argv[++i] ?? a.outDir);
    else if (x === '--pwa') a.pwaDir = resolve(argv[++i] ?? a.pwaDir);
    else if (x === '--team') a.teamDir = resolve(argv[++i] ?? a.teamDir);
    // scripts/release.ts passes `--version` (the binary reads BEAMHOP_VERSION).
    else if (x === '--version') i++;
  }
  return a;
}

/** Binary location: `<out>/<target>/beamhop` with sharp, else `<out>/beamhop-<target>`. */
export function binaryPath(outDir: string, target: string, withSharp: boolean): string {
  return withSharp ? join(outDir, target, 'beamhop') : join(outDir, `beamhop-${target}`);
}

async function run(argv: string[]): Promise<void> {
  const { outDir, targets, pwaDir, teamDir, withSharp } = parseBuildArgs(argv);
  mkdirSync(outDir, { recursive: true });
  const { entry, assets, teamAssets, worker, workers } = generateEntry(outDir, pwaDir, teamDir);
  if (!worker) console.warn('plugin sandbox worker not found; sandboxed plugins will not load');
  console.log(
    assets ? `embedding ${assets} admin app files` : 'admin app build not found; skipping PWA',
  );
  console.log(
    teamAssets
      ? `embedding ${teamAssets} team app files`
      : 'team app build not found; skipping /app',
  );
  for (const t of targets) {
    // With sharp: dist/<target>/{beamhop,node_modules/} so sharp sits next to the binary.
    const outfile = binaryPath(outDir, t, withSharp);
    mkdirSync(dirname(outfile), { recursive: true });
    console.log(`compiling ${outfile}`);
    await compile(entry, t, outfile, workers);
    if (withSharp) {
      const missing = copySharp(t, join(outDir, t));
      if (missing.length) {
        // A partial copy cannot load; ship the bare binary for this target instead.
        rmSync(join(outDir, t, 'node_modules'), { recursive: true, force: true });
        const [os, cpu] = sharpPlatform(t).split('-');
        console.warn(
          `sharp for ${t} is incomplete (missing ${missing.join(', ')}); install it with \`bun install --os=${os} --cpu=${cpu}\`. Image processing will be off for this target.`,
        );
      } else console.log(`copied sharp for ${t} into ${join(outDir, t, 'node_modules')}`);
    }
  }
}

if (import.meta.main) await run(process.argv.slice(2));
