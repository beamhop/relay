// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Command palette model (§6.13): action groups (by action id prefix), the
 * "Recent" list kept on this device, "Suggested" entries, and a predictable
 * ranking (label prefix > word start > substring > keyword).
 */

export type GroupId =
  | 'home'
  | 'moderation'
  | 'people'
  | 'media'
  | 'settings'
  | 'alerts'
  | 'backups'
  | 'plugins'
  | 'company'
  | 'assistant'
  | 'insights'
  | 'security'
  | 'history'
  | 'other';

/** Action id prefix → group. */
const PREFIX: Record<string, GroupId> = {
  experience: 'home',
  moderation: 'moderation',
  users: 'people',
  access: 'people',
  admins: 'people',
  notes: 'people',
  media: 'media',
  blossom: 'media',
  config: 'settings',
  policy: 'settings',
  relays: 'settings',
  alerts: 'alerts',
  backups: 'backups',
  lifecycle: 'backups',
  plugins: 'plugins',
  enterprise: 'company',
  modules: 'company',
  ai: 'assistant',
  insights: 'insights',
  tokens: 'security',
  auth: 'security',
  history: 'history',
  revisions: 'history',
};

/** Order of action groups in the palette. */
export const GROUP_ORDER: GroupId[] = [
  'home',
  'moderation',
  'people',
  'media',
  'settings',
  'alerts',
  'backups',
  'plugins',
  'company',
  'assistant',
  'insights',
  'security',
  'history',
  'other',
];

export function actionGroup(actionId: string): GroupId {
  return PREFIX[actionId.split('.')[0] ?? ''] ?? 'other';
}

/** Rank an entry for a search (0 = hidden). `keywords[0]` is the visible label. */
export function score(search: string, keywords: readonly string[] = []): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const label = (keywords[0] ?? '').toLowerCase();
  if (label.startsWith(q)) return 1;
  if (label.split(/[\s›/·-]+/).some((w) => w.startsWith(q))) return 0.8;
  if (label.includes(q)) return 0.6;
  const rest = keywords.slice(1).map((k) => k.toLowerCase());
  if (rest.some((k) => k.startsWith(q))) return 0.4;
  if (rest.some((k) => k.includes(q))) return 0.3;
  return 0;
}

const RECENT_KEY = 'beamhop.palette.recent';
export const RECENT_MAX = 5;

/** Entry keys used most recently (newest first). */
export function recentKeys(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function pushRecent(key: string, list = recentKeys()): string[] {
  const next = [key, ...list.filter((k) => k !== key)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: recents last for this page only
  }
  return next;
}

/** Suggested entries (shown when they exist and are not already recent). */
export const SUGGESTED = [
  'page:/activity?tab=queue',
  'action:access.create-invite',
  'action:experience.test-relay',
  'page:/settings/goals',
  'action:moderation.ban-pubkey',
] as const;

export function suggestions(
  available: ReadonlySet<string>,
  recent: readonly string[],
  max = 4,
): string[] {
  return SUGGESTED.filter((k) => available.has(k) && !recent.includes(k)).slice(0, max);
}
