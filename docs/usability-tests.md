# Usability tests with people

PLAN §6.6 asks for two checks on the admin app. The tap budget is automated (see
[top-tasks.md](top-tasks.md)). This page covers the other one: real people trying the top
tasks without help. A machine cannot do this part, so this page is the protocol to follow.

## When

- Before every minor release (0.x → 0.y, 1.x → 1.y).
- After any change to navigation, Home, the review sheet or the first-run wizard.
- After a top task is moved or its path changes in `packages/pwa/e2e/top-tasks.ts`.

## Who

- **5 testers per round.** At least **2 non-technical** (they have never run a server and do
  not know what a relay or a NIP is), at least 1 who runs a Nostr relay or community today,
  and at least 1 who mainly uses a phone.
- Nobody who worked on the screens being tested.
- Recruit new people for each round where possible. Someone can come back after two rounds.

## Setup

- A fresh test relay with demo data: the mock server works
  (`cd packages/pwa && bun run build && bun e2e/mock-server.ts`, then open `/admin/`), or a
  staging node with seeded reports, alerts, files and a held-back (quarantined) file.
- Phone testers use their own phone. Desktop testers use a laptop browser.
- Each tester starts on **Home, already signed in**, for every task.
- Record the screen and audio, with the tester's consent. Keep no other personal data.

## Tasks

The 20 tasks in [top-tasks.md](top-tasks.md), in a shuffled order per tester. Read each
task aloud in the plain words of the list ("Block a person", "Make a backup now"). Never
name a screen, button or tab.

## How to run a session (about 45 minutes)

1. Explain: "We are testing the app, not you. Please think aloud while you work."
2. For each task: read it, start a timer, and watch. **Do not help.** If asked, answer only
   "What would you try?"
3. Stop the task when the tester says they are done, gives up, or after 2 minutes.
4. After all tasks, ask three questions: what was hardest, what surprised them, and what
   they expected to find somewhere else.

## What to record per task

| Field | Meaning |
|---|---|
| Success | **Yes** (done without help), **Partly** (done after a wrong turn of more than 30 s), **No** (gave up, timed out, or did something else) |
| Time | Seconds from reading the task to done |
| Taps | Taps the tester needed (same counting rule as top-tasks.md) |
| Errors | Wrong screens or wrong buttons before getting there |
| Quote | One sentence the tester said, if useful |

## Pass mark

- **≥ 90 % unaided success over the round** (Yes only; Partly counts as a failure), and
- no single task below 4 of 5 testers.

A task that misses the mark gets an issue labelled `usability` with the recording timestamps,
and the fix is retested in the next round.

## Results

Store each round as `docs/usability/<yyyy-mm-dd>.md` (create the folder with the first
round), using this template:

```markdown
# Usability round <yyyy-mm-dd> — app version <x.y.z>

Testers: P1 (non-technical, phone), P2 (non-technical, desktop), P3 (relay operator, phone), P4 …, P5 …
Facilitator: <name>  ·  Note taker: <name>

| # | Task | P1 | P2 | P3 | P4 | P5 | Success | Median time | Median taps |
|---|------|----|----|----|----|----|---------|-------------|-------------|
| 1 | Review reported posts | Yes 12 s 2 taps | Partly 45 s 5 taps | … | … | … | 4/5 | 15 s | 2 |
| … | | | | | | | | | |

Overall unaided success: <n>/100 = <p> %  →  PASS / FAIL

## Findings
- <task>: <what happened>, <quote>, issue #<n>
```

Do not store names, e-mail addresses or recordings in the repository; refer to testers as
P1–P5 and keep recordings in the team's private storage for no longer than 90 days.
