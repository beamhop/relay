// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scheduled backups (§10, §6.11): one gzip'd tar archive per run, stored
 * content-addressed (key = sha256 of the archive) in the backup target
 * BlobStore — `config.backups.target` (S3/GCS/R2/fs via `@beamhop/blobs`) or
 * `<dataDir>/backups` on Bun.
 *
 * Archive layout:
 *   manifest.json            format, counts, sha256 of every other file
 *   db/beamhop.sqlite        SQLite snapshot (VACUUM INTO) — Bun + SQLite
 *   db/<table>.ndjson        logical dump per table — D1, Postgres, or format=ndjson
 *   db/pg_dump.sql           extra plain pg_dump when the binary is on PATH (manual restore)
 *   ports/events/<relay>.ndjson  fallback when no SQL access (memory stores): events only
 *   blobs/manifest.ndjson    one blob ownership per line (sha256 + owner + size + type)
 *   config/config.json       current config revision ({ revision, config }); secrets
 *                            masked unless the archive is encrypted or
 *                            `backups.includeSecrets` is on
 *
 * With `ports.keyWrapper` (key vault) the whole archive is AES-256-GCM
 * encrypted with a wrapped data key in a header (see backup-crypto.ts).
 *
 * The catalog lives in DocStore `lifecycle.backups` (`b-…` keys) and the status
 * of the latest run in `lifecycle.backups/last` (read by insights health).
 */
import type { BeamhopConfig, BlobOwnership, BlobStore, DiffLine, NostrEvent } from '@beamhop/core';
import {
  decryptArchive,
  encryptArchive,
  isEncryptedArchive,
  maskSecrets,
} from './backup-crypto.ts';
import type { LifecycleRuntime } from './runtime.ts';
import { COL, SCHEDULE_SECONDS } from './settings.ts';
import {
  MIGRATIONS_TABLE,
  type Row,
  type TableSource,
  appliedMigrations,
  countRows,
  dumpTables,
  restoreTables,
} from './sql.ts';
import { type TarEntry, gunzip, gzip, readAll, tarPack, tarUnpack } from './tar.ts';

export const ARCHIVE_TYPE = 'application/vnd.beamhop.backup+gzip';
/** Archive sealed with AES-256-GCM (data key wrapped by `ports.keyWrapper`). */
export const ARCHIVE_TYPE_ENCRYPTED = 'application/vnd.beamhop.backup+gzip+aesgcm';
export const ARCHIVE_FORMAT = 'beamhop-backup';

export type DbFormat = 'sqlite' | 'ndjson' | 'ports';

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: 1;
  id: string;
  createdAt: number;
  nodeId: string;
  runtime: string;
  driver: string;
  dbFormat: DbFormat;
  files: Array<{ path: string; size: number; sha256: string }>;
  /** Row count per dumped table. */
  tables: Record<string, number>;
  /** Event count per relay. */
  events: Record<string, number>;
  blobs: { owners: number; unique: number; bytesCopied: number };
  config: { revision?: number };
  /** Whether config secrets are kept in config/config.json (absent in older archives). */
  secrets?: 'included' | 'masked';
  migrations: string[];
}

export interface BackupRecord {
  id: string;
  at: number;
  ok: true;
  trigger: 'scheduled' | 'manual';
  sha256: string;
  size: number;
  location: string;
  dbFormat: DbFormat;
  driver: string;
  events: number;
  docs?: number;
  blobs: number;
  configRevision?: number;
  /** Sealed with the key service (`ports.keyWrapper`). */
  encrypted?: boolean;
  /** Config secrets kept or masked in the archive. */
  secrets?: 'included' | 'masked';
  durationMs: number;
}

/** `lifecycle.backups/last` — insights health reads this. */
export interface BackupLast {
  at: number;
  ok: boolean;
  size?: number;
  location?: string;
  error?: string;
  id?: string;
  lastOkAt?: number;
  durationMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest?: ArchiveManifest;
}

export interface RestoreResult {
  ok: boolean;
  id: string;
  tables: Record<string, number>;
  events: Record<string, number>;
  blobs: { restored: number; missing: number; present: number };
  problems: string[];
}

interface LoadedArchive {
  manifest: ArchiveManifest;
  files: Map<string, Uint8Array>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));
const ndjson = (rows: unknown[]) => enc.encode(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
const parseNdjson = <T = Row>(b: Uint8Array): T[] =>
  dec
    .decode(b)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

export class BackupService {
  private targetMemo: { key: string; store: Promise<BlobStore | null> } | null = null;
  private running: Promise<BackupLast> | null = null;

  constructor(private readonly rt: LifecycleRuntime) {}

  private get ports() {
    return this.rt.ports;
  }

  private config(): BeamhopConfig {
    return this.rt.kernel.config();
  }

  // ── target ──

  /** Human/URI description of where backups go (null: nowhere configured). */
  targetUri(): string | null {
    const o = this.rt.opts.backupTarget;
    if (o) return typeof o === 'object' ? `${o.kind}://backups` : 'custom://backups';
    const t = this.targetSpec();
    if (!t) return null;
    return t.driver === 'fs' ? `file://${t.path}` : `${t.driver}://${t.bucket ?? ''}`;
  }

  /**
   * Effective target from config. `backups.target` defaults to `{ driver: 'fs' }`
   * (schema prefault): a folder is only usable on Bun, where it means
   * `<dataDir>/backups` unless a path is given. Elsewhere it means "not set".
   */
  private targetSpec():
    | (NonNullable<BeamhopConfig['backups']['target']> & { path?: string })
    | null {
    const t = this.config().backups.target;
    if (!t || t.driver === 'fs') {
      if (this.rt.kernel.runtime !== 'bun') return null;
      return { ...(t ?? {}), driver: 'fs', path: t?.path ?? `${this.dataDir()}/backups` };
    }
    if (t.driver === 'memory') return null;
    return t;
  }

  private dataDir(): string {
    return (this.rt.runtimeInfo()?.dataDir ?? this.config().node.dataDir).replace(/\/+$/, '');
  }

  async target(): Promise<BlobStore | null> {
    const t = this.config().backups.target;
    const key = JSON.stringify(t ?? null);
    if (this.targetMemo?.key === key) return this.targetMemo.store;
    const store = this.openTarget().then(async (s) => {
      await s?.init();
      return s;
    });
    store.catch(() => {
      if (this.targetMemo?.store === store) this.targetMemo = null;
    });
    this.targetMemo = { key, store };
    return store;
  }

  private async openTarget(): Promise<BlobStore | null> {
    const o = this.rt.opts.backupTarget;
    if (o) return typeof o === 'function' ? o(this.rt.kernel) : o;
    const spec = this.targetSpec();
    if (!spec) return null;
    const { createBlobStore } = await import('@beamhop/blobs');
    return createBlobStore({ ...spec, dataDir: this.dataDir(), logger: this.ports.logger });
  }

  // ── status ──

  async last(): Promise<BackupLast | null> {
    return this.ports.docs.get<BackupLast>(COL.backups, 'last');
  }

  async catalog(): Promise<BackupRecord[]> {
    const out: BackupRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ports.docs.list<BackupRecord>(COL.backups, {
        prefix: 'b-',
        cursor,
        limit: 500,
        reverse: true,
      });
      for (const i of page.items) out.push(i.value);
      cursor = page.cursor;
    } while (cursor);
    return out.sort((a, b) => b.at - a.at);
  }

  /** Catalog plus archives found in the target but unknown here (e.g. after moving servers). */
  async list(): Promise<{
    backups: BackupRecord[];
    unknownArchives: Array<{ sha256: string; size: number }>;
  }> {
    const backups = await this.catalog();
    const known = new Set(backups.map((b) => b.sha256));
    const unknownArchives: Array<{ sha256: string; size: number }> = [];
    const target = await this.target().catch(() => null);
    if (target) {
      let cursor: string | undefined;
      do {
        const page = await target.list({ cursor, limit: 1000 });
        for (const m of page.items)
          if (
            (m.type === ARCHIVE_TYPE || m.type === ARCHIVE_TYPE_ENCRYPTED) &&
            !known.has(m.sha256)
          )
            unknownArchives.push({ sha256: m.sha256, size: m.size });
        cursor = page.cursor;
      } while (cursor);
    }
    return { backups, unknownArchives };
  }

  /** Is a scheduled backup due now? */
  async due(): Promise<boolean> {
    const cfg = this.config().backups;
    if (!cfg.enabled) return false;
    const last = await this.last();
    if (!last) return true;
    const interval = SCHEDULE_SECONDS[cfg.schedule];
    const age = this.ports.clock.now() - last.at;
    return last.ok ? age >= interval : age >= Math.min(interval, 3600);
  }

  // ── run ──

  /** True while a backup is being made. */
  inProgress(): boolean {
    return this.running !== null;
  }

  /** Make a backup now (single-flight). Never throws: failures land in `last`. */
  run(trigger: 'scheduled' | 'manual' = 'manual'): Promise<BackupLast> {
    this.running ??= this.doRun(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(trigger: 'scheduled' | 'manual'): Promise<BackupLast> {
    const started = this.ports.clock.nowMs();
    const prev = await this.last();
    try {
      const target = await this.target();
      if (!target) throw new Error('No backup storage is configured');
      const { bytes, manifest, encrypted } = await this.buildArchive(target);
      const sha256 = await this.ports.crypto.sha256Hex(bytes);
      const type = encrypted ? ARCHIVE_TYPE_ENCRYPTED : ARCHIVE_TYPE;
      await target.put({ sha256, size: bytes.length, type }, bytes);
      const location = `${this.targetUri() ?? target.kind}/${sha256}`;
      const record: BackupRecord = {
        id: manifest.id,
        at: manifest.createdAt,
        ok: true,
        trigger,
        sha256,
        size: bytes.length,
        location,
        dbFormat: manifest.dbFormat,
        driver: manifest.driver,
        events: Object.values(manifest.events).reduce((a, b) => a + b, 0),
        ...(manifest.tables.docs !== undefined ? { docs: manifest.tables.docs } : {}),
        blobs: manifest.blobs.unique,
        ...(manifest.config.revision !== undefined
          ? { configRevision: manifest.config.revision }
          : {}),
        ...(encrypted ? { encrypted: true } : {}),
        ...(manifest.secrets ? { secrets: manifest.secrets } : {}),
        durationMs: this.ports.clock.nowMs() - started,
      };
      await this.ports.docs.put(COL.backups, record.id, record);
      await this.prune(target);
      const last: BackupLast = {
        at: record.at,
        ok: true,
        size: record.size,
        location,
        id: record.id,
        lastOkAt: record.at,
        durationMs: record.durationMs,
      };
      await this.ports.docs.put(COL.backups, 'last', last);
      this.rt.log('info', 'backup finished', { id: record.id, size: record.size, trigger });
      return last;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const last: BackupLast = {
        at: this.ports.clock.now(),
        ok: false,
        error,
        ...(prev?.lastOkAt !== undefined ? { lastOkAt: prev.lastOkAt } : {}),
        ...(this.targetUri() ? { location: this.targetUri() as string } : {}),
        durationMs: this.ports.clock.nowMs() - started,
      };
      await this.ports.docs.put(COL.backups, 'last', last);
      this.rt.log('error', 'backup failed', { error, trigger });
      this.rt.kernel.bus.emit('error', { source: 'lifecycle.backups', message: error });
      if (trigger === 'scheduled')
        await this.rt.kernel
          .notify({
            severity: 'warning',
            title: 'Backup failed',
            body: `The scheduled backup did not finish: ${error}`,
          })
          .catch(() => {});
      return last;
    }
  }

  /** Keep the newest `config.backups.keep` archives. */
  private async prune(target: BlobStore): Promise<number> {
    const keep = this.config().backups.keep;
    const all = await this.catalog();
    let removed = 0;
    for (const old of all.slice(keep)) {
      if (!all.slice(0, keep).some((b) => b.sha256 === old.sha256))
        await target.delete(old.sha256).catch(() => false);
      await this.ports.docs.delete(COL.backups, old.id);
      removed++;
    }
    return removed;
  }

  private async native(): Promise<typeof import('./bun-native.ts') | null> {
    if (
      this.rt.opts.native === false ||
      typeof (globalThis as { Bun?: unknown }).Bun === 'undefined'
    )
      return null;
    try {
      const spec = './bun-native.ts';
      return (await import(spec)) as typeof import('./bun-native.ts');
    } catch {
      return null;
    }
  }

  async buildArchive(
    target?: BlobStore | null,
  ): Promise<{ bytes: Uint8Array; manifest: ArchiveManifest; encrypted: boolean }> {
    const now = this.ports.clock.now();
    const id = `b-${String(this.ports.clock.nowMs()).padStart(15, '0')}-${this.ports.crypto.randomHex(3)}`;
    const settings = this.rt.settings().backups;
    const sql = this.rt.sql();
    const entries: TarEntry[] = [];
    const add = (name: string, data: Uint8Array) => entries.push({ name, data, mtime: now });
    const tables: Record<string, number> = {};
    const events: Record<string, number> = {};
    let dbFormat: DbFormat = 'ports';
    let migrations: string[] = [];

    if (sql) {
      const x = sql.exec;
      migrations = await appliedMigrations(x);
      const native = await this.native();
      const wantSqlite =
        settings.format !== 'ndjson' && x.dialect === 'sqlite' && x.driver === 'sqlite' && native;
      if (settings.format === 'sqlite' && !wantSqlite)
        throw new Error('SQLite file backups need Bun with the SQLite driver');
      const exclude = settings.includeMetrics ? [] : ['metrics'];
      if (wantSqlite && native) {
        dbFormat = 'sqlite';
        const snap = await native.snapshotSqlite(x);
        add('db/beamhop.sqlite', snap);
        const src = await native.readSqliteSnapshot(snap);
        for (const t of src.tables()) tables[t] = [...src.rows(t)].length;
        // VACUUM INTO copies everything; `includeMetrics: false` only trims NDJSON dumps.
        countEvents(src.rows('events'), events);
      } else {
        dbFormat = 'ndjson';
        for (const d of await dumpTables(x, { exclude })) {
          tables[d.table] = d.rows.length;
          add(`db/${d.table}.ndjson`, ndjson(d.rows));
          if (d.table === 'events') countEvents(d.rows, events);
        }
        if (x.dialect === 'pg' && sql.url && native) {
          const dump = await native.pgDump(sql.url).catch((err) => {
            this.rt.log('warn', 'pg_dump failed; logical export only', { err: String(err) });
            return null;
          });
          if (dump) add('db/pg_dump.sql', dump);
        }
      }
    } else {
      for (const relay of this.config().relays) {
        const evs = await allEvents(this.ports.events, relay.id);
        events[relay.id] = evs.length;
        add(`ports/events/${relay.id}.ndjson`, ndjson(evs));
      }
    }

    // Blob manifest (+ optional bytes).
    const owners: BlobOwnership[] = [];
    for (const relay of this.config().relays) {
      let cursor: string | undefined;
      do {
        const page = await this.ports.blobIndex.list(relay.id, { cursor, limit: 1000 });
        owners.push(...page.items);
        cursor = page.cursor;
      } while (cursor);
    }
    add('blobs/manifest.ndjson', ndjson(owners));
    const unique = [...new Set(owners.map((o) => o.sha256))];
    let bytesCopied = 0;
    if (settings.includeBlobBytes && target && target !== this.ports.blobs) {
      for (const sha of unique) {
        if (await target.head(sha)) continue;
        const b = await this.ports.blobs.get(sha);
        if (!b) continue;
        const data = await readAll(b.body);
        await target.put({ sha256: sha, size: data.length, type: b.type }, data);
        bytesCopied += data.length;
      }
    }

    // Config revision.
    const cfgSvc = this.rt.kernel.use<{
      current?(): Promise<{ revision: number; config: BeamhopConfig }>;
    }>('admin.config');
    const current = (await cfgSvc?.current?.().catch(() => undefined)) ?? {
      config: this.config(),
    };
    // Secrets stay only inside an encrypted archive or when explicitly opted in.
    const wrapper = this.ports.keyWrapper;
    const secrets: 'included' | 'masked' =
      wrapper || settings.includeSecrets ? 'included' : 'masked';
    add('config/config.json', json(secrets === 'included' ? current : maskSecrets(current)));

    const files: ArchiveManifest['files'] = [];
    for (const e of entries)
      files.push({
        path: e.name,
        size: e.data.length,
        sha256: await this.ports.crypto.sha256Hex(e.data),
      });
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      version: 1,
      id,
      createdAt: now,
      nodeId: this.config().node.id,
      runtime: this.rt.kernel.runtime,
      driver: sql?.exec.driver ?? 'ports',
      dbFormat,
      files,
      tables,
      events,
      blobs: { owners: owners.length, unique: unique.length, bytesCopied },
      config: 'revision' in current ? { revision: current.revision } : {},
      secrets,
      migrations,
    };
    const tar = tarPack([{ name: 'manifest.json', data: json(manifest), mtime: now }, ...entries]);
    const gz = await gzip(tar);
    if (!wrapper) return { bytes: gz, manifest, encrypted: false };
    return { bytes: await encryptArchive(gz, wrapper), manifest, encrypted: true };
  }

  /** The gzip'd tar inside stored archive bytes (decrypting sealed archives). */
  private async plainArchive(bytes: Uint8Array): Promise<Uint8Array> {
    return isEncryptedArchive(bytes) ? decryptArchive(bytes, this.ports.keyWrapper) : bytes;
  }

  // ── verify / load ──

  /** Parse and integrity-check archive bytes (manifest hashes, format). */
  async verifyBytes(bytes: Uint8Array, expectedSha?: string): Promise<VerifyResult> {
    const problems: string[] = [];
    if (expectedSha) {
      const sha = await this.ports.crypto.sha256Hex(bytes);
      if (sha !== expectedSha) problems.push('archive checksum does not match the catalog');
    }
    let files: Map<string, Uint8Array>;
    try {
      const plain = await this.plainArchive(bytes);
      files = new Map(tarUnpack(await gunzip(plain)).map((e) => [e.name, e.data]));
    } catch (err) {
      return { ok: false, problems: [...problems, `archive is unreadable: ${String(err)}`] };
    }
    const raw = files.get('manifest.json');
    if (!raw) return { ok: false, problems: [...problems, 'manifest.json is missing'] };
    let manifest: ArchiveManifest;
    try {
      manifest = JSON.parse(dec.decode(raw)) as ArchiveManifest;
    } catch {
      return { ok: false, problems: [...problems, 'manifest.json is not valid JSON'] };
    }
    if (manifest.format !== ARCHIVE_FORMAT || manifest.version !== 1)
      problems.push(`unsupported archive format ${manifest.format}@${manifest.version}`);
    for (const f of manifest.files ?? []) {
      const data = files.get(f.path);
      if (!data) {
        problems.push(`${f.path} is missing`);
        continue;
      }
      if (data.length !== f.size || (await this.ports.crypto.sha256Hex(data)) !== f.sha256)
        problems.push(`${f.path} is damaged (checksum mismatch)`);
    }
    const listed = new Set((manifest.files ?? []).map((f) => f.path));
    for (const name of files.keys())
      if (name !== 'manifest.json' && !listed.has(name))
        problems.push(`${name} is not listed in the manifest`);
    return { ok: problems.length === 0, problems, manifest };
  }

  private async findRecord(id: string): Promise<BackupRecord | { sha256: string } | null> {
    const rec = await this.ports.docs.get<BackupRecord>(COL.backups, id);
    if (rec) return rec;
    if (/^[0-9a-f]{64}$/.test(id)) return { sha256: id };
    return null;
  }

  private async fetchBytes(id: string): Promise<{ bytes: Uint8Array; sha256: string }> {
    const rec = await this.findRecord(id);
    if (!rec) throw new Error(`No backup called ${id}`);
    const target = await this.target();
    if (!target) throw new Error('No backup storage is configured');
    const body = await target.get(rec.sha256);
    if (!body) throw new Error('The backup file is missing from backup storage');
    return { bytes: await readAll(body.body), sha256: rec.sha256 };
  }

  async verify(id: string): Promise<VerifyResult> {
    try {
      const { bytes, sha256 } = await this.fetchBytes(id);
      return await this.verifyBytes(bytes, sha256);
    } catch (err) {
      return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
    }
  }

  private async load(id: string): Promise<LoadedArchive> {
    const { bytes, sha256 } = await this.fetchBytes(id);
    const v = await this.verifyBytes(bytes, sha256);
    if (!v.ok || !v.manifest)
      throw new Error(`Backup failed its integrity check: ${v.problems.join('; ')}`);
    const plain = await this.plainArchive(bytes);
    const files = new Map(tarUnpack(await gunzip(plain)).map((e) => [e.name, e.data]));
    return { manifest: v.manifest, files };
  }

  // ── restore ──

  async restorePreview(id: string): Promise<DiffLine[]> {
    let archive: LoadedArchive;
    try {
      archive = await this.load(id);
    } catch (err) {
      return [{ kind: 'warning', text: err instanceof Error ? err.message : String(err) }];
    }
    const m = archive.manifest;
    const when = new Date(m.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const lines: DiffLine[] = [
      {
        kind: 'warning',
        text: `Everything will go back to how it was on ${when} UTC. Changes made since then are lost.`,
        technical: `restore ${m.id} (${m.dbFormat}, driver ${m.driver})`,
      },
      { kind: 'info', text: 'New posts and uploads are paused while the backup is restored.' },
    ];
    const sql = this.rt.sql();
    for (const relay of this.config().relays) {
      const now = await this.ports.events.count(relay.id, [{}]);
      const then = m.events[relay.id] ?? 0;
      lines.push({
        kind: 'change',
        text: `${relay.info.name}: ${now} posts now → ${then} posts from the backup`,
        technical: `events[relay_id=${relay.id}]: ${now} → ${then}`,
      });
    }
    if (sql && m.dbFormat !== 'ports') {
      for (const [table, then] of Object.entries(m.tables)) {
        if (table === 'events' || table === MIGRATIONS_TABLE) continue;
        const now = await countRows(sql.exec, table).catch(() => 0);
        lines.push({
          kind: 'change',
          text: `${tableLabel(table)}: replaced (${now} → ${then} records)`,
          technical: `${table}: ${now} → ${then} rows`,
        });
      }
    } else if (m.dbFormat === 'ports') {
      lines.push({
        kind: 'info',
        text: 'This backup only has posts: they are added back, nothing else is replaced.',
        technical: 'ports format: events re-saved (merge); no docs/tables',
      });
    }
    lines.push({
      kind: 'info',
      text: `${m.blobs.unique} media files are listed; missing ones are copied back from backup storage when available.`,
      technical: `blobs/manifest.ndjson owners=${m.blobs.owners} unique=${m.blobs.unique}`,
    });
    lines.push({
      kind: 'info',
      text: 'Your current settings stay active; the backup’s settings appear in settings history.',
      technical: `config revision in archive: ${m.config.revision ?? 'n/a'}`,
    });
    return lines;
  }

  /**
   * Restore an archive: verify integrity, pause writes, replace tables, verify
   * row counts, then copy back missing blob bytes from the backup target.
   */
  async restore(id: string, opts: { blobs?: boolean } = {}): Promise<RestoreResult> {
    const archive = await this.load(id);
    const m = archive.manifest;
    const sql = this.rt.sql();
    const problems: string[] = [];

    if (m.dbFormat !== 'ports') {
      if (!sql) throw new Error('This backup needs a SQL database to restore into');
      const live = new Set(await appliedMigrations(sql.exec));
      const newer = m.migrations.filter((t) => !live.has(t));
      if (newer.length)
        throw new Error(
          `This backup comes from a newer Beamhop version (unknown migrations: ${newer.join(', ')})`,
        );
    }

    const result: RestoreResult = {
      ok: false,
      id: m.id,
      tables: {},
      events: {},
      blobs: { restored: 0, missing: 0, present: 0 },
      problems,
    };
    this.rt.restoring = true;
    try {
      // The catalog describes archives that still exist: keep it across the restore.
      const keepCatalog = await this.ports.docs.list<unknown>(COL.backups, { limit: 10_000 });

      if (m.dbFormat === 'ports') {
        for (const [path, data] of archive.files) {
          const match = /^ports\/events\/(.+)\.ndjson$/.exec(path);
          if (!match) continue;
          for (const e of parseNdjson<NostrEvent>(data))
            await this.ports.events.save(match[1] as string, e);
        }
      } else if (sql) {
        const source = await this.tableSource(archive);
        const r = await restoreTables(sql.exec, source);
        result.tables = r.tables;
        for (const t of r.skipped) problems.push(`table ${t} does not exist here; skipped`);
        for (const [table, n] of Object.entries(r.tables)) {
          const want = m.tables[table];
          if (want !== undefined && want !== n)
            problems.push(`${table}: expected ${want} rows, found ${n}`);
        }
      }

      for (const i of keepCatalog.items) await this.ports.docs.put(COL.backups, i.key, i.value);

      for (const relay of this.config().relays) {
        const n = await this.ports.events.count(relay.id, [{}]);
        result.events[relay.id] = n;
        const want = m.events[relay.id];
        if (want !== undefined && m.dbFormat !== 'ports' && want !== n)
          problems.push(`${relay.id}: expected ${want} posts, found ${n}`);
      }

      if (opts.blobs !== false) result.blobs = await this.restoreBlobs(archive);
    } finally {
      this.rt.restoring = false;
    }
    result.ok = problems.length === 0;
    await this.ports.docs.put(COL.restore, 'last', {
      at: this.ports.clock.now(),
      id: m.id,
      ok: result.ok,
      problems,
    });
    this.rt.log(result.ok ? 'info' : 'warn', 'backup restored', { id: m.id, problems });
    return result;
  }

  private async tableSource(archive: LoadedArchive): Promise<TableSource> {
    if (archive.manifest.dbFormat === 'sqlite') {
      const native = await this.native();
      const file = archive.files.get('db/beamhop.sqlite');
      if (!native || !file) throw new Error('SQLite snapshots can only be restored on Bun');
      return native.readSqliteSnapshot(file);
    }
    const map = new Map<string, Row[]>();
    for (const [path, data] of archive.files) {
      const match = /^db\/(.+)\.ndjson$/.exec(path);
      if (match) map.set(match[1] as string, parseNdjson(data));
    }
    return { tables: () => [...map.keys()], rows: (t) => map.get(t) ?? [] };
  }

  private async restoreBlobs(archive: LoadedArchive): Promise<RestoreResult['blobs']> {
    const out = { restored: 0, missing: 0, present: 0 };
    const raw = archive.files.get('blobs/manifest.ndjson');
    if (!raw) return out;
    const target = await this.target().catch(() => null);
    const seen = new Set<string>();
    for (const o of parseNdjson<BlobOwnership>(raw)) {
      if (seen.has(o.sha256)) continue;
      seen.add(o.sha256);
      if (await this.ports.blobs.head(o.sha256)) {
        out.present++;
        continue;
      }
      const b = target && target !== this.ports.blobs ? await target.get(o.sha256) : null;
      if (!b) {
        out.missing++;
        continue;
      }
      const data = await readAll(b.body);
      await this.ports.blobs.put({ sha256: o.sha256, size: data.length, type: o.type }, data);
      out.restored++;
    }
    return out;
  }
}

function countEvents(rows: Iterable<Row>, into: Record<string, number>) {
  for (const r of rows) {
    const id = String(r.relay_id);
    into[id] = (into[id] ?? 0) + 1;
  }
}

async function allEvents(
  store: LifecycleRuntime['ports']['events'],
  relayId: string,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | undefined;
  for (;;) {
    const page = await store.query(relayId, [
      { ...(until !== undefined ? { until } : {}), limit: 1000 },
    ]);
    let fresh = 0;
    for (const e of page) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      fresh++;
    }
    if (page.length < 1000 || fresh === 0) break;
    until = Math.min(...page.map((e) => e.created_at));
  }
  return out;
}

function tableLabel(table: string): string {
  switch (table) {
    case 'docs':
      return 'Settings, admins and app data';
    case 'blob_owners':
      return 'Media ownership';
    case 'tombstones':
      return 'Deletion records';
    case 'metrics':
      return 'Chart history';
    default:
      return `Table ${table}`;
  }
}
