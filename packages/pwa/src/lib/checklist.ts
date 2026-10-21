// SPDX-License-Identifier: AGPL-3.0-or-later
/** First-week setup checklist (§7): computed from live state, disappears when complete. */

import { resolveScreen } from './screens.ts';

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
  /** The server named a screen this app does not have: `href` is the nearest tab. */
  fallback?: boolean;
  /** Run this action instead of navigating (server checklist). */
  action?: { id: string; input: Record<string, unknown> };
}

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

/**
 * Map the server checklist to app items (unavailable items are not counted).
 * Screens are resolved defensively: unknown ones point at the nearest tab.
 */
export function fromServer(c: ServerChecklist, modules: readonly string[] = []): ChecklistItem[] {
  if (c.hidden) return [];
  return c.items
    .filter((i) => i.available)
    .map((i) => {
      const screen = resolveScreen(i.link.screen || '/settings', modules);
      const item: ChecklistItem = {
        id: i.id,
        title: i.title,
        done: i.done,
        href: screen.href,
      };
      if (screen.fallback) item.fallback = true;
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
