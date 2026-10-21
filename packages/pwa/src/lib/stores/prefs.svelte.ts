// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-device preferences: the app-wide "Show technical details" lens (§6.6)
 * and the colour theme. Persisted in localStorage; safe without storage.
 */

export type Theme = 'dark' | 'light' | 'system';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const LENS_KEY = 'beamhop.lens';
const THEME_KEY = 'beamhop.theme';

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class Prefs {
  /** App-wide technical lens: reveals NIPs, kinds, raw keys and values. */
  lens = $state(false);
  theme = $state<Theme>('dark');

  constructor(private readonly storage: KV | null = defaultStorage()) {
    const lens = this.read(LENS_KEY);
    this.lens = lens === '1';
    const theme = this.read(THEME_KEY);
    if (theme === 'light' || theme === 'system' || theme === 'dark') this.theme = theme;
  }

  private read(k: string): string | null {
    try {
      return this.storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  }

  private write(k: string, v: string): void {
    try {
      this.storage?.setItem(k, v);
    } catch {
      // storage full or blocked: keep the in-memory value
    }
  }

  setLens(on: boolean): void {
    this.lens = on;
    this.write(LENS_KEY, on ? '1' : '0');
  }

  toggleLens(): boolean {
    this.setLens(!this.lens);
    return this.lens;
  }

  setTheme(t: Theme): void {
    this.theme = t;
    this.write(THEME_KEY, t);
    this.applyTheme();
  }

  /** Effective dark/light after resolving `system`. */
  resolvedTheme(): 'dark' | 'light' {
    if (this.theme !== 'system') return this.theme;
    const light =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
    return light ? 'light' : 'dark';
  }

  applyTheme(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', this.resolvedTheme() === 'dark');
  }
}

export const prefs = new Prefs();
