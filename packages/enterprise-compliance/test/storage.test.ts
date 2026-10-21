// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type KeyWrapper, defineModule, parseConfig } from '@beamhop/core';
import { MemoryBlobStore, blobStoreContract, collectStream } from '@beamhop/testkit';
import { ComplianceConfigSchema } from '../src/config.ts';
import { ENCRYPTED_CHUNK, EncryptedBlobStore } from '../src/encrypted-blobs.ts';
import { renderPdf } from '../src/pdf.ts';
import { monthRange, previousMonth, toCsv } from '../src/reports.ts';
import { checkResidency, regionMatches } from '../src/residency.ts';
import { RETENTION_SERVICE, type RetentionProvider } from '../src/retention.ts';
import { sha256Hex } from '../src/util.ts';
import { alice, makeKernel, runAction } from './helpers.ts';

/** Test KEK: AES-GCM with a fixed key (stands in for KMS/Vault). */
function testWrapper(): KeyWrapper & { wraps: number } {
  const keyP = crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const w = {
    provider: 'test-kek',
    wraps: 0,
    async wrap(p: Uint8Array) {
      w.wraps++;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const c = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          await keyP,
          p as Uint8Array<ArrayBuffer>,
        ),
      );
      const out = new Uint8Array(12 + c.length);
      out.set(iv);
      out.set(c, 12);
      return out;
    },
    async unwrap(c: Uint8Array) {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: c.slice(0, 12) },
          await keyP,
          c.slice(12) as Uint8Array<ArrayBuffer>,
        ),
      );
    },
  };
  return w;
}

blobStoreContract(
  'EncryptedBlobStore',
  async () => new EncryptedBlobStore(new MemoryBlobStore(), testWrapper()),
);

describe('EncryptedBlobStore', () => {
  test('stores ciphertext under the plaintext hash; ranges across chunks decrypt', async () => {
    const inner = new MemoryBlobStore();
    const store = new EncryptedBlobStore(inner, testWrapper());
    const data = crypto.getRandomValues(new Uint8Array(ENCRYPTED_CHUNK * 2 + 1234));
    const sha = await sha256Hex(data);
    await store.put({ sha256: sha, size: data.length, type: 'application/pdf' }, data);
    const raw = await collectStream((await inner.get(sha))!.body);
    expect(raw.length).toBeGreaterThan(data.length);
    expect(new TextDecoder().decode(raw.slice(0, 4))).toBe('BHE1');
    expect(Buffer.from(raw).includes(Buffer.from(data.slice(0, 64)))).toBe(false);
    expect(await store.head(sha)).toEqual({
      sha256: sha,
      size: data.length,
      type: 'application/pdf',
    });
    const full = await collectStream((await store.get(sha))!.body);
    expect(Buffer.compare(Buffer.from(full), Buffer.from(data))).toBe(0);
    const start = ENCRYPTED_CHUNK - 10;
    const end = ENCRYPTED_CHUNK * 2 + 5;
    const part = await collectStream((await store.get(sha, { start, end }))!.body);
    expect(Buffer.compare(Buffer.from(part), Buffer.from(data.slice(start, end + 1)))).toBe(0);
    // Fresh instance (no caches) reads via the wrapped key.
    const again = new EncryptedBlobStore(inner, testWrapper());
    const tail = await collectStream(
      (await again.get(sha, { start: data.length - 3, end: data.length - 1 }))!.body,
    );
    expect([...tail]).toEqual([...data.slice(-3)]);
  });

  test('tampered ciphertext fails integrity check; empty blobs work', async () => {
    const inner = new MemoryBlobStore();
    const store = new EncryptedBlobStore(inner, testWrapper());
    const data = new TextEncoder().encode('top secret');
    const sha = await sha256Hex(data);
    await store.put({ sha256: sha, size: data.length, type: 'text/plain' }, data);
    const raw = await collectStream((await inner.get(sha))!.body);
    raw[raw.length - 20]! ^= 1;
    const evil = new MemoryBlobStore();
    await evil.put({ sha256: sha, size: raw.length, type: 'x' }, raw);
    const s2 = new EncryptedBlobStore(evil, testWrapper());
    await expect(collectStream((await s2.get(sha))!.body)).rejects.toThrow(/integrity/);
    const empty = new Uint8Array();
    const esha = await sha256Hex(empty);
    await store.put({ sha256: esha, size: 0, type: 'text/plain' }, empty);
    expect((await collectStream((await store.get(esha))!.body)).length).toBe(0);
  });

  test('module encrypts ports.blobs in place when enabled; old plaintext stays readable', async () => {
    const blobs = new MemoryBlobStore();
    const legacy = new TextEncoder().encode('legacy');
    const lsha = await sha256Hex(legacy);
    await blobs.put({ sha256: lsha, size: legacy.length, type: 'text/plain' }, legacy);
    const { ports } = await makeKernel({
      modules: { 'enterprise-compliance': { encryption: { blobs: true } } },
      ports: { blobs, keyWrapper: testWrapper() },
    });
    const data = new TextEncoder().encode('new upload');
    const sha = await sha256Hex(data);
    await ports.blobs.put({ sha256: sha, size: data.length, type: 'text/plain' }, data);
    // The underlying map holds ciphertext.
    const rawInner = await MemoryBlobStore.prototype.get.call(blobs, sha);
    const raw = await collectStream(rawInner!.body);
    expect(new TextDecoder().decode(raw.slice(0, 4))).toBe('BHE1');
    expect(new TextDecoder().decode(await collectStream((await ports.blobs.get(sha))!.body))).toBe(
      'new upload',
    );
    expect(new TextDecoder().decode(await collectStream((await ports.blobs.get(lsha))!.body))).toBe(
      'legacy',
    );
  });
});

describe('retention by group', () => {
  test('longest matching group wins; default otherwise', async () => {
    const { kernel } = await makeKernel({
      modules: {
        'enterprise-compliance': {
          retention: {
            groups: [
              { group: 'finance', days: 2555 },
              { group: 'eng', days: 30 },
            ],
            defaultDays: 90,
          },
        },
      },
      extra: [
        defineModule({
          id: 'enterprise-identity',
          register(k) {
            k.provide('enterprise.identity', {
              groupsOf: (pk: string) =>
                pk === 'fin' ? ['finance', 'eng'] : pk === 'dev' ? ['eng'] : [],
            });
          },
        }),
      ],
    });
    const p = kernel.use<RetentionProvider>(RETENTION_SERVICE)!;
    expect(await p.retentionDays('main', 'fin')).toBe(2555);
    expect(await p.retentionDays('main', 'dev')).toBe(30);
    expect(await p.retentionDays('main', 'nobody')).toBe(90);
  });
});

describe('data residency', () => {
  test('region matching', () => {
    expect(regionMatches('eu', 'eu-west-1')).toBe(true);
    expect(regionMatches('eu', 'europe-west3')).toBe(true);
    expect(regionMatches('eu', 'weur')).toBe(true);
    expect(regionMatches('eu', 'us-east-1')).toBe(false);
    expect(regionMatches('us-east-1', 'us-east-1')).toBe(true);
  });

  test('mismatch is flagged in health and cards; fixed by config change', async () => {
    const { kernel } = await makeKernel({
      modules: {
        'enterprise-compliance': {
          residency: { databaseRegion: 'eu-central-1', relays: { main: { region: 'eu' } } },
        },
      },
      config: { blobStorage: { driver: 's3', bucket: 'b', region: 'us-east-1' } },
    });
    const health = kernel.health.find((h) => h.id === 'enterprise-compliance.residency')!;
    expect((await health.run(null)).status).toBe('critical');
    const cards = await kernel.cards
      .find((c) => c.id === 'enterprise-compliance.residency')!
      .cards(null);
    expect(cards[0]?.body).toContain('us-east-1');
    const cfg = kernel.config();
    await kernel.applyConfig({ ...cfg, blobStorage: { ...cfg.blobStorage, region: 'eu-west-1' } });
    expect((await health.run(null)).status).toBe('ok');
  });

  test('unknown regions are warnings', () => {
    const issues = checkResidency(
      parseConfig({ relays: [{ id: 'main', hosts: ['x'] }], blobStorage: { driver: 'r2' } }),
      ComplianceConfigSchema.parse({
        residency: { relays: { main: { region: 'eu' }, ghost: { region: 'eu' } } },
      }),
    );
    expect(issues.map((i) => i.severity)).toEqual(['warning', 'warning', 'warning']);
  });
});

describe('usage reports', () => {
  test('month helpers and CSV escaping', () => {
    expect(monthRange('2026-09')).toEqual({
      from: Date.UTC(2026, 8, 1) / 1000,
      to: Date.UTC(2026, 9, 1) / 1000,
    });
    expect(previousMonth(Date.UTC(2026, 0, 15) / 1000)).toBe('2025-12');
    expect(
      toCsv('2026-09', [
        { group: 'R&D, "core"', users: 2, events: 3, storageBytes: 4, uploadedBytes: 5 },
      ]),
    ).toBe(
      'month,group,users,events,storage_bytes,uploaded_bytes\n2026-09,"R&D, ""core""",2,3,4,5\n',
    );
    expect(
      toCsv('m', [{ group: '=cmd()', users: null, events: 0, storageBytes: 0, uploadedBytes: 0 }]),
    ).toContain('"=cmd()"');
  });

  test('PDF is structurally valid', () => {
    const pdf = new TextDecoder('latin1').decode(
      renderPdf({ title: 'T (1)', lines: ['a', 'b\\c'] }),
    );
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    expect(pdf).toContain('(T \\(1\\)) Tj');
  });

  test('per-group report with CSV + PDF stored and scheduled monthly', async () => {
    const { kernel, ports } = await makeKernel({
      extra: [
        defineModule({
          id: 'enterprise-identity',
          register(k) {
            k.provide('enterprise.identity', {
              members: async () => [
                { pubkey: 'a'.repeat(64), groups: ['finance'] },
                { pubkey: 'b'.repeat(64), groups: ['finance', 'eng'] },
              ],
            });
          },
        }),
      ],
    });
    const r = await runAction(kernel, 'compliance.usage-report', { month: '2023-11' }, alice);
    const rep = (
      r.output as {
        report: { rows: Array<{ group: string; users: number }>; csv: { sha256: string } };
      }
    ).report;
    expect(rep.rows.map((x) => [x.group, x.users])).toEqual([
      ['eng', 1],
      ['finance', 2],
    ]);
    const csv = new TextDecoder().decode(
      await collectStream((await ports.blobs.get(rep.csv.sha256))!.body),
    );
    expect(csv.split('\n')[0]).toBe('month,group,users,events,storage_bytes,uploaded_bytes');
    // Scheduler generates last month once.
    await ports.scheduler.tick('enterprise-compliance.reports');
    const month = previousMonth(ports.clock.now());
    expect(await ports.docs.get('compliance.reports', month)).not.toBeNull();
  });
});
