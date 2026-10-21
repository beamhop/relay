// SPDX-License-Identifier: AGPL-3.0-or-later
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@beamhop/core';
import { backupCommand } from '../src/commands/backup.ts';
import { moveCommand, parseS3, s3Upload } from '../src/commands/move.ts';
import { BufferIo, EXIT } from '../src/io.ts';
import { createSnapshot, inspectSnapshot, restoreSnapshot } from '../src/snapshot.ts';
import { TarWriter } from '../src/tar.ts';
import { testContext, tmp } from './helpers.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

function blob(text: string) {
  const data = new TextEncoder().encode(text);
  return { data, sha: new Bun.CryptoHasher('sha256').update(data).digest('hex') };
}

/** A data dir with a SQLite DB (3 events, 1 doc), two media files and a key. */
function makeNode(events = 3) {
  const dir = tmp();
  const dataDir = join(dir, 'data');
  for (const d of ['db', 'blobs', 'secrets', 'backups'])
    mkdirSync(join(dataDir, d), { recursive: true });
  const db = new Database(join(dataDir, 'db', 'beamhop.sqlite'));
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE events (id TEXT PRIMARY KEY, content TEXT)');
  db.run('CREATE TABLE docs (k TEXT PRIMARY KEY, v TEXT)');
  for (let i = 0; i < events; i++)
    db.run('INSERT INTO events VALUES (?, ?)', [`e${i}`, `hello ${i}`]);
  db.run("INSERT INTO docs VALUES ('claim', 'x')");
  db.close();
  for (const t of ['first file', 'second file']) {
    const b = blob(t);
    const p = join(dataDir, 'blobs', b.sha.slice(0, 2), b.sha.slice(2, 4));
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, b.sha), b.data);
  }
  writeFileSync(join(dataDir, 'secrets', 'ip-salt.key'), 'ab'.repeat(32), { mode: 0o600 });
  writeFileSync(join(dataDir, 'state.json'), '{"firstBootAt":"2026-01-01T00:00:00.000Z"}');
  const yaml = `node:\n  dataDir: ${dataDir}\nrelays:\n  - id: main\n    hosts: [relay.example.com]\n`;
  writeFileSync(join(dir, 'beamhop.yaml'), yaml);
  const config = parseConfig(Bun.YAML.parse(yaml));
  return { dir, dataDir, config };
}

describe('snapshots', () => {
  test('move snapshot round-trips with hashes, counts, blobs and private keys', async () => {
    const { dir, config } = makeNode();
    const out = join(dir, 'move.tar.gz');
    const m = await createSnapshot({
      kind: 'move',
      config,
      configFile: join(dir, 'beamhop.yaml'),
      out,
      includeBlobs: true,
      includeKeys: true,
      now: NOW,
    });
    expect(m.counts).toEqual({ docs: 1, events: 3 });
    expect(m.blobStorage).toMatchObject({ count: 2, included: true });
    expect(m.files.map((f) => f.path).sort()).toEqual(
      [
        'beamhop.yaml',
        'data/db/beamhop.sqlite',
        'data/secrets/ip-salt.key',
        'data/state.json',
        ...m.blobs.map(([h]) => `blobs/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`),
      ].sort(),
    );
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect((await inspectSnapshot(out)).problems).toEqual([]);

    const target = tmp();
    const r = await restoreSnapshot(out, {
      dataDir: join(target, 'data'),
      blobsDir: join(target, 'data', 'blobs'),
      configDest: join(target, 'beamhop.yaml'),
      now: NOW,
    });
    expect(r.counts).toEqual({ docs: 1, events: 3 });
    expect(statSync(join(target, 'data', 'secrets', 'ip-salt.key')).mode & 0o777).toBe(0o600);
    for (const [h] of m.blobs)
      expect(existsSync(join(target, 'data', 'blobs', h.slice(0, 2), h.slice(2, 4), h))).toBe(true);
    expect(readFileSync(join(target, 'beamhop.yaml'), 'utf8')).toContain('relay.example.com');
  });

  test('damaged files and path traversal are refused', async () => {
    const dir = tmp();
    const good = new TextEncoder().encode('fine');
    const manifest = {
      format: 'beamhop-snapshot',
      version: 1,
      kind: 'move',
      createdAt: '',
      nodeId: 'x',
      storage: { driver: 'sqlite', included: true },
      blobStorage: { driver: 'fs', included: false, count: 0, bytes: 0 },
      counts: {},
      blobs: [],
      files: [
        { path: 'data/state.json', size: 4, sha256: 'ff'.repeat(32), mode: 0o644 },
        {
          path: 'data/../../evil',
          size: 4,
          sha256: new Bun.CryptoHasher('sha256').update(good).digest('hex'),
          mode: 0o644,
        },
      ],
    };
    const tarPath = join(dir, 'bad.tar');
    const w = new TarWriter(tarPath);
    w.addBytes('data/state.json', good);
    w.addBytes('data/../../evil', good);
    w.addBytes('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
    w.close();
    const { problems } = await inspectSnapshot(tarPath);
    expect(problems).toEqual(['damaged: data/state.json']);
    await expect(
      restoreSnapshot(tarPath, { dataDir: join(dir, 'd'), blobsDir: join(dir, 'b'), now: 1 }),
    ).rejects.toThrow('integrity check');
    // Fix the hash: now the traversal entry is what gets refused.
    manifest.files[0]!.sha256 = manifest.files[1]!.sha256;
    const w2 = new TarWriter(tarPath);
    w2.addBytes('data/state.json', good);
    w2.addBytes('data/../../evil', good);
    w2.addBytes('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
    w2.close();
    await expect(
      restoreSnapshot(tarPath, { dataDir: join(dir, 'd'), blobsDir: join(dir, 'b'), now: 1 }),
    ).rejects.toThrow('unsafe path');
    expect(existsSync(join(dir, 'evil'))).toBe(false);
  });
});

describe('backup (local fallback, no lifecycle action)', () => {
  test('now → list → restore puts the old database back and keeps the current one', async () => {
    const { dir, dataDir } = makeNode(3);
    const noLocal = async () => {
      throw new Error('no local kernel in this test');
    };
    const ctx = (io: BufferIo) =>
      testContext({ io, cwd: dir, now: () => NOW, bootLocal: noLocal }).ctx as never;
    const io = new BufferIo();
    expect(await backupCommand(ctx(io), ['now'], {})).toBe(0);
    expect(io.stdout).toContain('Backup saved');
    expect(io.stdout).toContain('3 events, 2 media files listed');
    const file = /Backup saved: (\S+)/.exec(io.stdout)![1]!;
    expect(file.startsWith(join(dataDir, 'backups'))).toBe(true);

    const io2 = new BufferIo();
    await backupCommand(ctx(io2), ['list'], {});
    expect(io2.stdout).toContain(file);

    // Change the live DB, then restore.
    const db = new Database(join(dataDir, 'db', 'beamhop.sqlite'));
    db.run("INSERT INTO events VALUES ('late', 'after backup')");
    db.close();
    const io3 = new BufferIo();
    expect(await backupCommand(ctx(io3), ['restore', file], {})).toBe(EXIT.notApplied);
    const io4 = new BufferIo();
    expect(await backupCommand(ctx(io4), ['restore', file], { yes: true })).toBe(0);
    expect(io4.stdout).toContain('Counts match');
    const restored = new Database(join(dataDir, 'db', 'beamhop.sqlite'), { readonly: true });
    expect(restored.query<{ n: number }, []>('SELECT count(*) AS n FROM events').get()!.n).toBe(3);
    restored.close();
    expect(existsSync(join(dataDir, 'db', `beamhop.sqlite.before-restore-${NOW}`))).toBe(true);
  });
});

describe('move', () => {
  test('export on the old host, import + verify + DNS steps on the new one', async () => {
    const { dir } = makeNode(5);
    const out = join(dir, 'relay-move.tar.gz');
    const io = new BufferIo();
    const { ctx } = testContext({ io, cwd: dir, now: () => NOW });
    expect(await moveCommand(ctx as never, ['export', '--to', out], {})).toBe(0);
    expect(io.stdout).toContain('5 events, 2 media files');
    expect(io.stdout).toContain('beamhop move import');

    const io2 = new BufferIo();
    const { ctx: c2 } = testContext({ io: io2, now: () => NOW });
    expect(await moveCommand(c2 as never, ['verify', out], {})).toBe(0);
    expect(io2.stdout).toContain('intact');

    const newHost = tmp();
    const io3 = new BufferIo();
    const { ctx: c3 } = testContext({
      io: io3,
      cwd: newHost,
      now: () => NOW,
      env: { BEAMHOP_PUBLIC_IP: '203.0.113.9' },
    });
    expect(
      await moveCommand(c3 as never, ['import', out], {
        yes: true,
        'data-dir': join(newHost, 'data'),
      }),
    ).toBe(0);
    expect(io3.stdout).toContain('database counts match');
    expect(io3.stdout).toContain('relay.example.com  A     203.0.113.9');
    expect(readFileSync(join(newHost, 'beamhop.yaml'), 'utf8')).toContain(
      `dataDir: ${JSON.stringify(join(newHost, 'data'))}`,
    );
    const db = new Database(join(newHost, 'data', 'db', 'beamhop.sqlite'), { readonly: true });
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM events').get()!.n).toBe(5);
    db.close();
    // A second import refuses to overwrite without --force.
    await expect(
      moveCommand(c3 as never, ['import', out], { yes: true, 'data-dir': join(newHost, 'data') }),
    ).rejects.toThrow('already has a database');
  });

  test('S3 upload is a signed, path-style PUT', async () => {
    expect(parseS3('s3://bkt/a/b.tar.gz')).toEqual({ bucket: 'bkt', key: 'a/b.tar.gz' });
    expect(parseS3('/tmp/x')).toBeNull();
    const dir = tmp();
    const file = join(dir, 'x.tar.gz');
    writeFileSync(file, 'data');
    const seen: Request[] = [];
    const { ctx } = testContext({
      env: { AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK', AWS_REGION: 'eu-west-1' },
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(new Request(url, init));
        return new Response('', { status: 200 });
      }) as never,
    });
    await s3Upload(
      ctx as never,
      { endpoint: 'https://minio.example' },
      { bucket: 'bkt', key: 'moves/x.tar.gz' },
      file,
    );
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toBe('https://minio.example/bkt/moves/x.tar.gz');
    expect(seen[0]!.headers.get('authorization')).toStartWith('AWS4-HMAC-SHA256 Credential=AK/');
    expect(await seen[0]!.text()).toBe('data');
  });
});
