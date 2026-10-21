#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one build: admin app → team app → single `beamhop` binary with both embedded.
 *
 *   bun run build                          # this platform → packages/runtime-bun/dist/beamhop-<os>-<arch>
 *   bun run build -- --all                 # every release target
 *   bun run build -- --target linux-x64,windows-x64 --outdir dist
 *   bun run build -- --skip-ui             # reuse the existing app builds
 *
 * Any failing step stops the build. After compiling, the host binary (when one was
 * built) is checked: `--version` must run and the admin and team apps must be inside.
 * Everything else is passed to packages/runtime-bun/scripts/build.ts.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { binaryPath, hostTarget, parseBuildArgs } from '../packages/runtime-bun/scripts/build.ts';

const ROOT = resolve(import.meta.dir, '..');
const BUILD = join(ROOT, 'packages/runtime-bun/scripts/build.ts');

export interface RootBuildArgs {
  skipUi: boolean;
  /** Arguments for the binary build script. */
  binary: string[];
}

export function parseRootArgs(argv: string[]): RootBuildArgs {
  let skipUi = false;
  let all = false;
  const binary: string[] = [];
  for (const a of argv) {
    if (a === '--skip-ui') skipUi = true;
    else if (a === '--all') all = true;
    else binary.push(a);
  }
  if (!all && !binary.includes('--target') && !binary.includes('--host')) binary.push('--host');
  return { skipUi, binary };
}

function step(title: string, cmd: string[], cwd = ROOT): void {
  console.log(`\n▶ ${title}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) {
    console.error(`✗ ${title} failed (exit ${r.exitCode})`);
    process.exit(r.exitCode || 1);
  }
}

/** Ask the binary itself what it embeds (`beamhop --build-info`). */
export function checkBinary(bin: string): string[] {
  const problems: string[] = [];
  const version = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (version.exitCode !== 0) problems.push(`${bin} --version failed`);
  const info = Bun.spawnSync([bin, '--build-info'], { stdout: 'pipe', stderr: 'pipe' });
  let parsed: { assets?: { admin?: number; team?: number } } = {};
  try {
    parsed = JSON.parse(info.stdout.toString());
  } catch {
    problems.push(`${bin} --build-info did not print JSON`);
  }
  if (!parsed.assets?.admin) problems.push('the admin app is not embedded');
  if (!parsed.assets?.team) problems.push('the team app is not embedded');
  return problems;
}

async function main(): Promise<void> {
  const args = parseRootArgs(process.argv.slice(2));
  const parsed = parseBuildArgs(args.binary);
  if (!args.skipUi) {
    step('Admin app', [process.execPath, 'run', 'build'], join(ROOT, 'packages/pwa'));
    step('Team app', [process.execPath, 'run', 'build'], join(ROOT, 'packages/team-client'));
  }
  step('Binary', [process.execPath, BUILD, ...args.binary]);
  const host = hostTarget();
  if (parsed.targets.includes(host)) {
    const bin = binaryPath(parsed.outDir, host);
    if (!existsSync(bin)) {
      console.error(`✗ expected ${bin}`);
      process.exit(1);
    }
    const problems = parsed.allowMissingUi ? [] : checkBinary(bin);
    if (problems.length) {
      for (const p of problems) console.error(`✗ ${p}`);
      process.exit(1);
    }
    console.log(`\n✓ ${bin}`);
  }
  for (const t of parsed.targets) if (t !== host) console.log(`✓ ${binaryPath(parsed.outDir, t)}`);
}

if (import.meta.main) await main();
