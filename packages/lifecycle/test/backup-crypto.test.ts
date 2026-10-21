// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { type KeyWrapper, type Ports, parseConfig } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import {
  ARCHIVE_TYPE,
  ARCHIVE_TYPE_ENCRYPTED,
  type BackupRecord,
  MASK,
  gunzip,
  isEncryptedArchive,
  maskSecrets,
  tarUnpack,
} from '../src/index.ts';
import { cleanupAll, setup } from './helpers.ts';

afterEach(cleanupAll);

/** Toy KeyWrapper: XOR with a fixed pad (tests only). */
function xorWrapper(pad = 0x5a): KeyWrapper {
  const x = async (b: Uint8Array) => b.map((v) => v ^ pad);
  return { provider: 'test-kms', wrap: x, unwrap: x };
}

async function withSecrets(t: Awaited<ReturnType<typeof setup>>) {
  const cfg = t.kernel.config();
  await t.kernel.applyConfig(
    parseConfig({
      ...cfg,
      storage: { driver: 'sqlite', url: 'postgres://beamhop:hunter2@db.internal/beamhop' },
      modules: {
        ...cfg.modules,
        ai: { endpoint: 'https://llm.example', apiKey: 'sk-live-123' },
        insights: { token: 'metrics-token-9' },
      },
    }),
  );
}

async function archiveConfig(t: Awaited<ReturnType<typeof setup>>, bytes: Uint8Array) {
  const files = tarUnpack(await gunzip(bytes));
  const f = files.find((e) => e.name === 'config/config.json');
  return new TextDecoder().decode(f?.data);
}

async function stored(t: Awaited<ReturnType<typeof setup>>) {
  const [rec] = (await t.svc.backups.catalog()) as BackupRecord[];
  const body = await t.target?.get(rec?.sha256 as string);
  const bytes = new Uint8Array(await new Response(body?.body).arrayBuffer());
  return { rec: rec as BackupRecord, bytes };
}

describe('backup secrets', () => {
  test('maskSecrets masks secret-looking keys and URL passwords only', () => {
    expect(
      maskSecrets({
        a: { secretAccessKey: 'S', accessKeyId: 'AK', bucket: 'b', password: '' },
        url: 'postgres://u:p@h/db',
        plain: 'https://example.com/x',
        list: [{ apiKey: 'k' }],
        n: 3,
      }),
    ).toEqual({
      a: { secretAccessKey: MASK, accessKeyId: MASK, bucket: 'b', password: '' },
      url: `postgres://u:${MASK}@h/db`,
      plain: 'https://example.com/x',
      list: [{ apiKey: MASK }],
      n: 3,
    });
  });

  test('without a key service: config secrets are masked unless includeSecrets', async () => {
    const t = await setup({ backups: { enabled: true } });
    await withSecrets(t);
    await t.svc.backups.run('manual');
    const { rec, bytes } = await stored(t);
    expect(rec.encrypted).toBeUndefined();
    expect(rec.secrets).toBe('masked');
    expect(await t.target?.head(rec.sha256)).toMatchObject({ type: ARCHIVE_TYPE });
    const cfg = await archiveConfig(t, bytes);
    for (const s of ['hunter2', 'sk-live-123', 'metrics-token-9']) expect(cfg).not.toContain(s);
    expect(cfg).toContain(MASK);
    expect(cfg).toContain('https://llm.example');

    const opted = await setup({
      backups: { enabled: true },
      lifecycle: { backups: { includeSecrets: true } },
    });
    await withSecrets(opted);
    await opted.svc.backups.run('manual');
    const o = await stored(opted);
    expect(o.rec.secrets).toBe('included');
    expect(await archiveConfig(opted, o.bytes)).toContain('sk-live-123');
  });

  test('with ports.keyWrapper: archives are AES-GCM sealed, verifiable and restorable', async () => {
    const t = await setup({ backups: { enabled: true } });
    (t.ports as Ports).keyWrapper = xorWrapper();
    await withSecrets(t);
    const k = makeKey();
    const e = t.ev(k);
    await t.ports.events.save('main', e);
    const last = await t.svc.backups.run('manual');
    expect(last.ok).toBe(true);
    const { rec, bytes } = await stored(t);
    expect(rec.encrypted).toBe(true);
    expect(rec.secrets).toBe('included');
    expect(isEncryptedArchive(bytes)).toBe(true);
    expect(await t.target?.head(rec.sha256)).toMatchObject({ type: ARCHIVE_TYPE_ENCRYPTED });
    expect(new TextDecoder().decode(bytes)).not.toContain('sk-live-123');
    await expect(gunzip(bytes)).rejects.toThrow();
    expect(await t.svc.backups.verify(rec.id)).toMatchObject({ ok: true });

    await t.ports.events.deleteByIds('main', [e.id]);
    await t.svc.backups.restore(rec.id);
    expect(await t.ports.events.getById('main', e.id)).not.toBeNull();

    // Wrong key → unreadable; no key service → explains why.
    (t.ports as Ports).keyWrapper = xorWrapper(0x33);
    const wrong = await t.svc.backups.verify(rec.id);
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(' ')).toContain('could not be decrypted');
    (t.ports as Ports).keyWrapper = undefined;
    const none = await t.svc.backups.verify(rec.id);
    expect(none.problems.join(' ')).toContain('This backup is encrypted');
  });
});
