// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data-dir snapshots used by `backup` (fallback when no lifecycle action is
 * registered) and `move`. A snapshot is a .tar.gz with:
 *   beamhop.yaml             the settings file (if any)
 *   data/state.json          node state
 *   data/db/beamhop.sqlite   SQLite online backup (`VACUUM INTO`, consistent while running)
 *   data/secrets/**, tls/**  node keys (move, and backups when asked)
 *   blobs/**                 media files (move only; backups record a blob manifest)
 *   manifest.json            sha256 + size of every file, DB row counts, blob list
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { BeamhopConfig } from '@beamhop/core';
import { dataLayout } from '@beamhop/runtime-bun';
import { CliError } from './io.ts';
import { TarWriter, asPlainTar, extractFile, gzipFile, readTar, safeJoin } from './tar.ts';

export const SNAPSHOT_FORMAT = 'beamhop-snapshot';

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  version: 1;
  kind: 'backup' | 'move';
  createdAt: string;
  nodeId: string;
  storage: { driver: string; included: boolean };
  blobStorage: { driver: string; included: boolean; count: number; bytes: number };
  /** Row count per table in the DB snapshot. */
  counts: Record<string, number>;
  files: ManifestFile[];
  /** sha256 → size of every blob (always recorded; content only when included). */
  blobs: Array<[string, number]>;
}

export interface CreateSnapshotOptions {
  kind: 'backup' | 'move';
  config: BeamhopConfig;
  configFile?: string;
  out: string;
  includeBlobs: boolean;
  includeKeys: boolean;
  now: number;
}

function walk(dir: string, skip: (rel: string) => boolean = () => false, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join('/');
    if (skip(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, skip, root));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

export function sqlitePathOf(config: BeamhopConfig): string {
  // Same rule as storage-sql: `url` (path, `file:` or `sqlite:`), else <dataDir>/db/beamhop.sqlite.
  if (config.storage.url) return resolve(config.storage.url.replace(/^(sqlite|file):(\/\/)?/, ''));
  return dataLayout(config.node.dataDir).sqlitePath;
}

export function blobsDirOf(config: BeamhopConfig): string {
  return config.blobStorage.path
    ? resolve(config.blobStorage.path)
    : dataLayout(config.node.dataDir).blobsDir;
}

/** Row counts of every table (used to verify a restore). */
export function dbCounts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const out: Record<string, number> = {};
    for (const { name } of tables)
      out[name] =
        db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get()
          ?.n ?? 0;
    return out;
  } finally {
    db.close();
  }
}

/** Consistent copy of a live SQLite DB (safe while the server is writing). */
export function sqliteOnlineBackup(src: string, dest: string): void {
  rmSync(dest, { force: true });
  const db = new Database(src, { readonly: true });
  try {
    db.run('VACUUM INTO ?', [dest]);
  } finally {
    db.close();
  }
}

const isBlobName = (n: string) => /^[0-9a-f]{64}$/.test(n);

export function blobInventory(dir: string): Array<[string, number]> {
  return walk(dir, (rel) => rel === '.tmp' || rel.startsWith('.tmp/'))
    .filter((p) => isBlobName(p.split(sep).pop() ?? ''))
    .map((p) => [p.split(sep).pop()!, statSync(p).size] as [string, number]);
}

export async function createSnapshot(o: CreateSnapshotOptions): Promise<SnapshotManifest> {
  const layout = dataLayout(o.config.node.dataDir);
  if (!existsSync(layout.root)) throw new CliError(`No Beamhop data found at ${layout.root}`);
  mkdirSync(resolve(o.out, '..'), { recursive: true });
  const stamp = `${process.pid}-${o.now}`;
  const tarPath = `${o.out}.${stamp}.tar`;
  const dbTmp = `${o.out}.${stamp}.sqlite`;
  const files: ManifestFile[] = [];
  const tar = new TarWriter(tarPath);
  const add = (archivePath: string, file: string, mode?: number) => {
    const st = statSync(file);
    const m = mode ?? st.mode & 0o777;
    const r = tar.addFile(archivePath, file, m);
    files.push({ path: archivePath, size: r.size, sha256: r.sha256, mode: m });
  };
  let counts: Record<string, number> = {};
  const storageIncluded = o.config.storage.driver === 'sqlite';
  try {
    if (o.configFile && existsSync(o.configFile)) add('beamhop.yaml', o.configFile, 0o600);
    if (existsSync(layout.stateFile)) add('data/state.json', layout.stateFile);
    if (storageIncluded) {
      const db = sqlitePathOf(o.config);
      if (existsSync(db)) {
        sqliteOnlineBackup(db, dbTmp);
        counts = dbCounts(dbTmp);
        add('data/db/beamhop.sqlite', dbTmp, 0o600);
      }
    }
    if (o.includeKeys) {
      for (const f of walk(layout.secretsDir))
        add(`data/secrets/${relative(layout.secretsDir, f).split(sep).join('/')}`, f, 0o600);
      for (const f of walk(layout.tlsDir))
        add(`data/tls/${relative(layout.tlsDir, f).split(sep).join('/')}`, f, 0o600);
    }
    const blobFs = o.config.blobStorage.driver === 'fs';
    const blobDir = blobsDirOf(o.config);
    const blobs = blobFs ? blobInventory(blobDir) : [];
    const blobsIncluded = blobFs && o.includeBlobs;
    if (blobsIncluded)
      for (const f of walk(blobDir, (rel) => rel === '.tmp' || rel.startsWith('.tmp/')))
        add(`blobs/${relative(blobDir, f).split(sep).join('/')}`, f);
    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      version: 1,
      kind: o.kind,
      createdAt: new Date(o.now).toISOString(),
      nodeId: o.config.node.id,
      storage: { driver: o.config.storage.driver, included: storageIncluded },
      blobStorage: {
        driver: o.config.blobStorage.driver,
        included: blobsIncluded,
        count: blobs.length,
        bytes: blobs.reduce((a, [, s]) => a + s, 0),
      },
      counts,
      files,
      blobs,
    };
    tar.addBytes(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      0o600,
      o.now / 1000,
    );
    tar.close();
    await gzipFile(tarPath, `${o.out}.${stamp}.part`);
    renameSync(`${o.out}.${stamp}.part`, o.out);
    return manifest;
  } finally {
    rmSync(tarPath, { force: true });
    rmSync(dbTmp, { force: true });
    rmSync(`${o.out}.${stamp}.part`, { force: true });
  }
}

export interface InspectResult {
  manifest: SnapshotManifest;
  problems: string[];
}

/** Read the manifest and verify every file's size + SHA-256. */
export async function inspectSnapshot(file: string): Promise<InspectResult> {
  const { tar, cleanup } = await asPlainTar(file, `${file}.${process.pid}.check.tar`);
  try {
    let manifest: SnapshotManifest | null = null;
    const seen = new Map<string, { size: number; sha256: string }>();
    readTar(tar, (e, read) => {
      if (e.type !== 'file') return;
      if (e.path === 'manifest.json') {
        const chunks: Uint8Array[] = [];
        read((c) => chunks.push(c.slice()));
        manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SnapshotManifest;
        return;
      }
      const h = new Bun.CryptoHasher('sha256');
      read((c) => h.update(c));
      seen.set(e.path, { size: e.size, sha256: h.digest('hex') });
    });
    const m = manifest as SnapshotManifest | null;
    if (!m || m.format !== SNAPSHOT_FORMAT)
      throw new CliError('This is not a Beamhop backup or move file.');
    const problems: string[] = [];
    for (const f of m.files) {
      const got = seen.get(f.path);
      if (!got) problems.push(`missing: ${f.path}`);
      else if (got.sha256 !== f.sha256 || got.size !== f.size) problems.push(`damaged: ${f.path}`);
      seen.delete(f.path);
    }
    for (const extra of seen.keys()) problems.push(`unexpected file: ${extra}`);
    return { manifest: m, problems };
  } finally {
    cleanup();
  }
}

export interface RestoreOptions {
  dataDir: string;
  blobsDir: string;
  /** SQLite file to restore into (default <dataDir>/db/beamhop.sqlite). */
  dbPath?: string;
  /** Where to write beamhop.yaml (skipped when undefined). */
  configDest?: string;
  /** Only restore archive paths starting with one of these prefixes. */
  only?: string[];
  now: number;
}

export interface RestoreResult {
  manifest: SnapshotManifest;
  restored: string[];
  movedAside: string[];
  counts: Record<string, number>;
}

/**
 * Verify, then extract. An existing database is moved aside (with its -wal/-shm,
 * which would otherwise corrupt the restored file) rather than deleted.
 */
export async function restoreSnapshot(file: string, o: RestoreOptions): Promise<RestoreResult> {
  const { manifest, problems } = await inspectSnapshot(file);
  if (problems.length)
    throw new CliError(
      `The file failed its integrity check; nothing was restored.\n  ${problems.slice(0, 10).join('\n  ')}`,
    );
  const want = (p: string) => !o.only || o.only.some((x) => p.startsWith(x));
  const layout = dataLayout(o.dataDir);
  const movedAside: string[] = [];
  const restored: string[] = [];
  const dbTarget = o.dbPath ?? layout.sqlitePath;
  if (manifest.files.some((f) => f.path === 'data/db/beamhop.sqlite' && want(f.path))) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${dbTarget}${suffix}`;
      if (existsSync(p)) {
        const aside = `${dbTarget}.before-restore-${o.now}${suffix}`;
        renameSync(p, aside);
        movedAside.push(aside);
      }
    }
  }
  const { tar, cleanup } = await asPlainTar(file, `${file}.${process.pid}.restore.tar`);
  try {
    readTar(tar, (e, read) => {
      if (e.type !== 'file' || e.path === 'manifest.json' || !want(e.path)) return;
      let dest: string;
      if (e.path === 'beamhop.yaml') {
        if (!o.configDest) return;
        dest = o.configDest;
      } else if (e.path === 'data/db/beamhop.sqlite') dest = dbTarget;
      else if (e.path.startsWith('data/')) dest = safeJoin(o.dataDir, e.path.slice(5));
      else if (e.path.startsWith('blobs/')) dest = safeJoin(o.blobsDir, e.path.slice(6));
      else return;
      extractFile(read, dest, e.mode);
      restored.push(dest);
    });
  } finally {
    cleanup();
  }
  const counts = existsSync(dbTarget) && restored.includes(dbTarget) ? dbCounts(dbTarget) : {};
  return { manifest, restored, movedAside, counts };
}

/** Compare restored DB counts with the manifest. */
export function countMismatches(
  expected: Record<string, number>,
  got: Record<string, number>,
): string[] {
  return Object.entries(expected)
    .filter(([t, n]) => got[t] !== n)
    .map(([t, n]) => `${t}: expected ${n}, found ${got[t] ?? 0}`);
}
