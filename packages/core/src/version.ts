// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Beamhop release version: the root `package.json` version, inlined by
 * every bundler (bun build --compile, Workers bundling) and read directly in
 * development. Release builds may override it with
 * `--define __BEAMHOP_VERSION__='"x.y.z"'` (e.g. to append a commit).
 */
import rootPackage from '../../../package.json' with { type: 'json' };

declare const __BEAMHOP_VERSION__: string | undefined;

export const BEAMHOP_VERSION: string =
  typeof __BEAMHOP_VERSION__ === 'string' && __BEAMHOP_VERSION__
    ? __BEAMHOP_VERSION__
    : (rootPackage as { version?: string }).version || '0.0.0';
