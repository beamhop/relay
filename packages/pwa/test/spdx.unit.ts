// SPDX-License-Identifier: AGPL-3.0-or-later
/** Every admin-app source file starts with the AGPL SPDX header (§17). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const TS = '// SPDX-License-Identifier: AGPL-3.0-or-later';
const HTML = '<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->';
const SKIP = new Set(['paraglide', 'node_modules', 'build', '.svelte-kit']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|svelte)$/.test(name) || name === 'app.html') out.push(p);
  }
  return out;
}

function sourceFiles(): string[] {
  const files = ['src', 'e2e', 'test', 'scripts'].flatMap((d) => walk(join(root, d)));
  for (const name of readdirSync(root))
    if (/\.(ts|js)$/.test(name) && statSync(join(root, name)).isFile())
      files.push(join(root, name));
  return files;
}

describe('license headers', () => {
  it('every source file starts with the SPDX identifier', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const missing = files
      .filter((f) => {
        const first = readFileSync(f, 'utf8').split('\n', 1)[0]?.trim();
        return first !== (/\.(svelte|html)$/.test(f) ? HTML : TS);
      })
      .map((f) => relative(root, f));
    expect(missing).toEqual([]);
  });
});
