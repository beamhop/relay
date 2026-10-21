// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings sections (§6.1, §6.6). The simple screens and their settings come
 * from ONE place: `simpleScreens` in @beamhop/experience (≤ 7 settings each,
 * enforced there and in this package's tests). This file only adds what the
 * app needs on top: the scope used for saving, an icon, and the "Advanced"
 * settings behind each screen.
 *
 * Paths: `relays[].x` means the current relay. Screens whose settings are all
 * relay settings save on the relay route (paths relative to the relay);
 * mixed screens save on the node route with `relays.{relay}.x`.
 */
import { type SimpleScreen, simpleScreens } from '$screens';

export const SIMPLE_BUDGET = 7;

export type SectionScope = 'relay' | 'node';

export interface SectionDef {
  id: string;
  scope: SectionScope;
  icon: string;
  /** Plain title from the shared definition (the app shows its own translated title when it has one). */
  title: string;
  simple: string[];
  advanced: string[];
}

const ICONS: Record<string, string> = {
  profile: 'info',
  access: 'lock',
  media: 'image',
  alerts: 'bell',
  backups: 'archive',
  domains: 'globe',
  privacy: 'shield',
  advanced: 'sliders',
};

/** Settings behind the "Advanced" sheet of each screen (shared-definition paths). */
const ADVANCED: Record<string, string[]> = {
  profile: ['relays[].info.pubkey'],
  access: [
    'relays[].access.wot.seeds',
    'relays[].access.wot.refreshMinutes',
    'relays[].defaultTier',
  ],
  media: [
    'relays[].blossom.maxBlobBytes',
    'relays[].blossom.defaultQuotaBytes',
    'relays[].blossom.allowedTypes',
    'relays[].blossom.optimize.resize',
    'relays[].blossom.optimize.transcode',
    'relays[].blossom.requireAuth',
    'relays[].blossom.scanning.lists',
  ],
  backups: [
    'backups.target.driver',
    'backups.target.bucket',
    'backups.target.endpoint',
    'backups.target.region',
    'backups.target.path',
  ],
  domains: ['relays[].pathPrefix'],
  privacy: ['ai.baseUrl', 'ai.model'],
  advanced: [
    'relays[].limits.maxSubscriptions',
    'relays[].limits.maxFilters',
    'relays[].limits.maxLimit',
    'relays[].limits.reqPerMinute',
    'relays[].limits.maxCreatedAtFutureSeconds',
    'relays[].limits.maxCreatedAtPastSeconds',
    'relays[].limits.allowedKinds',
  ],
};

/** Exact limits (overrides). Not a goal-driven simple screen, but kept within the same budget. */
const LIMITS_SCREEN: SimpleScreen = {
  id: 'advanced',
  title: 'Advanced limits',
  path: '/settings/advanced',
  settings: [
    'relays[].limits.maxEventBytes',
    'relays[].limits.eventsPerMinute',
    'relays[].limits.minPowDifficulty',
    'relays[].limits.newKeyPowDifficulty',
    'relays[].limits.blockedKinds',
  ],
};

const isRelayPath = (p: string) => p.startsWith('relays[].');

function toSection(s: SimpleScreen): SectionDef {
  const all = [...s.settings, ...(ADVANCED[s.id] ?? [])];
  const scope: SectionScope = all.every(isRelayPath) ? 'relay' : 'node';
  const map = (p: string) =>
    scope === 'relay' ? p.slice('relays[].'.length) : p.replace(/^relays\[\]\./, 'relays.{relay}.');
  return {
    id: s.id,
    scope,
    icon: ICONS[s.id] ?? 'sliders',
    title: s.title,
    simple: s.settings.map(map),
    advanced: (ADVANCED[s.id] ?? []).map(map),
  };
}

/** Generic screens (the goals screen has its own page with sliders). */
export const SECTIONS: SectionDef[] = [
  ...simpleScreens.filter((s) => s.id !== 'goals'),
  LIMITS_SCREEN,
].map(toSection);

/** Every simple screen, including goals, for the complexity-budget check. */
export const ALL_SIMPLE_SCREENS: readonly SimpleScreen[] = [...simpleScreens, LIMITS_SCREEN];

export function sectionById(id: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/** Expand `{relay}` placeholders and split into path segments. */
export function resolvePath(path: string, relayIndex: number): string[] {
  return path.replace('{relay}', String(relayIndex)).split('.');
}
