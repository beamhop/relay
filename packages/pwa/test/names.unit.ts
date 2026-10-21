// SPDX-License-Identifier: AGPL-3.0-or-later
import { npubEncode as reference } from 'nostr-tools/nip19';
import { describe, expect, it, vi } from 'vitest';
import { npubEncode, npubShort, shortHex } from '../src/lib/npub.ts';
import { Names } from '../src/lib/stores/names.svelte.ts';

const A = 'a'.repeat(64);
const B = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const C = 'f'.repeat(64);

describe('npub encoding', () => {
  it('matches nostr-tools nip19.npubEncode', () => {
    for (const hex of [A, B, C, '0'.repeat(64)]) expect(npubEncode(hex)).toBe(reference(hex));
  });

  it('rejects anything that is not a 64-char hex key', () => {
    expect(npubEncode('abc')).toBeUndefined();
    expect(npubEncode('z'.repeat(64))).toBeUndefined();
  });

  it('short forms', () => {
    const s = npubShort(B);
    expect(s).toMatch(/^npub1[a-z0-9]{4}…[a-z0-9]{4}$/);
    expect(s.endsWith(reference(B).slice(-4))).toBe(true);
    expect(npubShort(reference(B))).toBe(s);
    expect(shortHex(B)).toBe('3bf0c6…459d');
  });
});

describe('name resolver', () => {
  it('labels known people by name and others by short npub, never bare hex', () => {
    const n = new Names(async () => []);
    n.remember(B, 'Alice');
    expect(n.label(B)).toBe('Alice');
    expect(n.label(B.toUpperCase())).toBe('Alice');
    expect(n.label(A)).toMatch(/^npub1.{4}….{4}$/);
    expect(n.label(A)).not.toContain(A);
    expect(n.label(undefined)).toBe('');
  });

  it('ignores names that are just keys', () => {
    const n = new Names(async () => []);
    n.remember(A, A);
    n.remember(A, 'npub1xyz');
    n.remember(A, '   ');
    n.remember('nothex', 'Bob');
    expect(n.nameOf(A)).toBeUndefined();
    expect(n.nameOf('nothex')).toBeUndefined();
  });

  it('takes names from list rows (displayName, name, display_name)', () => {
    const n = new Names(async () => []);
    n.rememberRows([
      { pubkey: A, displayName: 'Ana' },
      { pubkey: B, name: 'Bea' },
      { pubkey: C, display_name: 'Cy' },
      null,
      'junk',
    ]);
    expect([n.label(A), n.label(B), n.label(C)]).toEqual(['Ana', 'Bea', 'Cy']);
  });

  it('cleans hex out of free text', () => {
    const n = new Names(async () => []);
    n.remember(B, 'Alice');
    expect(n.text(`Blocked ${B} after reports`)).toBe('Blocked Alice after reports');
    expect(n.text(`File ${A} removed`)).toBe('File aaaaaa…aaaa removed');
    expect(n.text(`by ${reference(C)}`)).toBe(`by ${npubShort(C)}`);
    expect(n.text(undefined)).toBe('');
  });

  it('loads once per relay and survives loader failures', async () => {
    const loader = vi.fn(async (relay: string | null) => {
      if (relay === 'bad') throw new Error('offline');
      return [{ pubkey: A, displayName: 'Owner' }];
    });
    const n = new Names(loader);
    await Promise.all([n.ensure('r1'), n.ensure('r1')]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(n.label(A)).toBe('Owner');
    await n.ensure('bad');
    expect(loader).toHaveBeenCalledTimes(2);
    n.reset();
    await n.ensure('r1');
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
