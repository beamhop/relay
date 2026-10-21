// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Locating `sharp` (native, optional) for the single-file binary.
 *
 * A `bun build --compile` binary cannot embed sharp's native addon and libvips,
 * so they ship next to it: `scripts/build.ts --with-sharp` copies the target
 * platform's sharp + `@img/sharp-*` + libvips packages into
 * `dist/<target>/node_modules`, beside `dist/<target>/beamhop`. At startup the
 * loader tries, in order:
 *
 *   1. `BEAMHOP_SHARP_PATH` — a `node_modules` directory, or the `sharp`
 *      package directory itself;
 *   2. `node_modules/sharp` next to the running executable;
 *   3. a normal `import('sharp')` (development, `bun add sharp`).
 *
 * When none works, media processing degrades gracefully: uploads are stored
 * unchanged and the media health card explains how to add sharp.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

export interface SharpLocation {
  /** Directory passed to `require` (the sharp package directory). */
  dir: string;
  source: 'env' | 'binary';
}

/** Candidate sharp package directories, most specific first. */
export function sharpCandidates(
  env: Record<string, string | undefined> = process.env,
  execPath = process.execPath,
): SharpLocation[] {
  const out: SharpLocation[] = [];
  const fromEnv = env.BEAMHOP_SHARP_PATH;
  if (fromEnv) {
    const p = resolve(fromEnv);
    out.push({ dir: basename(p) === 'sharp' ? p : join(p, 'sharp'), source: 'env' });
  }
  // Not for `bun`/`node` running a script: their dir is the interpreter's.
  const exe = basename(execPath).toLowerCase();
  if (exe !== 'bun' && exe !== 'node' && exe !== 'bun.exe' && exe !== 'node.exe')
    out.push({ dir: join(dirname(execPath), 'node_modules', 'sharp'), source: 'binary' });
  return out;
}

/**
 * A `load()` for `@beamhop/media`'s sharp processor when sharp ships outside
 * the binary (`BEAMHOP_SHARP_PATH` or `node_modules` next to the executable);
 * undefined otherwise, so media keeps its own `import('sharp')` (development).
 */
export function sharpLoader(
  env: Record<string, string | undefined> = process.env,
  execPath = process.execPath,
): (() => Promise<unknown>) | undefined {
  const found = sharpCandidates(env, execPath).find((c) => existsSync(join(c.dir, 'package.json')));
  if (!found) return undefined;
  return async () => {
    // Compiled binaries cannot `require(dir)`: load the package's main file by path.
    const pkg = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8')) as {
      main?: string;
    };
    const main = join(found.dir, pkg.main ?? 'index.js');
    return createRequire(main)(main);
  };
}
