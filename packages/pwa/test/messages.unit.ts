// SPDX-License-Identifier: AGPL-3.0-or-later
/** All UI strings are externalized: every `m.key()` used in the app exists in messages/en.json. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const messages = JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8')) as Record<
  string,
  string
>;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'paraglide') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(svelte|ts)$/.test(name)) out.push(p);
  }
  return out;
}

describe('messages', () => {
  const used = new Set<string>();
  for (const f of walk(join(root, 'src'))) {
    for (const match of readFileSync(f, 'utf8').matchAll(/\bm\.([a-z0-9_]+)\(/g))
      used.add(match[1] as string);
  }

  it('every used message key exists', () => {
    const missing = [...used].filter((k) => !(k in messages));
    expect(missing).toEqual([]);
  });

  it('has no unused message keys', () => {
    const unused = Object.keys(messages).filter((k) => !k.startsWith('$') && !used.has(k));
    expect(unused).toEqual([]);
  });
});
