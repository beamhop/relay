// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatValue,
  humanizeKey,
  isPersonKey,
  itemTitle,
  relTime,
  titleKey,
} from '../src/lib/output.ts';

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const PK = 'b'.repeat(64);
const names = { label: (pk: string) => (pk === PK ? 'Bob' : 'someone') };
const text = (key: string | undefined, v: unknown) => formatValue(key, v, names, NOW).text;

describe('output keys', () => {
  it('uses plain labels for known keys and humanizes the rest', () => {
    expect(humanizeKey('pubkey')).toBe('Person');
    expect(humanizeKey('usedBytes')).toBe('Storage used');
    expect(humanizeKey('maxEventBytes')).toBe('Max event bytes');
    expect(humanizeKey('retention_days')).toBe('Retention days');
    expect(humanizeKey('HTTPStatus')).toBe('Http status');
  });

  it('recognises fields that hold people', () => {
    for (const k of ['pubkey', 'pubkeys', 'author', 'reporter', 'by', 'ownerPubkey'])
      expect(isPersonKey(k)).toBe(true);
    expect(isPersonKey('sha256')).toBe(false);
    expect(isPersonKey(undefined)).toBe(false);
  });
});

describe('output values', () => {
  it('booleans are Yes/No, empties are a dash', () => {
    expect(text('banned', true)).toBe('Yes');
    expect(text('banned', false)).toBe('No');
    expect(text('x', null)).toBe('—');
    expect(text('x', '')).toBe('—');
    expect(text('x', Number.NaN)).toBe('—');
  });

  it('numbers: bytes, times, durations, days, plain', () => {
    expect(text('usedBytes', 1536)).toBe('1.5 KB');
    expect(text('size', 5 * 1024 * 1024)).toBe('5 MB');
    expect(text('createdAt', NOW / 1000 - 7200)).toBe('2h ago');
    expect(text('expiresAt', NOW + 3 * 86_400_000)).toBe('in 3d');
    expect(text('latencyMs', 250)).toBe('250 ms');
    expect(text('ttlSeconds', 90)).toBe('1.5 min');
    expect(text('retentionDays', 30)).toBe('30 days');
    expect(text('count', 1234567)).toBe('1,234,567');
  });

  it('pubkeys become names, other hex becomes a short id with the full value kept', () => {
    expect(formatValue('pubkey', PK, names, NOW)).toEqual({
      kind: 'person',
      pubkey: PK,
      text: 'Bob',
    });
    const id = formatValue('sha256', 'c'.repeat(64), names, NOW);
    expect(id).toEqual({ kind: 'id', full: 'c'.repeat(64), text: 'cccccc…cccc' });
    expect(id.text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('ISO dates are relative; plain strings pass through', () => {
    expect(text('when', new Date(NOW - 45 * 60_000).toISOString())).toBe('45m ago');
    expect(text('reason', 'spam')).toBe('spam');
  });

  it('durations and relative time helpers', () => {
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(2 * 3_600_000)).toBe('2 h');
    expect(relTime(NOW + 30_000, NOW)).toBe('in 30s');
  });

  it('list item titles prefer names, then the person', () => {
    expect(itemTitle({ displayName: 'Ana', pubkey: PK }, names)).toBe('Ana');
    expect(titleKey({ displayName: 'Ana' })).toBe('displayName');
    expect(itemTitle({ pubkey: PK }, names)).toBe('Bob');
    expect(itemTitle({ size: 3 }, names)).toBe('');
  });
});
