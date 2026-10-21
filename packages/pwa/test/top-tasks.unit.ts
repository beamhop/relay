// SPDX-License-Identifier: AGPL-3.0-or-later
/** Top-20 tasks in ≤ 3 taps (§6.6): the logic behind the shortened flows. */
import { describe, expect, it, vi } from 'vitest';
import type { CatalogAction } from '../src/lib/api/types.ts';

const preview = vi.fn(async () => ({ diff: [{ kind: 'add', text: 'A new invite for 1 people' }] }));
vi.mock('../src/lib/stores/app.svelte.ts', () => ({ app: { api: { preview } } }));

const { flow } = await import('../src/lib/stores/actions.svelte.ts');
const { GOALS, goalsDiffer } = await import('../src/lib/settings/goals.ts');

const invite = {
  id: 'access.create-invite',
  title: 'Create invite',
  scope: 'relay',
  readOnly: false,
  inputSchema: { type: 'object', properties: { maxUses: { type: 'integer', default: 1 } } },
} as unknown as CatalogAction;

describe('skipping the form when the defaults are fine', () => {
  it('goes straight to the preview, and "Change" opens the form with the same input', async () => {
    await flow.start(invite, { maxUses: 1 }, { editable: true });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(flow.current?.phase).toBe('preview');
    expect(flow.current?.editable).toBe(true);
    flow.edit();
    expect(flow.current?.phase).toBe('form');
    expect(flow.current?.input).toEqual({ maxUses: 1 });
    flow.close();
  });

  it('is not editable when the form is shown first', async () => {
    await flow.start(invite, {}, { form: true, editable: true });
    expect(flow.current?.phase).toBe('form');
    expect(flow.current?.editable).toBeUndefined();
    // "Change" only works from the preview.
    flow.edit();
    expect(flow.current?.phase).toBe('form');
    flow.close();
  });
});

describe('goal sliders on Settings', () => {
  const base = { openness: 70, spamTolerance: 30, storage: 50, media: 50, speedVsCost: 50 };
  it('has the five goals', () => {
    expect(GOALS.map((g) => g.key)).toEqual([
      'openness',
      'spamTolerance',
      'storage',
      'media',
      'speedVsCost',
    ]);
  });
  it('only proposes a change when a goal moved', () => {
    expect(goalsDiffer(base, { ...base })).toBe(false);
    expect(goalsDiffer(base, { ...base, openness: 40 })).toBe(true);
  });
});
