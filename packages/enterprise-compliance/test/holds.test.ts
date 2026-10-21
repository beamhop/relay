// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type RelayId, defineModule } from '@beamhop/core';
import { makeEvent, makeKey } from '@beamhop/testkit';
import type { ApprovalsService } from '../src/approvals.ts';
import { type ExportRecord, verifyArchive } from '../src/ediscovery.ts';
import type { HoldProvider, HoldSubject } from '../src/holds.ts';
import { complianceInternals } from '../src/module.ts';
import { utf8 } from '../src/util.ts';
import { alice, bob, makeKernel, runAction } from './helpers.ts';

/** Minimal stand-in for lifecycle's `lifecycle.holds` (same shape as the real service). */
function lifecycleStub() {
  const providers = new Map<string, HoldProvider>();
  const holds = {
    register(p: HoldProvider) {
      providers.set(p.id, p);
      return () => providers.delete(p.id);
    },
    async isHeld(relayId: RelayId, subject: HoldSubject) {
      for (const p of providers.values()) if (await p.isHeld(relayId, subject)) return true;
      return false;
    },
    active: () => providers.size > 0,
  };
  const module = defineModule({
    id: 'lifecycle',
    register(k) {
      k.provide('lifecycle.holds', holds);
    },
  });
  return { holds, module, providers };
}

const identityStub = (groups: Record<string, string[]>, subjects: Record<string, string> = {}) =>
  defineModule({
    id: 'enterprise-identity',
    register(k) {
      k.provide('enterprise.identity', {
        groupsOf: (pk: string) => groups[pk] ?? [],
        pubkeyOf: (s: string) => subjects[s] ?? null,
        members: async () => Object.entries(groups).map(([pubkey, g]) => ({ pubkey, groups: g })),
      });
    },
  });

describe('legal hold', () => {
  test('registers into lifecycle.holds; blocks retention and key destruction for held people', async () => {
    const lc = lifecycleStub();
    const finance = makeKey();
    const other = makeKey();
    const { kernel, ports } = await makeKernel({
      extra: [lc.module, identityStub({ [finance.pk]: ['finance'] })],
    });
    expect(lc.providers.has('enterprise-compliance')).toBe(true);
    await runAction(
      kernel,
      'compliance.create-hold',
      { name: 'Matter 1', reason: 'litigation', groups: ['finance'], until: 1_800_000_000 },
      alice,
    );
    const e1 = makeEvent(finance, { created_at: 1_700_000_100 });
    const e2 = makeEvent(other, { created_at: 1_700_000_100 });
    await ports.events.save('main', e1);
    await ports.events.save('main', e2);

    // A lifecycle-like retention pass that asks holds before deleting.
    const retention = async () => {
      const all = await ports.events.query('main', [{}]);
      const doomed = [];
      for (const e of all)
        if (
          !(await lc.holds.isHeld('main', {
            pubkey: e.pubkey,
            eventId: e.id,
            createdAt: e.created_at,
          }))
        )
          doomed.push(e.id);
      await ports.events.deleteByIds('main', doomed);
    };
    await retention();
    expect(await ports.events.getById('main', e1.id)).not.toBeNull();
    expect(await ports.events.getById('main', e2.id)).toBeNull();
    // Crypto-shred of a managed key (node-wide check).
    expect(await lc.holds.isHeld('*', { pubkey: finance.pk })).toBe(true);
    expect(await lc.holds.isHeld('*', { pubkey: other.pk })).toBe(false);
    // Date range: events after `until` are not held.
    expect(await lc.holds.isHeld('main', { pubkey: finance.pk, createdAt: 1_900_000_000 })).toBe(
      false,
    );
  });

  test('relay-scoped hold and directory subjects', async () => {
    const lc = lifecycleStub();
    const k = makeKey();
    const { kernel } = await makeKernel({
      extra: [lc.module, identityStub({}, { 'carol@corp.com': k.pk })],
      relays: [
        { id: 'main', hosts: ['a.test'] },
        { id: 'other', hosts: ['b.test'] },
      ],
    });
    await runAction(
      kernel,
      'compliance.create-hold',
      { name: 'M', reason: 'r', subjects: [{ subject: 'carol@corp.com' }], relays: ['main'] },
      alice,
    );
    expect(await lc.holds.isHeld('main', { pubkey: k.pk })).toBe(true);
    expect(await lc.holds.isHeld('other', { pubkey: k.pk })).toBe(false);
  });

  test('store guard archives held events before NIP-09, NIP-62 and admin deletion', async () => {
    const k = makeKey();
    const { kernel, ports } = await makeKernel({});
    await runAction(
      kernel,
      'compliance.create-hold',
      { name: 'M', reason: 'r', pubkeys: [k.pk] },
      alice,
    );
    const a = makeEvent(k, { content: 'secret plan' });
    const b = makeEvent(k, { content: 'second' });
    const c = makeEvent(k, { content: 'third' });
    for (const e of [a, b, c]) await ports.events.save('main', e);
    const del = makeEvent(k, { kind: 5, tags: [['e', a.id]] });
    expect(await ports.events.applyDeletion('main', del)).toEqual([a.id]);
    await ports.events.deleteByIds('main', [b.id]);
    await ports.events.vanish('main', k.pk, 2_000_000_000);
    expect(await ports.events.getById('main', c.id)).toBeNull();
    const holds = complianceInternals(kernel)!.holds;
    const archived = (await holds.archived('main')).map((x) => x.event.id).sort();
    expect(archived).toEqual([a.id, b.id, c.id].sort());
  });

  test('held blobs are pinned: owners can be removed but bytes stay', async () => {
    const k = makeKey();
    const { kernel, ports } = await makeKernel({});
    await runAction(
      kernel,
      'compliance.create-hold',
      { name: 'M', reason: 'r', pubkeys: [k.pk] },
      alice,
    );
    const data = utf8('file');
    const sha = await ports.crypto.sha256Hex(data);
    await ports.blobs.put({ sha256: sha, size: data.length, type: 'text/plain' }, data);
    await ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: k.pk,
      size: data.length,
      type: 'text/plain',
      uploadedAt: 1,
    });
    expect(await ports.blobIndex.removeOwner('main', sha, k.pk)).toBe(true);
    expect(await ports.blobs.delete(sha)).toBe(false);
    expect(await ports.blobs.head(sha)).not.toBeNull();
  });

  test('release needs a second admin; afterwards nothing is held', async () => {
    const lc = lifecycleStub();
    const k = makeKey();
    const { kernel } = await makeKernel({ extra: [lc.module] });
    const r = await runAction(
      kernel,
      'compliance.create-hold',
      { name: 'M', reason: 'r', pubkeys: [k.pk] },
      alice,
    );
    const holdId = (r.output as { hold: { id: string } }).hold.id;
    const pending = await runAction(
      kernel,
      'compliance.release-hold',
      { holdId, reason: 'settled' },
      alice,
    );
    const requestId = (pending.output as { requestId: string }).requestId;
    expect(await lc.holds.isHeld('main', { pubkey: k.pk })).toBe(true);
    await kernel.use<ApprovalsService>('enterprise.approvals')!.approve(requestId, bob);
    await runAction(
      kernel,
      'compliance.release-hold',
      { holdId, reason: 'settled', _approvalId: requestId },
      alice,
    );
    expect(await lc.holds.isHeld('main', { pubkey: k.pk })).toBe(false);
  });

  test('no holds → store guard is a pass-through', async () => {
    const k = makeKey();
    const { kernel, ports } = await makeKernel({});
    const e = makeEvent(k);
    await ports.events.save('main', e);
    await ports.events.deleteByIds('main', [e.id]);
    expect(await complianceInternals(kernel)!.holds.archived()).toEqual([]);
  });
});

describe('eDiscovery export', () => {
  async function exportFixture() {
    const k1 = makeKey();
    const k2 = makeKey();
    const env = await makeKernel({});
    const { kernel, ports } = env;
    await ports.events.save(
      'main',
      makeEvent(k1, { content: 'Quarterly budget draft', created_at: 1_700_000_010 }),
    );
    await ports.events.save(
      'main',
      makeEvent(k1, { content: 'lunch?', created_at: 1_700_000_020 }),
    );
    await ports.events.save(
      'main',
      makeEvent(k2, { content: 'budget too', created_at: 1_700_000_030 }),
    );
    const data = utf8('attachment');
    const sha = await ports.crypto.sha256Hex(data);
    await ports.blobs.put({ sha256: sha, size: data.length, type: 'text/plain' }, data);
    await ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: k1.pk,
      size: data.length,
      type: 'text/plain',
      uploadedAt: 1_700_000_015,
    });
    const r = await runAction(
      kernel,
      'compliance.export',
      { name: 'Case 7', pubkeys: [k1.pk], keywords: ['budget'] },
      alice,
    );
    const rec = (r.output as { export: ExportRecord }).export;
    const files = await complianceInternals(kernel)!.ediscovery.files(rec.id);
    return { ...env, rec, files, k1, sha };
  }

  test('archive contains matching events, blob manifest, and verifies', async () => {
    const { rec, files, sha } = await exportFixture();
    expect(rec.counts.events).toBe(1);
    expect(rec.counts.blobs).toBe(1);
    const events = new TextDecoder().decode(files['events/main.ndjson']).trim().split('\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!).content).toBe('Quarterly budget draft');
    expect(new TextDecoder().decode(files['blobs.ndjson'])).toContain(sha);
    const v = await verifyArchive(files, {
      expectedSigner: rec.signer,
      checkEventSignatures: true,
    });
    expect(v).toEqual({ ok: true, signer: rec.signer, errors: [], events: 1 });
  });

  test('tampering with any file or the manifest is detected', async () => {
    const { files, rec } = await exportFixture();
    const edited = { ...files, 'events/main.ndjson': utf8('{"id":"forged"}\n') };
    const v1 = await verifyArchive(edited);
    expect(v1.ok).toBe(false);
    expect(v1.errors.join(' ')).toContain('events/main.ndjson was modified');

    const m = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    m.counts.events = 99;
    const v2 = await verifyArchive({ ...files, 'manifest.json': utf8(JSON.stringify(m, null, 2)) });
    expect(v2.ok).toBe(false);
    expect(v2.errors).toContain('manifest.json does not match its signature');

    const v3 = await verifyArchive(files, { expectedSigner: 'f'.repeat(64) });
    expect(v3.errors).toContain('archive was signed by an unexpected key');
    expect(rec.files.map((f) => f.path)).toEqual([
      'events/main.ndjson',
      'blobs.ndjson',
      'manifest.json',
      'signature.json',
    ]);
  });

  test('archive files are pinned against blob garbage collection', async () => {
    const { ports, rec } = await exportFixture();
    for (const f of rec.files) expect(await ports.blobs.delete(f.sha256)).toBe(false);
  });

  test('deleted-but-held events are included from the hold archive', async () => {
    const k = makeKey();
    const { kernel, ports } = await makeKernel({});
    await runAction(
      kernel,
      'compliance.create-hold',
      { name: 'M', reason: 'r', pubkeys: [k.pk] },
      alice,
    );
    const e = makeEvent(k, { content: 'deleted later' });
    await ports.events.save('main', e);
    await ports.events.applyDeletion('main', makeEvent(k, { kind: 5, tags: [['e', e.id]] }));
    const r = await runAction(kernel, 'compliance.export', { pubkeys: [k.pk] }, alice);
    const rec = (r.output as { export: ExportRecord }).export;
    expect(rec.counts.archivedEvents).toBe(1);
    const files = await complianceInternals(kernel)!.ediscovery.files(rec.id);
    expect(new TextDecoder().decode(files['events/main.ndjson'])).toContain(e.id);
  });
});
