// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * First-party plugins compiled into Beamhop. Exported as a record (not as
 * top-level values) so module scanners never mistake them for always-on modules.
 */
import { type Catalog, CatalogSchema } from '../catalog/index.ts';
import type { DefinitionLike } from '../sdk/index.ts';
import catalogJson from './catalog.json' with { type: 'json' };
import { keywordFilterPlugin } from './keyword-filter.ts';
import { kindAllowlistPlugin } from './kind-allowlist.ts';
import { nip05RequiredPlugin } from './nip05-required.ts';
import { rateLimitBurstPlugin } from './rate-limit-burst.ts';
import { wotStrictPlugin } from './wot-strict.ts';

export const BUILTIN_PLUGINS: Readonly<Record<string, DefinitionLike>> = Object.freeze({
  'wot-strict': wotStrictPlugin,
  'keyword-filter': keywordFilterPlugin,
  'kind-allowlist': kindAllowlistPlugin,
  'rate-limit-burst': rateLimitBurstPlugin,
  'nip05-required': nip05RequiredPlugin,
});

/** The local, built-in catalog (no signature needed: it ships inside the binary). */
export const BUILTIN_CATALOG: Catalog = CatalogSchema.parse(catalogJson);

export {
  keywordFilterPlugin,
  kindAllowlistPlugin,
  nip05RequiredPlugin,
  rateLimitBurstPlugin,
  wotStrictPlugin,
};
export { buildTrustSet } from './wot-strict.ts';
export { parseNip05, verifyNip05 } from './nip05-required.ts';
