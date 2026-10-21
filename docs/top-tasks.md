<!-- Generated from packages/pwa/e2e/top-tasks.ts — do not edit by hand. -->
<!-- Regenerate: cd packages/pwa && UPDATE_TOP_TASKS_DOC=1 bunx playwright test e2e/top-tasks.e2e.ts -g "doc" -->

# Top 20 admin tasks

PLAN §6.6: every top-20 admin task takes **at most 3 taps**. This is the maintained list.
The single source is [`packages/pwa/e2e/top-tasks.ts`](../packages/pwa/e2e/top-tasks.ts);
the E2E tests `top-tasks.e2e.ts` (phone, iPhone 13) and `top-tasks-desktop.e2e.ts`
(desktop, 1440×900) run every task against the mock server, record each counted tap and
check that the recorded path is exactly the one below and no longer than 3.

## How taps are counted

- Start: Home, signed in, page loaded (signing in is not counted).
- One tap each: a tap/click, a swipe or drag (also a slider), typing into a field (the
  whole text), a key press, and the final confirm on a preview/review sheet.
- A native drop-down list counts as two (open the list, pick an option).
- Scrolling and waiting are not counted.
- Done when the action ran on the server or the screen shows the answer.
- Phone uses the bottom tab bar and the floating button; desktop uses the sidebar.

## The list

| # | Task | Phone path | Taps | Desktop path | Taps |
|---|------|------------|------|--------------|------|
| 1 | Review reported posts | Activity → Review queue | 2 | Activity → Review queue | 2 |
| 2 | Remove a reported post | Activity → Review queue → Remove | 3 | Activity → Review queue → Remove | 3 |
| 3 | Block a person | People → Swipe the person left → Block | 3 | People → Drag the person left → Block | 3 |
| 4 | Undo a mistake (after its toast is gone) | Settings → Settings history → Undo | 3 | Settings → Settings history → Undo | 3 |
| 5 | Invite someone to the admin team | People → Invite to team → Confirm | 3 | People → Invite to team → Confirm | 3 |
| 6 | Create an invite link for a new member | People → Invite a member → Confirm | 3 | People → Invite a member → Confirm | 3 |
| 7 | Check that the relay is healthy, and why | Why? (health) | 1 | Why? (health) | 1 |
| 8 | See why a post was refused | Activity → Refused → Why? | 3 | Activity → Refused → Why? | 3 |
| 9 | Make the relay members-only | Settings → People I approve → Apply | 3 | Settings → People I approve → Apply | 3 |
| 10 | Make the relay less open (goal slider) | Settings → Drag "How open the relay is" → Apply | 3 | Settings → Drag "How open the relay is" → Apply | 3 |
| 11 | Approve a suggestion on Home | Block all 3 → Confirm | 2 | Block all 3 → Confirm | 2 |
| 12 | Mute an alert | Activity → Alerts → Mute | 3 | Activity → Alerts → Mute | 3 |
| 13 | Snooze an alert for an hour | Activity → Alerts → Snooze 1 hour | 3 | Activity → Alerts → Snooze 1 hour | 3 |
| 14 | Check how much storage is used | Storage tile | 1 | Storage tile | 1 |
| 15 | Delete an uploaded file | Media → The file → Delete | 3 | Media → The file → Delete | 3 |
| 16 | Release a file that was held back (quarantined) | Media → Quarantined → Release | 3 | Media → Quarantined → Release | 3 |
| 17 | Make a backup now | Settings → Back up now | 2 | Settings → Back up now | 2 |
| 18 | Go back to an earlier version of the settings | Settings → Settings history → Restore | 3 | Settings → Settings history → Restore | 3 |
| 19 | Test my relay | Test my relay | 1 | Test my relay | 1 |
| 20 | Open the launch kit (address, QR code, announcement) | Open launch kit | 1 | Open launch kit | 1 |

✗ = over the 3-tap budget. 20 of 20 tasks are within budget.

## Known over budget

These tests are marked `test.fail()` until the UI is fixed; the rule itself is not
relaxed. When a fix lands, the test starts passing, Playwright reports
"expected to fail", and the entry moves up by updating its path in `top-tasks.ts`.

None: every task fits the budget on phone and desktop.

## Notes

- "Test my relay" and "Open launch kit" are one tap from the Home setup checklist while
  it is shown; afterwards both are in Search (Search → type → pick = 3).
- Right after a mistake, Undo on its toast is one tap; the list counts the harder case
  where the toast is already gone.
- Usability tests with real people use this same list: see
  [usability-tests.md](usability-tests.md).
