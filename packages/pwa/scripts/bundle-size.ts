// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="bun" />
/**
 * First-load size of the built admin app (JS + CSS, gzip) for a route:
 * the client entries, the root layout and the route's page node, with all
 * their static imports. Dynamic imports (lazy chunks) are not counted.
 *
 *   bun scripts/bundle-size.ts            # Home ("/")
 *   bun scripts/bundle-size.ts /activity  # another route
 *   bun scripts/bundle-size.ts --all      # every route, largest first
 *   BUDGET_KB=200 bun scripts/bundle-size.ts   # exit 1 when over budget
 *
 * Also imported by `scripts/ci/vanilla-check.ts` (PLAN §12.0.6), which reuses the
 * manifest helpers below.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface Chunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

export type Manifest = Record<string, Chunk>;

export const PWA_ROOT = join(import.meta.dir, '..');
export const CLIENT_DIR = join(PWA_ROOT, '.svelte-kit/output/client');
export const NODES_PREFIX = '.svelte-kit/generated/client-optimized/nodes/';
export const APP_KEY = '.svelte-kit/generated/client-optimized/app.js';

export function readManifest(root = PWA_ROOT): Manifest {
  return JSON.parse(
    readFileSync(join(root, '.svelte-kit/output/client/.vite/manifest.json'), 'utf8'),
  ) as Manifest;
}

/** Route id → page node manifest key (from SvelteKit's generated client dictionary). */
export function routeNodes(root = PWA_ROOT): Record<string, string> {
  const app = readFileSync(join(root, APP_KEY), 'utf8');
  const dict = app.match(/dictionary = \{([\s\S]*?)\};/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of dict.matchAll(/"([^"]+)":\s*\[(?:-?\d+,\s*)*?(-?\d+)\]/g)) {
    out[m[1] as string] = `${NODES_PREFIX}${m[2]}.js`;
  }
  return out;
}

/** Manifest keys every page loads up front: client entries, app, root layout and error page. */
export function entryKeys(manifest: Manifest): string[] {
  return [
    ...Object.keys(manifest).filter((k) => k.endsWith('/client/entry.js')),
    APP_KEY,
    `${NODES_PREFIX}0.js`,
  ];
}

/** Files (JS + CSS) statically reachable from `starts`. */
export function staticClosure(manifest: Manifest, starts: string[]): Set<string> {
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
  return files;
}

export interface FirstLoad {
  route: string;
  files: Set<string>;
  raw: number;
  gzip: number;
  rows: Array<[string, number]>;
}

export function firstLoad(route: string, root = PWA_ROOT): FirstLoad {
  const manifest = readManifest(root);
  const node = routeNodes(root)[route];
  if (!node) throw new Error(`unknown route ${route}`);
  const files = staticClosure(manifest, [...entryKeys(manifest), node]);
  let raw = 0;
  let gzip = 0;
  const rows: Array<[string, number]> = [];
  for (const f of files) {
    const buf = readFileSync(join(root, '.svelte-kit/output/client', f));
    const g = gzipSync(buf).length;
    raw += buf.length;
    gzip += g;
    rows.push([f, g]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  return { route, files, raw, gzip, rows };
}

export const kb = (n: number) => (n / 1024).toFixed(1);

if (import.meta.main) {
  const arg = process.argv[2] ?? '/';
  const routes = arg === '--all' ? Object.keys(routeNodes()) : [arg];
  const results = routes.map((r) => firstLoad(r)).sort((a, b) => b.gzip - a.gzip);
  const budget = Number(process.env.BUDGET_KB ?? 0);
  let over = false;
  for (const r of results) {
    if (process.env.VERBOSE)
      for (const [f, g] of r.rows) console.log(`${kb(g).padStart(7)} KB  ${f}`);
    console.log(
      `first load ${r.route}: ${r.files.size} files, ${kb(r.raw)} KB raw, ${kb(r.gzip)} KB gzip (JS + CSS)`,
    );
    if (budget && r.gzip / 1024 > budget) {
      console.error(`over budget: ${r.route} ${kb(r.gzip)} KB > ${budget} KB`);
      over = true;
    }
  }
  if (over) process.exit(1);
}
