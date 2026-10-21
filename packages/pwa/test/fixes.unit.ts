// SPDX-License-Identifier: AGPL-3.0-or-later
/** Private-key sign-in, palette model, settings help keywords, checklist states, cards, quotas. */
import { bytesToHex } from '@noble/hashes/utils.js';
import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import type { CatalogAction, JsonSchema } from '../src/lib/api/types.ts';
import {
  decryptKey,
  encryptKey,
  localKeySigner,
  parseKeyInput,
} from '../src/lib/auth/local-key.ts';
import { nip98Template } from '../src/lib/auth/nip98.ts';
import { fromInbox } from '../src/lib/cards.ts';
import { fromServer } from '../src/lib/checklist.ts';
import { quotaOf } from '../src/lib/components/people/users.ts';
import { fieldsFromSchema, isVisible, matchesShowWhen } from '../src/lib/forms/json-schema.ts';
import { actionGroup, pushRecent, score, suggestions } from '../src/lib/palette.ts';

describe('private key sign-in', () => {
  const sk = generateSecretKey();

  it('recognises nsec, hex, ncryptsec and npub', async () => {
    const nsec = nip19.nsecEncode(sk);
    const a = await parseKeyInput(`  ${nsec}\n`);
    expect(a.kind).toBe('secret');
    expect(a.kind === 'secret' && bytesToHex(a.sk)).toBe(bytesToHex(sk));
    const b = await parseKeyInput(bytesToHex(sk).toUpperCase());
    expect(b.kind === 'secret' && bytesToHex(b.sk)).toBe(bytesToHex(sk));
    expect((await parseKeyInput(nip19.npubEncode(getPublicKey(sk)))).kind).toBe('public');
    expect((await parseKeyInput('nsec1notakey')).kind).toBe('invalid');
    expect((await parseKeyInput('hello')).kind).toBe('invalid');
  });

  it('round-trips NIP-49 ncryptsec and rejects a wrong password', async () => {
    const enc = await encryptKey(sk, 'correct horse', 4);
    expect(enc.startsWith('ncryptsec1')).toBe(true);
    const parsed = await parseKeyInput(enc);
    expect(parsed.kind).toBe('encrypted');
    expect(bytesToHex(await decryptKey(enc, 'correct horse'))).toBe(bytesToHex(sk));
    await expect(decryptKey(enc, 'wrong')).rejects.toThrow();
  });

  it('signs NIP-98 events locally', async () => {
    const signer = await localKeySigner(sk);
    expect(signer.via).toBe('local');
    expect(await signer.getPublicKey()).toBe(getPublicKey(sk));
    const ev = await signer.signEvent(nip98Template('https://r.example/api', 'POST', '{}'));
    expect(verifyEvent(ev as never)).toBe(true);
    await signer.close?.();
  });
});

describe('command palette', () => {
  it('groups actions by id prefix', () => {
    expect(actionGroup('moderation.ban-pubkey')).toBe('moderation');
    expect(actionGroup('plugins.install')).toBe('plugins');
    expect(actionGroup('enterprise.connect-idp')).toBe('company');
    expect(actionGroup('ai.moderation-labels')).toBe('assistant');
    expect(actionGroup('backups.run')).toBe('backups');
    expect(actionGroup('weird.thing')).toBe('other');
  });

  it('ranks label prefix over word start over keywords', () => {
    expect(score('goa', ['Goals'])).toBe(1);
    expect(score('goa', ['Your goals'])).toBe(0.8);
    expect(score('oal', ['Goals'])).toBe(0.6);
    expect(score('goa', ['Home', 'goals'])).toBe(0.4);
    expect(score('xyz', ['Home', 'dashboard'])).toBe(0);
    expect(score('', ['Anything'])).toBe(1);
  });

  it('keeps recents unique, newest first, capped', () => {
    let r: string[] = [];
    for (const k of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) r = pushRecent(k, r);
    expect(r).toEqual(['f', 'e', 'd', 'a', 'c']);
  });

  it('suggests only available entries that are not recent', () => {
    const avail = new Set(['page:/settings/goals', 'action:access.create-invite']);
    expect(suggestions(avail, ['page:/settings/goals'])).toEqual(['action:access.create-invite']);
  });
});

describe('settings help keywords', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['open', 'wot'],
        description: 'Who may post here',
        'x-enumLabels': { open: 'Anyone', wot: 'Web of trust' },
        'x-example': 'wot',
        'x-recommended': { value: 'wot', why: 'Less spam' },
        'x-technical': 'access.mode (NIP-42)',
      },
      depth: { type: 'integer', 'x-showWhen': { path: 'mode', equals: ['wot'] } },
      target: {
        type: 'object',
        properties: {
          driver: { type: 'string', enum: ['fs', 's3'] },
          bucket: { type: 'string', 'x-showWhen': { path: 'driver', equals: ['s3', 'r2'] } },
        },
      },
    },
  };
  const fields = fieldsFromSchema(schema);
  const mode = fields.find((f) => f.name === 'mode');
  const depth = fields.find((f) => f.name === 'depth');
  const bucket = fields
    .find((f) => f.name === 'target')
    ?.children?.find((f) => f.name === 'bucket');

  it('reads labels, example, recommendation and technical note', () => {
    expect(mode?.options).toEqual([
      { value: 'open', label: 'Anyone' },
      { value: 'wot', label: 'Web of trust' },
    ]);
    expect(mode?.example).toBe('wot');
    expect(mode?.recommended).toEqual({ value: 'wot', why: 'Less spam' });
    expect(mode?.technicalNote).toBe('access.mode (NIP-42)');
    expect(depth?.showWhen).toEqual({ path: 'mode', equals: ['wot'] });
  });

  it('hides fields whose condition does not hold (relative paths, lists of values)', () => {
    const values: Record<string, unknown> = { mode: 'open', 'target.driver': 'fs' };
    const lookup = (p: string[]) => values[p.join('.')];
    const all = [...fields, ...(fields.find((f) => f.name === 'target')?.children ?? [])];
    expect(isVisible(depth!, all, lookup)).toBe(false);
    expect(isVisible(bucket!, all, lookup)).toBe(false);
    values.mode = 'wot';
    values['target.driver'] = 's3';
    expect(isVisible(depth!, all, lookup)).toBe(true);
    expect(isVisible(bucket!, all, lookup)).toBe(true);
    // Unknown other setting: stay visible.
    expect(isVisible(depth!, all, () => undefined)).toBe(true);
    expect(matchesShowWhen(true, [true])).toBe(true);
    expect(matchesShowWhen(false, [true])).toBe(false);
  });
});

describe('checklist states', () => {
  it('maps in-progress and failed items with detail', () => {
    const items = fromServer({
      hidden: false,
      items: [
        {
          id: 'backups',
          title: 'Turn on backups',
          done: false,
          state: 'in-progress',
          detail: 'Waiting for the first backup',
          available: true,
          link: { screen: '/settings/backups' },
        },
        {
          id: 'test-relay',
          title: 'Test',
          done: false,
          state: 'failed',
          detail: 'Could not connect',
          available: true,
          link: { screen: '/', actionId: 'experience.test-relay' },
        },
        { id: 'x', title: 'Old server', done: true, available: true, link: { screen: '/' } },
      ],
    });
    expect(items.map((i) => i.state)).toEqual(['in-progress', 'failed', 'done']);
    expect(items[0]?.detail).toBe('Waiting for the first backup');
    expect(items[1]?.action?.id).toBe('experience.test-relay');
  });
});

describe('home cards', () => {
  const catalog = [
    { id: 'experience.approve-card', allowed: true },
    { id: 'moderation.ban-pubkey', allowed: true },
  ] as CatalogAction[];
  const base = {
    key: 'k',
    relayId: 'main',
    severity: 'info' as const,
    title: 't',
    body: 'b',
    count: 1,
    createdAt: 0,
  };

  it('offers approve only for approvable cards with a primary action', () => {
    const primary = { label: 'Block', actionId: 'moderation.ban-pubkey', inputs: [] };
    expect(fromInbox({ ...base, primary }, catalog).approve).toBeDefined();
    expect(fromInbox({ ...base, primary, approvable: false }, catalog).approve).toBeUndefined();
    expect(fromInbox(base, catalog).approve).toBeUndefined();
  });
});

describe('quotas', () => {
  const GB = 1024 ** 3;
  it('computes used / limit / left and over-quota', () => {
    expect(quotaOf({ usedBytes: 2 * GB, quotaBytes: 5 * GB })).toMatchObject({
      left: 3 * GB,
      over: false,
      fraction: 0.4,
    });
    expect(quotaOf({ storageBytes: 6 * GB, quotaBytes: 5 * GB })).toMatchObject({
      over: true,
      left: 0,
      fraction: 1,
    });
    expect(quotaOf({ storageBytes: 1, quotaBytes: null })).toBeNull();
  });
});
