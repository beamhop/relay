// SPDX-License-Identifier: AGPL-3.0-or-later
/** First-week setup checklist (§7): computed from live state, disappears when complete. */

const RECOVERY_KEY = 'beamhop.recoverySaved';

export function markRecoverySaved(): void {
  try {
    localStorage.setItem(RECOVERY_KEY, '1');
  } catch {
    // ignore
  }
}

export function recoverySaved(): boolean {
  try {
    return localStorage.getItem(RECOVERY_KEY) === '1';
  } catch {
    return false;
  }
}

export interface ChecklistInput {
  backupsEnabled: boolean;
  alertChannels: number;
  pushEnabled: boolean;
  recoverySaved: boolean;
  landingCustomized: boolean;
  teamSize: number;
}

export interface ChecklistItem {
  id: string;
  /** Server-provided title (experience module); otherwise the app's own label for `id`. */
  title?: string;
  done: boolean;
  href: string;
  /** Run this action instead of navigating (server checklist). */
  action?: { id: string; input: Record<string, unknown> };
}

/** Screens named by the server checklist that live elsewhere in this app. */
const SCREEN_ALIASES: Record<string, string> = {
  '/people/admins': '/people?tab=team',
  '/home/launch-kit': '/',
};

/** Shape of `experience.checklist` output (subset). */
export interface ServerChecklist {
  items: Array<{
    id: string;
    title: string;
    done: boolean;
    available: boolean;
    link: { screen: string; actionId?: string; input?: unknown };
  }>;
  hidden: boolean;
}

/** Map the server checklist to app items (unavailable items are not counted). */
export function fromServer(c: ServerChecklist): ChecklistItem[] {
  if (c.hidden) return [];
  return c.items
    .filter((i) => i.available)
    .map((i) => {
      const item: ChecklistItem = {
        id: i.id,
        title: i.title,
        done: i.done,
        href: SCREEN_ALIASES[i.link.screen] ?? (i.link.screen || '/settings'),
      };
      if (i.link.actionId)
        item.action = {
          id: i.link.actionId,
          input: (i.link.input ?? {}) as Record<string, unknown>,
        };
      return item;
    });
}

export function checklist(s: ChecklistInput): ChecklistItem[] {
  return [
    { id: 'backups', done: s.backupsEnabled, href: '/settings/backups' },
    { id: 'alerts', done: s.alertChannels > 0 || s.pushEnabled, href: '/settings/alerts' },
    { id: 'recovery', done: s.recoverySaved, href: '/settings/security' },
    { id: 'landing', done: s.landingCustomized, href: '/settings/profile' },
    { id: 'moderator', done: s.teamSize > 1, href: '/people?tab=team' },
  ];
}

/** True when the relay's public info differs from the defaults. */
export function landingCustomized(
  info: { name?: string; description?: string } | undefined,
): boolean {
  if (!info) return false;
  return (!!info.name && info.name !== 'Beamhop Relay') || !!info.description;
}
