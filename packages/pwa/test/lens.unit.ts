// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type KV, Prefs } from '../src/lib/stores/prefs.svelte.ts';

function store(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('technical lens', () => {
  it('is off by default and persists when toggled', () => {
    const kv = store();
    const p = new Prefs(kv);
    expect(p.lens).toBe(false);
    expect(p.toggleLens()).toBe(true);
    expect(kv.data['beamhop.lens']).toBe('1');
    expect(new Prefs(kv).lens).toBe(true);
    p.setLens(false);
    expect(new Prefs(kv).lens).toBe(false);
  });

  it('survives missing or failing storage', () => {
    const p = new Prefs(null);
    expect(p.toggleLens()).toBe(true);
    const broken: KV = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const q = new Prefs(broken);
    expect(q.lens).toBe(false);
    expect(q.toggleLens()).toBe(true);
  });

  it('remembers the theme, dark first', () => {
    const kv = store();
    expect(new Prefs(kv).theme).toBe('dark');
    new Prefs(kv).setTheme('light');
    expect(new Prefs(kv).theme).toBe('light');
    expect(new Prefs(store({ 'beamhop.theme': 'bogus' })).theme).toBe('dark');
  });
});
