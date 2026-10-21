// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Installs catalog plugins into `<plugins dir>`: download the pinned tarball,
 * verify its integrity hash (refuse on mismatch), keep it under `tarballs/`,
 * then `bun add ./tarballs/<file>` so dependencies are installed too.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CatalogEntry, npmTarballUrl, verifyIntegrity } from '../catalog/index.ts';
import type { InstalledRecord, PluginInstaller } from '../host/types.ts';
import { assertPublicUrl } from '../net/ssrf.ts';
import { type RunCommand, bunRun } from './authoring.ts';

export interface BunInstallerOptions {
  dir: () => string;
  fetch?: typeof fetch;
  run?: RunCommand;
  now: () => number;
  /** Resolve the installed package entry (default `Bun.resolveSync`). */
  resolve?: (pkg: string, dir: string) => string;
}

const fileSafe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

export class BunPluginInstaller implements PluginInstaller {
  constructor(private readonly opts: BunInstallerOptions) {}

  private async ensureDir(): Promise<string> {
    const dir = this.opts.dir();
    await mkdir(join(dir, 'tarballs'), { recursive: true });
    const pj = join(dir, 'package.json');
    if (!existsSync(pj)) {
      await writeFile(
        pj,
        `${JSON.stringify({ name: 'beamhop-installed-plugins', private: true, dependencies: {} }, null, 2)}\n`,
      );
    }
    return dir;
  }

  async install(entry: CatalogEntry): Promise<InstalledRecord> {
    const url = entry.tarball ?? npmTarballUrl(entry.package, entry.version);
    await assertPublicUrl(url);
    const res = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`The plugin could not be downloaded (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Integrity first: nothing touches the disk unless the bytes match the signed catalog.
    await verifyIntegrity(bytes, entry);
    const dir = await this.ensureDir();
    const file = `${fileSafe(entry.id)}-${fileSafe(entry.version)}.tgz`;
    await writeFile(join(dir, 'tarballs', file), bytes);
    const r = await (this.opts.run ?? bunRun)([process.execPath, 'add', `./tarballs/${file}`], {
      cwd: dir,
      env: { BUN_BE_BUN: '1', PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new Error(`Installing the plugin failed: ${r.output.slice(-500)}`);
    const resolve =
      this.opts.resolve ?? ((pkg: string, from: string) => Bun.resolveSync(pkg, from));
    const entryPath = resolve(entry.package, dir);
    return {
      id: entry.id,
      package: entry.package,
      version: entry.version,
      ...(entry.integrity ? { integrity: entry.integrity } : {}),
      entry: entryPath,
      permissions: entry.permissions,
      source: 'catalog',
      installedAt: this.opts.now(),
    };
  }

  async remove(rec: InstalledRecord): Promise<void> {
    const dir = this.opts.dir();
    if (!existsSync(dir)) return;
    await (this.opts.run ?? bunRun)([process.execPath, 'remove', rec.package], {
      cwd: dir,
      env: { BUN_BE_BUN: '1', PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
      timeoutMs: 60_000,
    }).catch(() => ({ code: 1, output: '' }));
    await rm(join(dir, 'tarballs', `${fileSafe(rec.id)}-${fileSafe(rec.version)}.tgz`), {
      force: true,
    });
  }
}
