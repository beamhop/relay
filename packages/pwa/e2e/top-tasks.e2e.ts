// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phone (iPhone 13): every top-20 admin task in ≤ 3 taps (PLAN §6.6). The list,
 * the tap-counting rule and the runner live in `top-tasks.ts`; this file also keeps
 * `docs/top-tasks.md` in sync with that list.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { TOP_TASKS, defineTopTaskTests, renderDoc } from './top-tasks.ts';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/top-tasks.md');

test('doc: docs/top-tasks.md matches the task list', () => {
  expect(TOP_TASKS).toHaveLength(20);
  expect(new Set(TOP_TASKS.map((t) => t.id)).size).toBe(20);
  for (const t of TOP_TASKS)
    if ([t.phone, t.desktop ?? []].some((p) => p.length > 3))
      expect(t.fix, `${t.id} is over budget and needs a suggested fix`).toBeTruthy();
  const doc = renderDoc();
  if (process.env.UPDATE_TOP_TASKS_DOC) writeFileSync(DOC, doc);
  expect(readFileSync(DOC, 'utf8'), 'run with UPDATE_TOP_TASKS_DOC=1 to regenerate').toBe(doc);
});

defineTopTaskTests('phone');
