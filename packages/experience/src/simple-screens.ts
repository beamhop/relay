// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Complexity budget (§6.6): "≤ 7 settings per simple screen". This is the
 * single definition of which config paths each *simple* Settings screen shows
 * (PLAN §6.1 Settings tab + §6.7 goals); the PWA imports it to build those
 * screens, and `checkComplexityBudget` fails the build when a screen grows
 * past the budget or points at a setting that does not exist.
 *
 * Paths are dotted config paths. `relays[]` means "the current relay".
 */
import { ConfigSchema } from '@beamhop/core';
import { z } from 'zod';

export const SIMPLE_SCREEN_BUDGET = 7;

export interface SimpleScreen {
  id: string;
  /** Plain title in the Settings list. */
  title: string;
  /** PWA route. */
  path: string;
  /** Config paths shown on the simple view, in display order. Everything else lives in Advanced. */
  settings: string[];
}

export const simpleScreens: readonly SimpleScreen[] = [
  {
    id: 'goals',
    title: 'What kind of relay is this?',
    path: '/settings/goals',
    settings: [
      'relays[].persona',
      'relays[].goals.openness',
      'relays[].goals.spamTolerance',
      'relays[].goals.storage',
      'relays[].goals.media',
      'relays[].goals.speedVsCost',
    ],
  },
  {
    id: 'access',
    title: 'Who can post and read',
    path: '/settings/access',
    settings: [
      'relays[].access.mode',
      'relays[].access.authRequired.write',
      'relays[].access.authRequired.read',
      'relays[].access.wot.depth',
      'relays[].access.wot.minFollowers',
    ],
  },
  {
    id: 'profile',
    title: 'Name and landing page',
    path: '/settings/profile',
    settings: [
      'relays[].info.name',
      'relays[].info.description',
      'relays[].info.icon',
      'relays[].info.banner',
      'relays[].info.contact',
      'relays[].info.rules',
      'relays[].public.landing',
    ],
  },
  {
    id: 'media',
    title: 'Media hosting',
    path: '/settings/media',
    settings: [
      'relays[].blossom.enabled',
      'relays[].blossom.mirror',
      'relays[].blossom.optimize.stripMetadata',
      'relays[].blossom.optimize.thumbnails',
      'relays[].blossom.scanning.enabled',
    ],
  },
  {
    id: 'ai',
    title: 'AI assistant',
    path: '/settings/ai',
    settings: ['ai.enabled', 'ai.baseUrl', 'ai.model', 'ai.apiKey'],
  },
  {
    id: 'alerts',
    title: 'Alerts',
    path: '/settings/alerts',
    settings: ['alerts.channels', 'alerts.digest'],
  },
  {
    id: 'backups',
    title: 'Backups',
    path: '/settings/backups',
    settings: ['backups.enabled', 'backups.schedule', 'backups.keep'],
  },
  {
    id: 'domains',
    title: 'Domains and security',
    path: '/settings/domains',
    settings: ['relays[].hosts', 'node.tls.mode', 'node.tls.email', 'node.trustProxy'],
  },
  {
    id: 'privacy',
    title: 'Privacy and public pages',
    path: '/settings/privacy',
    settings: ['privacy.ipLogging', 'relays[].public.portal', 'relays[].public.status'],
  },
];

export interface BudgetViolation {
  screen: string;
  problem: 'over-budget' | 'unknown-setting' | 'duplicate-setting';
  detail: string;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

let cachedSchema: JsonSchema | undefined;
function configJsonSchema(): JsonSchema {
  cachedSchema ??= z.toJSONSchema(ConfigSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  return cachedSchema;
}

/** Does `path` exist in the config JSON Schema? */
export function hasConfigPath(path: string, schema: JsonSchema = configJsonSchema()): boolean {
  let cur: JsonSchema | undefined = schema;
  for (const raw of path.split('.')) {
    if (!cur) return false;
    const isArray = raw.endsWith('[]');
    const name = isArray ? raw.slice(0, -2) : raw;
    const candidates: JsonSchema[] = [cur, ...(cur.anyOf ?? []), ...(cur.oneOf ?? [])];
    const holder: JsonSchema | undefined = candidates.find((c) => c.properties?.[name]);
    let next: JsonSchema | undefined = holder?.properties?.[name];
    if (!next) return false;
    if (isArray) {
      const arr: JsonSchema | undefined = [next, ...(next.anyOf ?? [])].find((c) => c.items);
      next = arr?.items;
      if (!next) return false;
    }
    cur = next;
  }
  return true;
}

/** Inspect screens against the budget and the config schema. Empty array = all good. */
export function checkComplexityBudget(
  screens: readonly SimpleScreen[] = simpleScreens,
  budget = SIMPLE_SCREEN_BUDGET,
): BudgetViolation[] {
  const out: BudgetViolation[] = [];
  for (const s of screens) {
    if (s.settings.length > budget)
      out.push({
        screen: s.id,
        problem: 'over-budget',
        detail: `${s.settings.length} settings (max ${budget}) — move some to Advanced or derive them from a goal`,
      });
    const seen = new Set<string>();
    for (const p of s.settings) {
      if (seen.has(p))
        out.push({ screen: s.id, problem: 'duplicate-setting', detail: `${p} appears twice` });
      seen.add(p);
      if (!hasConfigPath(p))
        out.push({
          screen: s.id,
          problem: 'unknown-setting',
          detail: `${p} is not in the config schema`,
        });
    }
  }
  return out;
}

/** Throw with a readable message when the budget is broken (for tests / CI). */
export function assertComplexityBudget(
  screens: readonly SimpleScreen[] = simpleScreens,
  budget = SIMPLE_SCREEN_BUDGET,
): void {
  const v = checkComplexityBudget(screens, budget);
  if (v.length)
    throw new Error(
      `Complexity budget broken:\n${v.map((x) => `  - ${x.screen}: ${x.detail}`).join('\n')}`,
    );
}
