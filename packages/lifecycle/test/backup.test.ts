// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryBlobStore, makeKey } from '@beamhop/testkit';
import {
  ARCHIVE_TYPE,
  type BackupLast,
  type BackupRecord,
  COL,
  gunzip,
  gzip,
  tarPack,
  tarUnpack,
} from '../src/index.ts';
import { cleanupAll, setup } from './helpers.ts';

afterEach(cleanupAll);

const RELAYS = [
  { id: 'main', hosts: ['a.example'] },
  { id: 'team', hosts: ['b.example'] },
];

async function seed(t: Awaited<ReturnType<typeof setup>>) {
  const k = makeKey();
  const events = [];
  for (let i = 0; i < 25; i++) {
    const e = t.ev(k, {
      created_at: t.ports.clock.now() - i,
      tags: [['t', i % 2 ? 'odd' : 'even']],
      content: `post number ${i} about bananas`,
    });
    events.push(e);
    await t.ports.events.save(i < 20 ? 'main' : 'team', e);
  }
  await t.ports.docs.put('admin.users', 'alice', { role: 'owner' });
  await t.ports.docs.put('policy.state', 'x', { n: 1 });
  const data = new TextEncoder().encode('png bytes');
  const sha = await t.ports.crypto.sha256Hex(data);
  await t.ports.blobs.put({ sha256: sha, size: data.length, type: 'image/png' }, data);
  await t.ports.blobIndex.addOwner({
    relayId: 'main',
    sha256: sha,
    pubkey: k.pk,
    size: data.length,
    type: 'image/png',
    uploadedAt: t.ports.clock.now(),
  });
  return { k, events, sha };
}

describe.each(['sqlite', 'ndjson'] as const)('backup → restore roundtrip (%s)', (format) => {
  test('preserves event counts and doc collections', async () => {
    const t = await setup({
      sql: true,
      relays: RELAYS,
      backups: { enabled: true, keep: 5 },
      lifecycle: { backups: { format, includeBlobBytes: true } },
    });
    const { k, events, sha } = await seed(t);

    const { result } = await t.act('backups.run-now', {}, null);
    const last = result.output as BackupLast;
    expect(last.ok).toBe(true);
    expect(await t.ports.docs.get(COL.backups, 'last')).toMatchObject({
      ok: true,
      size: last.size,
    });
    const [rec] = await t.svc.backups.catalog();
    expect(rec?.dbFormat).toBe(format);
    expect(rec?.events).toBe(25);
    expect(await t.target?.head(rec?.sha256 as string)).toMatchObject({ type: ARCHIVE_TYPE });

    // Diverge: new posts, deletions, changed docs, lost media bytes.
    for (let i = 0; i < 5; i++) await t.ports.events.save('main', t.ev(k, { content: `new ${i}` }));
    await t.ports.events.deleteByIds('team', [events[22]?.id as string]);
    await t.ports.docs.put('admin.users', 'alice', { role: 'viewer' });
    await t.ports.docs.put('admin.users', 'mallory', { role: 'owner' });
    await t.ports.blobs.delete(sha);

    const { preview } = await t.act('backups.restore', { id: rec?.id }, null);
    expect(preview.some((l) => l.text.includes('25 posts now → 20 posts'))).toBe(true);
    expect(preview[0]?.kind).toBe('warning');

    // `act` ran it: verify the state.
    expect(await t.ports.events.count('main', [{}])).toBe(20);
    expect(await t.ports.events.count('team', [{}])).toBe(5);
    expect(await t.ports.docs.get('admin.users', 'alice')).toEqual({ role: 'owner' });
    expect(await t.ports.docs.get('admin.users', 'mallory')).toBeNull();
    expect(await t.ports.docs.get('policy.state', 'x')).toEqual({ n: 1 });
    // Tag index and full-text search are rebuilt by triggers.
    expect((await t.ports.events.query('main', [{ '#t': ['odd'] }])).length).toBe(10);
    expect((await t.ports.events.query('main', [{ search: 'bananas' }])).length).toBe(20);
    // Catalog survives the restore; blob bytes came back from the target.
    expect((await t.svc.backups.catalog()).map((b) => b.id)).toEqual([rec?.id as string]);
    expect(await t.ports.blobs.head(sha)).not.toBeNull();
    expect(await t.ports.docs.get(COL.restore, 'last')).toMatchObject({ ok: true });
    expect(t.svc.restoring()).toBe(false);
  });
});

describe('backups', () => {
  test('archive integrity failure is detected and blocks restore', async () => {
    const t = await setup({ sql: true, backups: { enabled: true } });
    await seed(t);
    await t.svc.backups.run('manual');
    const [rec] = (await t.svc.backups.catalog()) as BackupRecord[];
    const target = t.target as MemoryBlobStore;

    expect((await t.act('backups.verify', { id: rec?.id }, null)).result.output).toMatchObject({
      ok: true,
    });
    // The list remembers the check (shown as "checked" in the app).
    const checked = (await t.act('backups.list', {}, null)).result.output as {
      backups: BackupRecord[];
      running: boolean;
      standby: { enabled: boolean };
    };
    expect(checked.backups[0]?.verifiedOk).toBe(true);
    expect(checked.backups[0]?.verifiedAt).toBeGreaterThan(0);
    expect(checked.running).toBe(false);
    expect(checked.standby).toEqual({ enabled: false });

    // Tamper with one file inside the archive, keep the manifest.
    const body = await target.get(rec?.sha256 as string);
    const bytes = new Uint8Array(await new Response(body?.body).arrayBuffer());
    const entries = tarUnpack(await gunzip(bytes));
    const blobsFile = entries.find((e) => e.name === 'blobs/manifest.ndjson');
    if (!blobsFile) throw new Error('missing');
    blobsFile.data = new TextEncoder().encode('{"tampered":true}\n');
    const evil = await gzip(tarPack(entries));
    const evilSha = await t.ports.crypto.sha256Hex(evil);
    await target.put({ sha256: evilSha, size: evil.length, type: ARCHIVE_TYPE }, evil);

    const v = await t.svc.backups.verify(evilSha);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('blobs/manifest.ndjson is damaged');
    await expect(t.svc.backups.restore(evilSha)).rejects.toThrow(/integrity/);

    // Catalog checksum mismatch: bytes replaced under the catalogued key.
    await target.delete(rec?.sha256 as string);
    await target.put(
      { sha256: rec?.sha256 as string, size: evil.length, type: ARCHIVE_TYPE },
      evil,
    );
    const v2 = await t.svc.backups.verify(rec?.id as string);
    expect(v2.problems).toContain('archive checksum does not match the catalog');
    expect((await t.svc.backups.catalog())[0]?.verifiedOk).toBe(false);

    // Unreadable bytes.
    const junk = new TextEncoder().encode('not an archive');
    const junkSha = await t.ports.crypto.sha256Hex(junk);
    await target.put({ sha256: junkSha, size: junk.length, type: ARCHIVE_TYPE }, junk);
    expect((await t.svc.backups.verify(junkSha)).ok).toBe(false);

    // Unknown archives in the target are listed for disaster recovery.
    const listed = (await t.act('backups.list', {}, null)).result.output as {
      unknownArchives: Array<{ sha256: string }>;
    };
    expect(listed.unknownArchives.map((a) => a.sha256)).toContain(evilSha);
  });

  test('keeps only the newest N archives', async () => {
    const t = await setup({ sql: true, backups: { enabled: true, keep: 2 } });
    for (let i = 0; i < 4; i++) {
      await t.svc.backups.run('manual');
      t.ports.clock.advance(60);
    }
    const cat = await t.svc.backups.catalog();
    expect(cat.length).toBe(2);
    const listing = await (t.target as MemoryBlobStore).list();
    expect(listing.items.filter((i) => i.type === ARCHIVE_TYPE).length).toBe(2);
  });

  test('schedule: due logic, failure recorded in last + card', async () => {
    const t = await setup({ backups: { enabled: true, schedule: 'daily' }, target: null });
    expect(await t.svc.backups.due()).toBe(true);
    const last = await t.svc.backups.run('scheduled');
    expect(last.ok).toBe(false);
    expect(last.error).toContain('No backup storage');
    expect(await t.ports.docs.get(COL.backups, 'last')).toMatchObject({ ok: false });
    const cards = (await t.kernel.cards[0]?.cards(null)) ?? [];
    expect(cards.find((c) => c.id === 'lifecycle.backup-failed')?.primary?.actionId).toBe(
      'backups.run-now',
    );
    const health = await t.kernel.health.find((h) => h.id === 'lifecycle.backups')?.run(null);
    expect(health?.message).toBe('Backups have nowhere to go');
    // Failed runs retry after an hour, not a day.
    expect(await t.svc.backups.due()).toBe(false);
    t.ports.clock.advance(3601);
    expect(await t.svc.backups.due()).toBe(true);
  });

  test('failing target: warn, then critical when the last good backup is too old', async () => {
    const broken = new MemoryBlobStore();
    let fail = false;
    const put = broken.put.bind(broken);
    broken.put = async (m, d) => {
      if (fail) throw new Error('bucket unreachable');
      return put(m, d);
    };
    const t = await setup({ backups: { enabled: true, schedule: 'daily' }, target: broken });
    const check = t.kernel.health.find((h) => h.id === 'lifecycle.backups');
    expect((await t.svc.backups.run('scheduled')).ok).toBe(true);
    expect((await check?.run(null))?.status).toBe('ok');
    fail = true;
    t.ports.clock.advance(86_400);
    const bad = await t.svc.backups.run('scheduled');
    expect(bad).toMatchObject({ ok: false, error: 'bucket unreachable', lastOkAt: 1_700_000_000 });
    expect((await check?.run(null))?.status).toBe('warn');
    t.ports.clock.advance(2 * 86_400);
    await t.svc.backups.run('scheduled');
    expect((await check?.run(null))?.status).toBe('critical');
  });

  test('scheduled job runs when due (memory ports fallback format)', async () => {
    const t = await setup({ backups: { enabled: true, schedule: 'hourly' } });
    const k = makeKey();
    await t.ports.events.save('main', t.ev(k));
    await t.ports.scheduler.tick('lifecycle.backups');
    const last = (await t.svc.backups.last()) as BackupLast;
    expect(last.ok).toBe(true);
    const [rec] = await t.svc.backups.catalog();
    expect(rec?.dbFormat).toBe('ports');
    // Not due again until an hour passed.
    await t.ports.scheduler.tick('lifecycle.backups');
    expect((await t.svc.backups.catalog()).length).toBe(1);
    t.ports.clock.advance(3600);
    await t.ports.scheduler.tick('lifecycle.backups');
    expect((await t.svc.backups.catalog()).length).toBe(2);
    const health = await t.kernel.health.find((h) => h.id === 'lifecycle.backups')?.run(null);
    expect(health?.status).toBe('ok');
  });

  test('no backups configured → card with config patch preview', async () => {
    const t = await setup();
    const cards = (await t.kernel.cards[0]?.cards(null)) ?? [];
    const card = cards.find((c) => c.id === 'lifecycle.no-backups');
    expect(card?.title).toBe('No backups configured');
    expect(card?.primary?.actionId).toBe('backups.setup');
    const def = t.kernel.actions.get('backups.setup');
    const input = def?.input.parse(card?.primary?.input);
    const preview = (await def?.preview?.(input, t.ctx(null))) ?? [];
    expect(preview.map((l) => l.text)).toContain('Turn on automatic backups');
    // Without admin-api the patch is returned, not applied.
    const r = await def?.run(input, t.ctx(null));
    expect((r?.output as { committed: boolean }).committed).toBe(false);
  });

  test('restore preview on an unknown id explains the problem', async () => {
    const t = await setup({ sql: true, backups: { enabled: true } });
    const lines = await t.svc.backups.restorePreview('b-nope');
    expect(lines[0]?.kind).toBe('warning');
    expect(lines[0]?.text).toContain('No backup called b-nope');
  });

  test('blob bytes are only copied into a separate target', async () => {
    const blobs = new MemoryBlobStore();
    const t = await setup({
      backups: { enabled: true },
      lifecycle: { backups: { includeBlobBytes: true } },
      target: blobs,
    });
    (t.ports as unknown as { blobs: MemoryBlobStore }).blobs = blobs;
    await seed(t);
    const last = await t.svc.backups.run('manual');
    expect(last.ok).toBe(true);
    const [rec] = await t.svc.backups.catalog();
    const v = await t.svc.backups.verify(rec?.id as string);
    expect(v.manifest?.blobs).toMatchObject({ unique: 1, bytesCopied: 0 });
  });
});
