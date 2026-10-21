// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Screen links that come from the server (setup checklist, "Why?" options,
 * assistant answers, module routes) name screens by path. Map them onto the
 * screens this app has; anything unknown lands on the nearest tab, and the
 * caller tells the admin with a toast instead of showing a dead end.
 */

/** The five tabs (§6.1). */
export const TABS = ['/', '/activity', '/people', '/media', '/settings'] as const;
export type Tab = (typeof TABS)[number];

/** Screens that live elsewhere in this app (or under another name). */
const ALIASES: Record<string, string> = {
  '/home': '/',
  '/home/launch-kit': '/',
  '/insights': '/',
  '/people/admins': '/people?tab=team',
  '/people/team': '/people?tab=team',
  '/people/users': '/people?tab=users',
  '/people/invites': '/people?tab=invites',
  '/people/access': '/people?tab=access',
  '/people/wot': '/people?tab=access',
  '/activity/stream': '/activity?tab=stream',
  '/activity/queue': '/activity?tab=queue',
  '/activity/moderation': '/activity?tab=queue',
  '/activity/reports': '/activity?tab=queue',
  '/activity/bin': '/activity?tab=bin',
  '/activity/recycle-bin': '/activity?tab=bin',
  '/activity/feed': '/activity?tab=feed',
  '/activity/team': '/activity?tab=feed',
  '/activity/alerts': '/activity?tab=alerts',
  '/settings/ai': '/settings/privacy',
  '/settings/assistant': '/settings/privacy',
  '/settings/limits': '/settings/advanced',
  '/settings/revisions': '/settings/history',
  '/settings/time-machine': '/settings/history',
  '/settings/recovery': '/settings/security',
};

/**
 * Settings section ids rendered by `/settings/[section]` (kept here, not
 * imported from `settings/sections.ts`, so Home does not load the config
 * schema stack; a unit test keeps both lists equal).
 */
export const SETTINGS_SECTIONS = [
  'access',
  'profile',
  'media',
  'alerts',
  'backups',
  'domains',
  'privacy',
  'advanced',
] as const;

/** Fixed screens (besides the tabs). */
const FIXED = new Set([
  '/help',
  '/settings/goals',
  '/settings/history',
  '/settings/plugins',
  '/settings/security',
]);

export interface ResolvedScreen {
  /** App-internal path (without the `/admin` base). */
  href: string;
  /** True when the screen is unknown and `href` is the nearest tab instead. */
  fallback: boolean;
  /** The tab the screen belongs to. */
  tab: Tab;
}

/** The tab a path belongs to (first segment), Home when nothing matches. */
export function nearestTab(path: string): Tab {
  const seg = `/${path.replace(/^\/+/, '').split(/[/?#]/)[0] ?? ''}`;
  return (TABS as readonly string[]).includes(seg) ? (seg as Tab) : '/';
}

/**
 * Resolve a server-provided screen path. `modules` are the `/ui` module
 * paths (served under `/m/...`); `sections` the settings section ids.
 */
export function resolveScreen(
  screen: string | null | undefined,
  modules: readonly string[] = [],
  sections: readonly string[] = SETTINGS_SECTIONS,
): ResolvedScreen {
  const raw = (screen ?? '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//'))
    return { href: '/settings', fallback: !!raw, tab: '/settings' };
  const [pathPart = '/', query = ''] = raw.split('?', 2);
  const path = pathPart.length > 1 ? pathPart.replace(/\/+$/, '') : pathPart;
  const withQuery = (p: string) => (query && !p.includes('?') ? `${p}?${query}` : p);

  const alias = ALIASES[path];
  if (alias) return { href: withQuery(alias), fallback: false, tab: nearestTab(alias) };
  if ((TABS as readonly string[]).includes(path) || FIXED.has(path))
    return { href: withQuery(path), fallback: false, tab: nearestTab(path) };
  const section = path.match(/^\/settings\/([a-z0-9-]+)$/)?.[1];
  if (section && sections.includes(section))
    return { href: withQuery(path), fallback: false, tab: '/settings' };
  if (path.startsWith('/m/') && modules.includes(path.slice(2)))
    return { href: withQuery(path), fallback: false, tab: nearestTab(path) };
  const tab = nearestTab(path);
  return { href: tab, fallback: true, tab };
}
