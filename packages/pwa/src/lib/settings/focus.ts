// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings deep links (`/settings/<section>?field=<dotted.path>`, e.g. from the
 * launch kit): find the field, open the Advanced sheet when it lives there,
 * then scroll it into view, focus it and highlight it briefly.
 */
import type { FieldSpec } from '../forms/json-schema.ts';

export type FieldPlace = { where: 'simple' | 'advanced'; path: string };

/** Where a dotted path lives: exact match first, then a suffix match (`info.name` ↔ `relays.x.info.name`). */
export function locateField(
  dotted: string | null | undefined,
  simple: readonly FieldSpec[],
  advanced: readonly FieldSpec[],
): FieldPlace | null {
  const want = (dotted ?? '').trim().replace(/^\.+|\.+$/g, '');
  if (!want) return null;
  const lists = [
    ['simple', simple],
    ['advanced', advanced],
  ] as const;
  for (const exact of [true, false]) {
    for (const [where, fields] of lists) {
      const f = fields.find((x) => {
        const p = x.path.join('.');
        return exact ? p === want : p.endsWith(`.${want}`) || want.endsWith(`.${p}`);
      });
      if (f) return { where, path: f.path.join('.') };
    }
  }
  return null;
}

export const HIGHLIGHT = ['rounded-lg', 'ring-2', 'ring-primary', 'bg-primary/5'];

/**
 * Scroll the rendered field into view, focus its input and highlight it for
 * `ms`. Retries for a moment while a sheet opens. Resolves true when found.
 */
export async function focusField(
  path: string,
  opts: { root?: ParentNode; tries?: number; ms?: number } = {},
): Promise<boolean> {
  const root = opts.root ?? document;
  const tries = opts.tries ?? 20;
  for (let i = 0; i < tries; i++) {
    const el = root.querySelector<HTMLElement>(`[data-setting-field="${CSS.escape(path)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // The value control, not the ⓘ button that comes first in the row.
      const input =
        el.querySelector<HTMLElement>('[data-setting-input]') ??
        el.querySelector<HTMLElement>('input, textarea, select, [role="switch"]');
      input?.focus({ preventScroll: true });
      // The router resets focus right after a navigation; take it back once.
      setTimeout(() => {
        if (input && document.activeElement !== input) input.focus({ preventScroll: true });
      }, 250);
      el.classList.add(...HIGHLIGHT);
      el.dataset.highlighted = 'true';
      setTimeout(() => {
        el.classList.remove(...HIGHLIGHT);
        delete el.dataset.highlighted;
      }, opts.ms ?? 2000);
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
