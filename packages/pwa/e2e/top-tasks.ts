// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The top-20 admin tasks (PLAN §6.6: "Every top-20 admin task ≤ 3 taps").
 * Single source of truth: `docs/top-tasks.md` is generated from this list and
 * `e2e/top-tasks.e2e.ts` (phone) / `e2e/top-tasks-desktop.e2e.ts` (desktop)
 * run every task on the mock server and count the taps.
 *
 * ── Counting rule ─────────────────────────────────────────────────────────────
 * Every task starts on Home, signed in, with the page loaded (signing in and
 * landing on Home are not counted). Then each of these is ONE tap:
 *   - a tap or click on anything (tab, button, link, card, menu entry),
 *   - a swipe or drag (one finger gesture, also a slider drag),
 *   - typing into a field (the whole text is one tap: the field gets focus
 *     and the keyboard appears; typing itself is not counted per letter),
 *   - a key press (desktop shortcut),
 *   - the final confirm on a preview/review sheet ("Confirm", "Apply").
 * Choosing from a native drop-down list counts as TWO (open the list, pick).
 * Scrolling and waiting do not count. A task is complete when the action ran
 * (the mock server logged it / state changed) or the screen shows the answer.
 *
 * Budget: ≤ 3 taps. A task over budget stays in the list with its real path and
 * a concrete UI fix (`fix`); its test is marked `test.fail()` until the UI is fixed.
 * Only the budget assertion may fail: if anything else goes wrong (a selector,
 * the completed state, the recorded path differs from the declared one) the
 * test passes instead, which `test.fail()` reports as an error.
 *
 * Regenerate the doc after editing this list:
 *   UPDATE_TOP_TASKS_DOC=1 bunx playwright test e2e/top-tasks.e2e.ts -g "doc"
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { serverLog, signedIn, touchSwipe } from './helpers.ts';

export const TAP_BUDGET = 3;

export type Project = 'phone' | 'desktop';

/** Wraps user input and records one label per counted tap. */
export class Taps {
  readonly log: string[] = [];
  constructor(
    readonly page: Page,
    readonly project: Project,
  ) {}

  get count(): number {
    return this.log.length;
  }

  /** Tap (phone, real touch) or click (desktop). */
  async tap(label: string, target: Locator): Promise<void> {
    if (this.project === 'phone') await target.tap();
    else await target.click();
    this.log.push(label);
  }

  /** One of the five main destinations: bottom tab bar (phone) or sidebar (desktop). */
  async nav(label: string): Promise<void> {
    const bar = this.page.getByTestId(this.project === 'phone' ? 'tab-bar' : 'sidebar');
    await this.tap(label, bar.getByRole('link', { name: label, exact: true }));
  }

  /** Open the search / command palette (floating button on phone, sidebar field on desktop). */
  async search(label = 'Search'): Promise<void> {
    if (this.project === 'phone') await this.tap(label, this.page.getByTestId('fab'));
    else await this.tap(label, this.page.getByRole('button', { name: /Search or run/ }).first());
  }

  /** Typing into a field counts once. */
  async type(label: string, target: Locator, text: string): Promise<void> {
    await target.fill(text);
    this.log.push(label);
  }

  /** Native drop-down: open the list + pick an option = two taps. */
  async choose(openLabel: string, pickLabel: string, target: Locator, value: string) {
    await target.selectOption(value);
    this.log.push(openLabel, pickLabel);
  }

  /** One swipe / drag gesture: touch on phone, mouse drag on desktop. */
  async swipe(label: string, target: Locator, dx: number, dy = 0): Promise<void> {
    if (this.project === 'phone') await touchSwipe(this.page, target, dx, dy);
    else {
      const box = await target.boundingBox();
      if (!box) throw new Error(`drag target not visible: ${label}`);
      const x = box.x + box.width / 2;
      const y = box.y + Math.min(box.height / 2, 30);
      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      await this.page.mouse.move(x + dx, y + dy, { steps: 14 });
      await this.page.mouse.up();
    }
    this.log.push(label);
  }
}

export interface TopTask {
  id: string;
  /** Plain words, as an admin would say it. */
  title: string;
  /** Tap path on a phone (one entry per counted tap, written by `run`). */
  phone: string[];
  /** Tap path on desktop when it differs from the phone path. */
  desktop?: string[];
  /** Concrete UI fix for a task over budget (required when a path is longer than 3). */
  fix?: string;
  /** Extra `/__reset` options for this task. */
  reset?: Record<string, unknown>;
  /** Not counted: state the task needs (e.g. a mistake to undo). */
  setup?: (page: Page) => Promise<void>;
  /** Do the task with counted input, then assert the completed state. */
  run: (t: Taps, page: Page) => Promise<void>;
}

export const pathFor = (task: TopTask, project: Project): string[] =>
  project === 'desktop' ? (task.desktop ?? task.phone) : task.phone;

const log = async (page: Page) => (await serverLog(page)).log.map((l) => l.id);
const sheet = (page: Page) => page.getByTestId('action-sheet');

export const TOP_TASKS: TopTask[] = [
  {
    id: 'review-reports',
    title: 'Review reported posts',
    phone: ['Activity', 'Review queue'],
    run: async (t, page) => {
      await t.nav('Activity');
      await t.tap('Review queue', page.getByTestId('tab-queue'));
      await expect(page.getByTestId('queue-count')).toHaveText('3 to review');
      await expect(page.getByTestId('queue-reason')).toContainText('Reported for spam');
    },
  },
  {
    id: 'remove-post',
    title: 'Remove a reported post',
    phone: ['Activity', 'Review queue', 'Remove'],
    run: async (t, page) => {
      await t.nav('Activity');
      await t.tap('Review queue', page.getByTestId('tab-queue'));
      await t.tap('Remove', page.getByTestId('triage-remove'));
      await expect(page.getByTestId('queue-count')).toHaveText('2 to review');
      expect(await log(page)).toContain('moderation.remove');
    },
  },
  {
    id: 'block-person',
    title: 'Block a person',
    phone: ['People', 'Swipe the person left', 'Block'],
    desktop: ['People', 'Drag the person left', 'Block'],
    run: async (t, page) => {
      await t.nav('People');
      const row = page.getByTestId('user-row').first();
      await expect(page.getByTestId('user-row')).toHaveCount(3);
      await t.swipe(
        t.project === 'phone' ? 'Swipe the person left' : 'Drag the person left',
        row,
        -240,
      );
      await t.tap('Block', row.locator('[data-row-action="ban"]'));
      await expect.poll(async () => (await serverLog(page)).bans).toEqual(['c'.repeat(64)]);
    },
  },
  {
    id: 'undo-mistake',
    title: 'Undo a mistake (after its toast is gone)',
    phone: ['Settings', 'Settings history', 'Undo'],
    setup: async (page) => {
      // The mistake: approve the spam card on Home, then close the toast.
      await page.getByTestId('card-primary').click();
      await sheet(page).getByTestId('action-confirm').click();
      await expect(page.getByTestId('inbox-zero')).toBeVisible();
      await page.getByTestId('toast').getByTestId('toast-close').click();
      await expect(page.getByTestId('toast')).toHaveCount(0);
      expect((await serverLog(page)).bans).toHaveLength(1);
    },
    run: async (t, page) => {
      await t.nav('Settings');
      await t.tap('Settings history', page.getByTestId('history-link'));
      await t.tap('Undo', page.getByTestId('history-undo-button'));
      await expect(page.getByTestId('history-undo')).toHaveCount(0);
      await expect.poll(async () => (await serverLog(page)).bans).toHaveLength(0);
    },
  },
  {
    id: 'invite-admin',
    title: 'Invite someone to the admin team',
    phone: ['People', 'Invites', 'Invite to team', 'Continue', 'Confirm'],
    fix: 'Skip the input form when every field has a default (the role defaults to moderator): go straight to the preview, with "Change" on the preview to edit the role. Also show "Invite to team" on the People screen header so the Invites tab is not needed: People → Invite to team → Confirm (3).',
    run: async (t, page) => {
      await t.nav('People');
      await t.tap('Invites', page.getByTestId('tab-invites'));
      await t.tap('Invite to team', page.getByRole('button', { name: /Invite to team/ }));
      await t.tap('Continue', sheet(page).getByTestId('action-continue'));
      await t.tap('Confirm', sheet(page).getByTestId('action-confirm'));
      await expect(sheet(page).getByTestId('action-secret')).toBeVisible();
      expect(await log(page)).toContain('admins.invite');
    },
  },
  {
    id: 'invite-link',
    title: 'Create an invite link for a new member',
    phone: ['People', 'Invites', 'Invite a member', 'Continue', 'Confirm'],
    fix: 'Same as "Invite someone to the admin team": skip the form when the defaults are fine (1 use, 7 days) and show the defaults on the preview with "Change"; put "Invite a member" on the People screen header: People → Invite a member → Confirm (3).',
    run: async (t, page) => {
      await t.nav('People');
      await t.tap('Invites', page.getByTestId('tab-invites'));
      await t.tap('Invite a member', page.getByRole('button', { name: /Invite a member/ }));
      await t.tap('Continue', sheet(page).getByTestId('action-continue'));
      await t.tap('Confirm', sheet(page).getByTestId('action-confirm'));
      await expect(sheet(page).getByTestId('action-secret')).toContainText('INVITE');
      expect(await log(page)).toContain('access.create-invite');
    },
  },
  {
    id: 'check-health',
    title: 'Check that the relay is healthy, and why',
    phone: ['Why? (health)'],
    run: async (t, page) => {
      await expect(page.getByTestId('health-score')).toBeVisible();
      const health = page.locator('section[aria-labelledby="health-title"]');
      await t.tap('Why? (health)', health.getByTestId('why-button'));
      await expect(page.getByTestId('why-answer')).toBeVisible();
    },
  },
  {
    id: 'why-refused',
    title: 'See why a post was refused',
    phone: ['Activity', 'Refused', 'Why?'],
    run: async (t, page) => {
      await t.nav('Activity');
      await t.tap('Refused', page.getByTestId('filter-refused'));
      const row = page.getByTestId('refused-row').first();
      await expect(row).toContainText('blocked word');
      await t.tap('Why?', row.getByTestId('why-button'));
      await expect(page.getByTestId('why-answer')).toBeVisible();
    },
  },
  {
    id: 'members-only',
    title: 'Make the relay members-only',
    phone: [
      'Settings',
      'Access',
      'Open the "Who can post" list',
      'Only people I approve',
      'Save',
      'Apply',
    ],
    fix: 'Put "Who can post" as three tappable choices (Anyone / People I approve / Web of trust) at the top of the Settings screen; tapping one opens the review sheet directly: Settings → Only people I approve → Apply (3). A segmented control instead of a native drop-down also removes the extra "open the list" tap.',
    run: async (t, page) => {
      await t.nav('Settings');
      await t.tap('Access', page.getByTestId('section-access'));
      const select = page.locator('[data-setting-field$="access.mode"] select');
      await t.choose('Open the "Who can post" list', 'Only people I approve', select, 'allowlist');
      await t.tap('Save', page.getByTestId('section-save'));
      await t.tap('Apply', page.getByTestId('config-diff-sheet').getByTestId('config-apply'));
      await expect
        .poll(async () => (await serverLog(page)).relay as unknown as { access: { mode: string } })
        .toMatchObject({ access: { mode: 'allowlist' } });
    },
  },
  {
    id: 'goal-slider',
    title: 'Make the relay less open (goal slider)',
    phone: ['Settings', 'Goals', 'Drag "How open the relay is"', 'Save', 'Apply'],
    fix: 'Show the five goal sliders on the Settings screen itself and open the review sheet when a slider is released (no separate Save): Settings → drag → Apply (3).',
    run: async (t, page) => {
      await t.nav('Settings');
      await t.tap('Goals', page.getByTestId('goals-link'));
      const thumb = page.locator('[data-goal="openness"] [role="slider"]');
      await expect(thumb).toBeVisible();
      await t.swipe('Drag "How open the relay is"', thumb, -90);
      await expect(page.getByTestId('goal-changes').locator('li').first()).toBeVisible();
      await t.tap('Save', page.getByTestId('goals-save'));
      await t.tap('Apply', page.getByTestId('config-diff-sheet').getByTestId('config-apply'));
      await expect.poll(async () => (await serverLog(page)).relay.goals.openness).toBeLessThan(70);
    },
  },
  {
    id: 'approve-suggestion',
    title: 'Approve a suggestion on Home',
    phone: ['Block all 3', 'Confirm'],
    run: async (t, page) => {
      await expect(page.getByTestId('attention-card')).toContainText('Spam wave');
      await t.tap('Block all 3', page.getByTestId('card-primary'));
      await t.tap('Confirm', sheet(page).getByTestId('action-confirm'));
      await expect(page.getByTestId('inbox-zero')).toBeVisible();
      expect((await serverLog(page)).bans).toHaveLength(1);
    },
  },
  {
    id: 'mute-alert',
    title: 'Mute an alert',
    phone: ['Activity', 'Alerts', 'Mute'],
    run: async (t, page) => {
      await t.nav('Activity');
      await t.tap('Alerts', page.getByTestId('tab-alerts'));
      const row = page.getByTestId('alert-row').nth(1);
      await t.tap('Mute', row.getByTestId('alert-mute'));
      await expect(row.getByTestId('alert-muted')).toContainText('Muted');
    },
  },
  {
    id: 'snooze-alert',
    title: 'Snooze an alert for an hour',
    phone: ['Activity', 'Alerts', 'Snooze', '1 hour'],
    fix: 'Make "Snooze" snooze for 1 hour in one tap, with "Undo · Longer…" on the toast for other durations (or swipe an alert row left to snooze 1 hour): Activity → Alerts → Snooze (3).',
    run: async (t, page) => {
      await t.nav('Activity');
      await t.tap('Alerts', page.getByTestId('tab-alerts'));
      const row = page.getByTestId('alert-row').first();
      await t.tap('Snooze', row.getByTestId('alert-snooze'));
      await t.tap('1 hour', row.getByTestId('alert-snooze-1h'));
      await expect(row.getByTestId('alert-muted')).toContainText('Snoozed until');
    },
  },
  {
    id: 'storage-use',
    title: 'Check how much storage is used',
    phone: ['Storage tile'],
    run: async (t, page) => {
      const tile = page.getByTestId('tile-storage');
      await expect(tile).not.toContainText('—');
      await t.tap('Storage tile', tile);
      await expect(page.getByRole('dialog').getByText('Storage').first()).toBeVisible();
    },
  },
  {
    id: 'delete-file',
    title: 'Delete an uploaded file',
    phone: ['Media', 'The file', 'Delete'],
    run: async (t, page) => {
      await t.nav('Media');
      await t.tap('The file', page.getByTestId('media-tile').first());
      await t.tap('Delete', page.getByTestId('file-sheet').getByTestId('file-delete'));
      await expect(page.getByTestId('toast').first()).toContainText('Deleted 1 file');
      expect(await log(page)).toContain('media.delete-blob');
    },
  },
  {
    id: 'release-quarantine',
    title: 'Release a file that was held back (quarantined)',
    phone: ['Media', 'Quarantined', 'Release', 'Confirm'],
    fix: 'Release is undoable, so run it straight away with an Undo toast instead of a preview sheet (keep the preview for "Delete for good"): Media → Quarantined → Release (3). Optionally show held files as a Home card with Release / Delete.',
    run: async (t, page) => {
      await t.nav('Media');
      await t.tap('Quarantined', page.getByTestId('tab-quarantine'));
      const rows = page.getByTestId('q-row');
      await expect(rows).toHaveCount(2);
      const ruled = page.locator('[data-testid="q-row"][data-abuse="false"]');
      await t.tap('Release', ruled.getByTestId('q-release'));
      await t.tap('Confirm', sheet(page).getByTestId('action-confirm'));
      await expect(rows).toHaveCount(1);
      expect(await log(page)).toContain('media.release-quarantine');
    },
  },
  {
    id: 'backup-now',
    title: 'Make a backup now',
    phone: ['Search', 'Type "back up"', 'Back up now', 'Confirm'],
    fix: 'A backup only adds data, so run "Back up now" without a confirm sheet (show the result in a toast), and add a "Back up now" button to the Backups row of the Settings screen: Settings → Back up now (2).',
    run: async (t, page) => {
      await t.search();
      const palette = page.getByTestId('command-palette');
      await t.type('Type "back up"', palette.getByRole('combobox'), 'back up');
      await t.tap('Back up now', palette.getByRole('option', { name: /Back up now/ }));
      await expect(sheet(page).getByTestId('diff')).toContainText('Make a new backup');
      await t.tap('Confirm', sheet(page).getByTestId('action-confirm'));
      await expect(page.getByTestId('toast').first()).toContainText('Backup made');
      expect(await log(page)).toContain('backups.run-now');
    },
  },
  {
    id: 'restore-revision',
    title: 'Go back to an earlier version of the settings',
    phone: ['Settings', 'Settings history', 'The earlier version', 'Restore'],
    fix: 'Restoring is undoable: give each History entry its own "Restore" button that restores at once with an Undo toast (the diff stays one tap away under the entry): Settings → Settings history → Restore (3).',
    run: async (t, page) => {
      await t.nav('Settings');
      await t.tap('Settings history', page.getByTestId('history-link'));
      await t.tap('The earlier version', page.getByTestId('revision-1'));
      await expect(page.getByRole('dialog')).toContainText('Who can post');
      await t.tap('Restore', page.getByTestId('restore'));
      await expect(page.getByTestId('timeline')).toContainText('Restored revision 1');
      expect(await log(page)).toContain('config.restore');
    },
  },
  {
    id: 'test-relay',
    title: 'Test my relay',
    phone: ['Test my relay'],
    run: async (t, page) => {
      await t.tap(
        'Test my relay',
        page.getByTestId('setup-checklist').getByTestId('checklist-test-relay'),
      );
      await expect(sheet(page).getByTestId('test-relay-result')).toBeVisible();
      expect(await log(page)).toContain('experience.test-relay');
    },
  },
  {
    id: 'launch-kit',
    title: 'Open the launch kit (address, QR code, announcement)',
    phone: ['Open launch kit'],
    run: async (t, page) => {
      await t.tap('Open launch kit', page.getByTestId('checklist-launch-test-relay'));
      await expect(page.getByTestId('launch-relay-url')).toHaveText('wss://relay.example.com');
      await expect(page.getByTestId('launch-post')).toBeVisible();
    },
  },
];

/** Register one test per task for a Playwright project (called by the two spec files). */
export function defineTopTaskTests(project: Project): void {
  test.describe(`top-20 tasks in ≤ ${TAP_BUDGET} taps (${project})`, () => {
    for (const task of TOP_TASKS) {
      const path = pathFor(task, project);
      test(`${task.id}: ${task.title}`, async ({ page }) => {
        const overBudget = path.length > TAP_BUDGET;
        // Over budget: known UI gap, see `fix` and docs/top-tasks.md → "Known over budget".
        test.fail(overBudget, `needs ${path.length} taps; suggested fix: ${task.fix}`);
        await page.request.post('/__reset', {
          data: {
            claimed: true,
            ai: 'absent',
            host: 'relay.example.com',
            topTasks: true,
            ...task.reset,
          },
        });
        await signedIn(page);
        await page.goto('/admin/');
        await expect(page.getByTestId('health-score')).toBeVisible();
        if (task.setup) await task.setup(page);

        const taps = new Taps(page, project);
        try {
          await task.run(taps, page);
          // The doc must describe exactly what the user does.
          expect(taps.log).toEqual(path);
        } catch (err) {
          // Over budget, only the budget check below may fail (see the header).
          if (overBudget) {
            test.info().annotations.push({ type: 'unexpected', description: String(err) });
            return;
          }
          throw err;
        }
        expect(taps.count, `${task.title}: ${taps.log.join(' → ')}`).toBeLessThanOrEqual(
          TAP_BUDGET,
        );
      });
    }
  });
}

/** Markdown for `docs/top-tasks.md` (generated; do not edit the doc by hand). */
export function renderDoc(): string {
  const arrow = (p: string[]) => p.join(' → ');
  const cell = (p: string[]) => `${arrow(p)} | ${p.length}${p.length > TAP_BUDGET ? ' ✗' : ''}`;
  const over = TOP_TASKS.filter((t) =>
    (['phone', 'desktop'] as const).some((p) => pathFor(t, p).length > TAP_BUDGET),
  );
  const lines = [
    '<!-- Generated from packages/pwa/e2e/top-tasks.ts — do not edit by hand. -->',
    '<!-- Regenerate: cd packages/pwa && UPDATE_TOP_TASKS_DOC=1 bunx playwright test e2e/top-tasks.e2e.ts -g "doc" -->',
    '',
    '# Top 20 admin tasks',
    '',
    'PLAN §6.6: every top-20 admin task takes **at most 3 taps**. This is the maintained list.',
    'The single source is [`packages/pwa/e2e/top-tasks.ts`](../packages/pwa/e2e/top-tasks.ts);',
    'the E2E tests `top-tasks.e2e.ts` (phone, iPhone 13) and `top-tasks-desktop.e2e.ts`',
    '(desktop, 1440×900) run every task against the mock server, record each counted tap and',
    'check that the recorded path is exactly the one below and no longer than 3.',
    '',
    '## How taps are counted',
    '',
    '- Start: Home, signed in, page loaded (signing in is not counted).',
    '- One tap each: a tap/click, a swipe or drag (also a slider), typing into a field (the',
    '  whole text), a key press, and the final confirm on a preview/review sheet.',
    '- A native drop-down list counts as two (open the list, pick an option).',
    '- Scrolling and waiting are not counted.',
    '- Done when the action ran on the server or the screen shows the answer.',
    '- Phone uses the bottom tab bar and the floating button; desktop uses the sidebar.',
    '',
    '## The list',
    '',
    '| # | Task | Phone path | Taps | Desktop path | Taps |',
    '|---|------|------------|------|--------------|------|',
    ...TOP_TASKS.map(
      (t, i) =>
        `| ${i + 1} | ${t.title} | ${cell(pathFor(t, 'phone'))} | ${cell(pathFor(t, 'desktop'))} |`,
    ),
    '',
    `✗ = over the ${TAP_BUDGET}-tap budget. ${TOP_TASKS.length - over.length} of ${TOP_TASKS.length} tasks are within budget.`,
    '',
    '## Known over budget',
    '',
    'These tests are marked `test.fail()` until the UI is fixed; the rule itself is not',
    'relaxed. When a fix lands, the test starts passing, Playwright reports',
    '"expected to fail", and the entry moves up by updating its path in `top-tasks.ts`.',
    '',
    ...over.flatMap((t) => [
      `- **${t.title}** (${pathFor(t, 'phone').length} taps): ${arrow(pathFor(t, 'phone'))}.`,
      `  Suggested fix: ${t.fix ?? '(missing)'}`,
    ]),
    '',
    '## Notes',
    '',
    '- "Test my relay" and "Open launch kit" are one tap from the Home setup checklist while',
    '  it is shown; afterwards both are in Search (Search → type → pick = 3).',
    '- Right after a mistake, Undo on its toast is one tap; the list counts the harder case',
    '  where the toast is already gone.',
    '- Usability tests with real people use this same list: see',
    '  [usability-tests.md](usability-tests.md).',
    '',
  ];
  return lines.join('\n');
}
