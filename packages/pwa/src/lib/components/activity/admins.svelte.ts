// SPDX-License-Identifier: AGPL-3.0-or-later
/** The admin team by name (on-call schedule, "who's on call now"). */
import { app } from '../../stores/app.svelte.ts';
import { names } from '../../stores/names.svelte.ts';

export interface Admin {
  id: string;
  pubkey?: string;
  displayName?: string;
  roles?: Record<string, string>;
}

class Admins {
  list = $state<Admin[]>([]);
  private loading: Promise<void> | null = null;
  private loaded = false;

  ensure(): Promise<void> {
    if (this.loaded || !app.hasAction('admins.list')) return Promise.resolve();
    this.loading ??= app.api
      .run<{ admins: Admin[] }>('admins.list', {}, 'node')
      .then((r) => {
        this.list = r.output.admins;
        this.loaded = true;
      })
      .catch(() => {})
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Plain name for a principal id (never a bare hex key). */
  name(id: string): string {
    const a = this.list.find((x) => x.id === id || x.pubkey === id);
    if (a?.displayName) return a.displayName;
    return names.label(a?.pubkey ?? id);
  }
}

export const admins = new Admins();
