# Contributing to Beamhop

Thanks for helping. This page covers setup, the checks every change must pass, the
house rules, and how to sign off your commits.

## Set up

You need [Bun](https://bun.sh) 1.4 or newer (and Node 22 for the Cloudflare test suite).

```bash
bun install          # whole monorepo; do not commit bun.lock
bun test             # all unit tests
bun run typecheck
```

## Build the binary

One command builds everything into one file: the admin app, the team app, then the
`beamhop` binary with both embedded (plus the image codecs and worker threads).

```bash
bun run build                                  # this platform → packages/runtime-bun/dist/beamhop-<os>-<arch>
bun run build -- --all                         # linux-x64, linux-arm64, darwin-arm64, windows-x64
bun run build -- --target linux-x64 --outdir dist
bun run build -- --skip-ui                     # reuse existing app builds
```

The build stops if an app build is missing or fails, and checks the host binary with
`beamhop --build-info`. For a quick server-only binary while developing:
`bun packages/runtime-bun/scripts/build.ts --host --allow-missing-ui`.

To try the Linux binary on a clean machine, `bun run smoke:linux` boots a Debian microVM
with [microsandbox](https://microsandbox.dev) (`msb`), runs the binary there with nothing
else installed, and checks the relay, both apps, the CLI and photo processing. MicroVMs
use the host's architecture: on Apple Silicon this tests `linux-arm64`; `linux-x64` needs
an x86-64 Linux host with KVM.

```bash
bun run build -- --skip-ui --target linux-arm64
bun run smoke:linux
```

Package layout, the stack and the contracts every package builds on are described in
[CLAUDE.md](CLAUDE.md) (engineering conventions) and [PLAN.md](PLAN.md) (product plan).
Read the contracts in `packages/core/src/` before writing code.

## Run the checks

CI runs these as parallel jobs (`.github/workflows/ci.yml`). Each is a plain command you
can run locally before opening a pull request.

| Area | Command |
|---|---|
| Everything in Bun | `bun run typecheck && bunx biome check . && bun test` |
| Generated reference docs | `bun docs/reference/generate.ts --check` |
| Protocol conformance | `bun packages/conformance/scripts/self-check.ts --all` |
| License headers | `bun run ci:spdx` |
| Commit sign-offs | `bun run ci:dco` (checks `main..HEAD`) |
| Admin app | in `packages/pwa`: `bun run check`, `bunx vitest run`, `bun run build`, `bun run size`, `bunx playwright test` |
| Vanilla profile | `bun run ci:vanilla` (builds the admin app, then `scripts/ci/vanilla-check.ts`) |
| Team client | in `packages/team-client`: `bun run check`, `bun run build`; then `bun test packages/team-client/src/beamhop` |
| Cloudflare | in `packages/runtime-cf`: `bun run test:workerd`; then `bun run ci:cf-bundle` |

Format with `bunx biome check --write .`. Playwright needs Chromium once:
`bunx playwright install chromium`.

### The vanilla profile

Enterprise features must not complicate anyone else (PLAN §12.0). CI enforces it:

- `packages/runtime-bun/test/vanilla.test.ts`: a default node loads no enterprise module and
  exposes no company screens, enterprise actions or enterprise config sections.
- `scripts/ci/vanilla-check.ts`: the admin app chunks a non-enterprise admin downloads contain
  none of the words in `scripts/ci/enterprise-terms.ts`, and stay within the size budgets.
  Enterprise screens belong in lazy chunks (`src/lib/modules/*`, the company route).
- `packages/pwa/e2e/vanilla.e2e.ts`: the first-run wizard keeps its steps
  (`e2e/vanilla.wizard.txt`) and mentions nothing enterprise. After an intended wizard
  change, refresh the outline with
  `UPDATE_VANILLA_SNAPSHOT=1 bunx playwright test e2e/vanilla.e2e.ts --project iphone`.

## House rules (summary)

The full list is in [CLAUDE.md](CLAUDE.md). The short version:

- **Every feature is a module** (`defineModule`); core never imports feature packages.
- **Every admin operation is an action** (`defineAction`) with a plain-language title, a
  preview of what changes, and undo where possible. No hand-written admin REST endpoints.
- **Plain language first.** Anything a user reads is plain words ("Only invited people can
  post"). Protocol details such as NIP numbers and event kinds go in the `technical` lens
  fields, never in the main text.
- **No payments.** No Lightning, no cryptocurrency, no zaps, no wallets, no paid tiers in
  the product. Pull requests that add any of these will not be merged.
- **Privacy.** Never log raw IP addresses (use `ports.crypto.hashIp`); no telemetry.
- **Tests** use the memory adapters from `@beamhop/testkit`; no real network in tests.
- **Mobile first.** At most 7 settings per simple screen, top tasks in 3 taps or fewer,
  same features on desktop.

## License and sign-off

Beamhop is licensed under the **GNU Affero General Public License v3.0 or later**
([LICENSE](LICENSE)). It is also offered under a commercial license, so contributions are
accepted under the Developer Certificate of Origin (DCO) to keep that possible.

Every source file starts with the license identifier, in the file's comment style:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
```

```svelte
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
```

Vendored code (for example `packages/relay/src/vendor`) and the upstream Flotilla files in
`packages/team-client` keep their own license headers; `scripts/ci/spdx-check.ts` skips them.
`bun scripts/ci/spdx-check.ts --fix` adds missing headers.

### Developer Certificate of Origin

By signing off a commit you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the
change, or otherwise have the right to submit it under the project's license. Sign off with
`-s`:

```bash
git commit -s -m "relay: explain why a message was rejected"
```

This adds a trailer with your name and email, which must match the commit author:

```
Signed-off-by: Ada Lovelace <ada@example.com>
```

The `dco` CI job checks every commit in a pull request. Forgot one? Fix the last commit with
`git commit --amend -s --no-edit`, or every commit on your branch with
`git rebase --signoff main`, then force-push.
