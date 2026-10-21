// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="bun" />
/**
 * First-load size of the built admin app (JS + CSS, gzip) for a route:
 * the client entries, the root layout and the route's page node, with all
 * their static imports. Dynamic imports (lazy chunks) are not counted.
 *
 *   bun scripts/bundle-size.ts            # Home ("/")
 *   bun scripts/bundle-size.ts /activity  # another route
 *   BUDGET_KB=200 bun scripts/bundle-size.ts   # exit 1 when over budget
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

interface Chunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
}

const root = join(import.meta.dir, '..');
const client = join(root, '.svelte-kit/output/client');
const manifest = JSON.parse(readFileSync(join(client, '.vite/manifest.json'), 'utf8')) as Record<
  string,
  Chunk
>;
const app = readFileSync(join(root, '.svelte-kit/generated/client-optimized/app.js'), 'utf8');

const route = process.argv[2] ?? '/';
const dict = app.match(/dictionary = \{([\s\S]*?)\};/)?.[1] ?? '';
const nodeMatch = dict.match(
  new RegExp(`"${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\s*\\[(?:\\d+,\\s*)*?(\\d+)\\]`),
);
if (!nodeMatch) throw new Error(`unknown route ${route}`);
const pageNode = `.svelte-kit/generated/client-optimized/nodes/${nodeMatch[1]}.js`;

const starts = [
  ...Object.keys(manifest).filter((k) => k.endsWith('/client/entry.js')),
  '.svelte-kit/generated/client-optimized/app.js',
  '.svelte-kit/generated/client-optimized/nodes/0.js',
  pageNode,
];

const files = new Set<string>();
const seen = new Set<string>();
const walk = (key: string) => {
  if (seen.has(key)) return;
  seen.add(key);
  const c = manifest[key];
  if (!c) throw new Error(`missing manifest entry ${key}`);
  files.add(c.file);
  for (const css of c.css ?? []) files.add(css);
  for (const i of c.imports ?? []) walk(i);
};
for (const s of starts) walk(s);

let raw = 0;
let gz = 0;
const rows: Array<[string, number]> = [];
for (const f of files) {
  const buf = readFileSync(join(client, f));
  const g = gzipSync(buf).length;
  raw += buf.length;
  gz += g;
  rows.push([f, g]);
}
rows.sort((a, b) => b[1] - a[1]);
const kb = (n: number) => (n / 1024).toFixed(1);
if (process.env.VERBOSE) for (const [f, g] of rows) console.log(`${kb(g).padStart(7)} KB  ${f}`);
console.log(
  `first load ${route}: ${files.size} files, ${kb(raw)} KB raw, ${kb(gz)} KB gzip (JS + CSS)`,
);
const budget = Number(process.env.BUDGET_KB ?? 0);
if (budget && gz / 1024 > budget) {
  console.error(`over budget: ${kb(gz)} KB > ${budget} KB`);
  process.exit(1);
}
