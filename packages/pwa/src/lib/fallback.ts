// SPDX-License-Identifier: AGPL-3.0-or-later
/** Tell the admin when a link pointed at a screen this app does not have (§6.10: never a dead end). */
import { m } from './paraglide/messages.js';
import type { Tab } from './screens.ts';
import { toasts } from './stores/toasts.svelte.ts';

export function tabLabel(tab: Tab): string {
  switch (tab) {
    case '/activity':
      return m.nav_activity();
    case '/people':
      return m.nav_people();
    case '/media':
      return m.nav_media();
    case '/settings':
      return m.nav_settings();
    default:
      return m.nav_home();
  }
}

export function announceFallback(tab: Tab): void {
  toasts.show({ message: m.screen_fallback({ tab: tabLabel(tab) }), kind: 'info' }, 6000);
}
