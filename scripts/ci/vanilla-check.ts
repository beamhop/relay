// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vanilla profile check for the built admin app (PLAN §12.0.6). Run after
 * `bun run build` in packages/pwa:
 *
 *   bun scripts/ci/vanilla-check.ts            # strings + budgets
 *   bun scripts/ci/vanilla-check.ts --list     # also print the scanned files
 *
 * 1. Enterprise strings: every JS/CSS file a vanilla admin can download (client
 *    entries, root layout, all non-company routes and their lazy chunks) is scanned
 *    for the enterprise vocabulary in `enterprise-terms.ts`. Enterprise code is
 *    allowed only in its own lazy chunks: `src/lib/modules/*` (fetched when `/ui`
 *    lists the module, i.e. it is enabled), the company components and the
 *    `/settings/company` route (reached only from the single entry point, §12.0.1).
 *    Unavoidable hits are listed in VANILLA_ALLOWLIST (enterprise-terms.ts), each with a
 *    reason; known leaks still to be fixed in KNOWN_LEAKS below.
 * 2. Budgets: home first load (gzip JS + CSS) within HOME_BUDGET_KB, every vanilla
 *    route within ROUTE_BUDGET_KB (reuses packages/pwa/scripts/bundle-size.ts).
 *
 * The binary side (no enterprise modules, actions, screens or config sections) is
 * `packages/runtime-bun/test/vanilla.test.ts`; the wizard snapshot is
 * `packages/pwa/e2e/vanilla.e2e.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_DIR,
  type Manifest,
  PWA_ROOT,
  firstLoad,
  kb,
  readManifest,
  routeNodes,
} from '../../packages/pwa/scripts/bundle-size.ts';
import {
  type AllowEntry,
  type TermHit,
  VANILLA_ALLOWLIST,
  findEnterpriseTerms,
} from './enterprise-terms.ts';

/** Gzip first-load budget for Home, the screen every admin opens first. */
const HOME_BUDGET_KB = Number(process.env.HOME_BUDGET_KB ?? 200);
/** Gzip first-load budget for any other vanilla route (~10% above the largest today). */
const ROUTE_BUDGET_KB = Number(process.env.ROUTE_BUDGET_KB ?? 255);

/** Source files whose chunks are enterprise-only (never downloaded by a vanilla admin). */
export const ENTERPRISE_SOURCES: RegExp[] = [
  /^src\/lib\/modules\//,
  /^src\/lib\/components\/company\//,
  /^src\/routes\/settings\/company\//,
];
/** Route ids that are enterprise-only. */
export const ENTERPRISE_ROUTES: RegExp[] = [/^\/settings\/company(\/|$)/];

/** Unavoidable hits (each with a reason) live in `enterprise-terms.ts`, shared with the e2e. */
const ALLOWLIST = VANILLA_ALLOWLIST;

/**
 * Known violations in packages/pwa, recorded when this check was introduced so CI starts
 * green and the list can only shrink (GAPS D4 follow-up, owned by the admin app). They are
 * printed as warnings; `VANILLA_STRICT=1` turns them into failures. Remove an entry as soon
 * as the leak is fixed; a stale entry is reported.
 */
export const KNOWN_LEAKS: AllowEntry[] = [];

export interface ScanResult {
  scanned: string[];
  excluded: string[];
  hits: Array<TermHit & { file: string }>;
  allowed: Array<TermHit & { file: string; reason: string }>;
  known: Array<TermHit & { file: string; reason: string }>;
  stale: AllowEntry[];
}

const matches = (list: AllowEntry[], hit: TermHit) =>
  list.find((a) => a.term === hit.term && a.context.test(hit.context));

/** Manifest keys of enterprise-only chunks: company routes and enterprise sources. */
export function enterpriseKeys(manifest: Manifest, routes: Record<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const [route, node] of Object.entries(routes)) {
    if (ENTERPRISE_ROUTES.some((r) => r.test(route))) keys.add(node);
  }
  for (const k of Object.keys(manifest)) {
    if (ENTERPRISE_SOURCES.some((r) => r.test(k))) keys.add(k);
  }
  return keys;
}

/** Every file (JS + CSS) a vanilla admin can download: static and lazy, minus enterprise. */
export function vanillaFiles(manifest: Manifest, skip: Set<string>): Set<string> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const walk = (key: string) => {
    if (seen.has(key) || skip.has(key)) return;
    seen.add(key);
    const c = manifest[key];
    if (!c) return;
    files.add(c.file);
    for (const css of c.css ?? []) files.add(css);
    for (const i of c.imports ?? []) walk(i);
    for (const i of c.dynamicImports ?? []) walk(i);
  };
  for (const [k, c] of Object.entries(manifest)) if (c.isEntry) walk(k);
  return files;
}

export function scan(root = PWA_ROOT): ScanResult {
  const manifest = readManifest(root);
  const routes = routeNodes(root);
  const skip = enterpriseKeys(manifest, routes);
  const files = vanillaFiles(manifest, skip);
  const excluded = [...skip].map((k) => manifest[k]?.file ?? k).filter((f) => !files.has(f));
  const hits: ScanResult['hits'] = [];
  const allowed: ScanResult['allowed'] = [];
  const known: ScanResult['known'] = [];
  const used = new Set<AllowEntry>();
  const client = join(root, '.svelte-kit/output/client');
  for (const file of [...files].sort()) {
    const text = readFileSync(join(client, file), 'utf8');
    for (const hit of findEnterpriseTerms(text)) {
      const allow = matches(ALLOWLIST, hit);
      const leak = allow ? undefined : matches(KNOWN_LEAKS, hit);
      if (allow) allowed.push({ ...hit, file, reason: allow.reason });
      else if (leak) known.push({ ...hit, file, reason: leak.reason });
      else hits.push({ ...hit, file });
      if (allow ?? leak) used.add((allow ?? leak) as AllowEntry);
    }
  }
  const stale = [...ALLOWLIST, ...KNOWN_LEAKS].filter((a) => !used.has(a));
  return { scanned: [...files].sort(), excluded, hits, allowed, known, stale };
}

if (import.meta.main) {
  if (!existsSync(join(CLIENT_DIR, '.vite/manifest.json'))) {
    console.error('vanilla-check: build the admin app first (cd packages/pwa && bun run build)');
    process.exit(2);
  }
  let failed = false;
  const result = scan();
  if (process.argv.includes('--list')) {
    for (const f of result.scanned) console.log(`  scan  ${f}`);
    for (const f of result.excluded) console.log(`  skip  ${f} (enterprise)`);
  }
  console.log(
    `enterprise strings: scanned ${result.scanned.length} vanilla files, skipped ${result.excluded.length} enterprise chunks`,
  );
  for (const a of result.allowed) {
    console.log(`  allowed "${a.match}" in ${a.file}: ${a.reason}`);
  }
  const strict = process.env.VANILLA_STRICT === '1';
  for (const k of result.known) {
    const line = `  known leak "${k.match}" in ${k.file}: ${k.reason}`;
    if (strict) console.error(line);
    else console.warn(line);
  }
  if (strict && result.known.length > 0) failed = true;
  for (const s of result.stale) {
    console.warn(`  stale list entry (no longer matches, remove it): ${s.term} ${s.context}`);
  }
  if (result.hits.length > 0) {
    failed = true;
    console.error(`  ${result.hits.length} enterprise string(s) in vanilla chunks:`);
    for (const h of result.hits) console.error(`    "${h.match}" in ${h.file}: …${h.context}…`);
    console.error(
      '  Move the code into a lazy enterprise chunk (src/lib/modules/*) or, if unavoidable, add a VANILLA_ALLOWLIST entry (scripts/ci/enterprise-terms.ts) with a reason.',
    );
  }

  const home = firstLoad('/');
  console.log(`budget: home ${kb(home.gzip)} KB gzip (limit ${HOME_BUDGET_KB} KB)`);
  if (home.gzip / 1024 > HOME_BUDGET_KB) {
    failed = true;
    console.error(`  home first load over budget: ${kb(home.gzip)} KB > ${HOME_BUDGET_KB} KB`);
  }
  for (const route of Object.keys(routeNodes())) {
    if (ENTERPRISE_ROUTES.some((r) => r.test(route))) continue;
    const r = firstLoad(route);
    if (r.gzip / 1024 > ROUTE_BUDGET_KB) {
      failed = true;
      console.error(`  ${route} first load over budget: ${kb(r.gzip)} KB > ${ROUTE_BUDGET_KB} KB`);
    }
  }
  console.log(failed ? 'vanilla-check: FAILED' : 'vanilla-check: ok');
  process.exit(failed ? 1 : 0);
}
