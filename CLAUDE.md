# Beamhop — engineering conventions

Product plan: `PLAN.md` (read the sections relevant to your package). Contracts: `packages/core/src/*` — read `ports.ts`, `modules.ts`, `policy.ts`, `config.ts`, `actions.ts`, `bus.ts`, `auth.ts` before writing code.

## Stack (decided — do not substitute)
- Runtime: **Bun** (`bun test`, `bun:sqlite`) and **Cloudflare Workers** (Durable Objects, D1, R2). Core and feature packages must be runtime-agnostic: Web-standard APIs only (fetch, Request/Response, WebCrypto, ReadableStream). No `Bun.*`, `node:*`, or CF bindings outside `runtime-bun`, `runtime-cf`, and adapter packages that are explicitly runtime-specific.
- Validation/config: **zod 4** (`import { z } from 'zod'`). Object defaults use `.prefault({})`, not `.default({})`.
- HTTP: **Hono** via `kernel.http` (shared app). Use `@hono/zod-openapi` for documented API routes.
- Nostr primitives: `@beamhop/core` (event/filter/verify) and **nostr-tools** (nip19, nip42, nip44, nip46, nip59, nip98, …). NIP-77: vendor hoytech/negentropy JS (MIT) into `packages/relay/src/vendor/`.
- SQL: **Drizzle ORM** — sqlite schema shared by `bun:sqlite` and D1; separate pg schema for Postgres (`postgres` driver).
- Blobs: S3-compatible via `aws4fetch` (works on Bun and Workers); fs adapter Bun-only.
- Auth: `jose`, `@simplewebauthn/server`, `oauth4webapi`. SCIM: thin, hand-written over Hono.
- Media: `sharp` (Bun only, optional dependency), ffmpeg via `Bun.spawn` (optional); on CF use Cloudflare Images or skip.
- AI: Vercel AI SDK `ai` + `@ai-sdk/openai-compatible`.
- Admin PWA: SvelteKit (static adapter) + shadcn-svelte + superforms/formsnap + LayerChart + paraglide. Team client: fork of Flotilla (MIT) + `@welshman/*`.
- Backups/HA on VMs: Litestream (not LiteFS).
- Lint/format: Biome (`bunx biome check --write .`). Tests: `bun test`.

## Rules
1. **Every feature is a `BeamhopModule`** (`defineModule`) registered with the kernel. Core never imports feature packages. Disabled modules contribute nothing (isolation rule §12.0).
2. **Every admin operation is an action** in the `ActionRegistry` (`defineAction`) with plain-language `title`, `technical` lens text, `permission`, zod `input`, `preview()` diff for state changes, and `undo()` where feasible. Do not hand-write REST endpoints for admin operations — admin-api generates them.
3. **Plain language + technical lens**: user-facing strings are plain; NIP numbers/kinds go in `technical` fields.
4. **Contracts are frozen.** If you need a change in `packages/core` or `packages/testkit`, make the smallest additive change (new optional field/method), note it in your final report under "CORE CHANGES", and never break existing signatures.
5. **Tests**: unit tests use `@beamhop/testkit` memory adapters (`memoryPorts()`, `makeKey`, `makeEvent`). Adapters must pass the contract suites (`eventStoreContract`, etc.). No real network or external services in tests; mock with Hono apps or fetch stubs. Tests needing Docker are skipped unless an env var (e.g. `PG_URL`) is set.
6. Only touch your own package(s) plus additive core changes. Add deps only to your package's `package.json`. Do not commit `bun.lock`.
7. Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`. Commits use `git commit -s`.
8. Before finishing: `bun run typecheck && bunx biome check . && bun test` must pass for the whole repo.
9. Privacy: never log raw IPs (use `ports.crypto.hashIp`). No telemetry. No Lightning/crypto payments.
10. Mobile-first UI rules (PWA): ≤7 settings per simple screen, ≤3 taps for top tasks, swipe/undo patterns, full desktop parity.

## Layout
`packages/<name>/src/index.ts` exports the module (`export const xModule = defineModule({...})`) and public API. Tests in `packages/<name>/test/`.

## Running locally
```bash
bun install
bun test
bun run typecheck
```
