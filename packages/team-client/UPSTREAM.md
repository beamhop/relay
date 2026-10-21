# Upstream: Flotilla

`@beamhop/team-client` ("Beamhop Team") is a fork of
[coracle-social/flotilla](https://github.com/coracle-social/flotilla) (MIT, see `LICENSE-FLOTILLA`).

| | |
|---|---|
| Upstream commit | `10cf8244e3d21d98c5281add0b4655bdbcb97639` (2026-10-13, v1.13.0) |
| Imported in | commit "team-client: import Flotilla upstream 10cf8244 (MIT)" (pristine copy) |
| Not imported | `android/ ios/ electron/ fastlane/ fdroid/ website/ .gitea/ .husky/ .agents/ AGENTS.md skills-lock.json zapstore.yaml Dockerfile .dockerignore .ackrc .fdignore` (native/desktop/marketing; Beamhop ships the web build only) |
| Not tracked | upstream `.env` (repo-root `.gitignore`); replaced by `scripts/beamhop/env.mjs` |

## Where the Beamhop changes are

Beamhop-owned code (new files, AGPL-3.0-or-later):

- `src/beamhop/` — runtime glue: base-path helpers + `$app/*` shims, runtime env defaults
  (home relay = same-origin WebSocket), `config.json` loader, federation socket policy, theme,
  escrow banner, company sign-in (`features/sso.ts` + `sso-session.ts`, `TeamSessionGate`,
  `SsoButtons`), company directory (`features/directory.ts`, `Directory.svelte`), legal links
  (`features/links.ts`, `LegalLinks.svelte`), intranet relay hosts (`relay-url.ts`,
  `relay-url-patch.ts`), swipe rows with undo (`gestures/`, `SwipeRow.svelte`, `features/swipe-*.ts`,
  `features/hidden.ts`; gestures copied from the admin app), per-group outbound relays
  (`features/outbound.ts`: `GET /.well-known/beamhop/network`, Publisher wrapper,
  `GroupRelayNotice.svelte`), unit tests (`*.test.ts`).
- `src/routes/directory/+page.svelte` — new route, a thin wrapper around
  `src/beamhop/components/Directory.svelte`.
- `scripts/beamhop/` — `build.mjs` (static build), `dev.mjs`, `env.mjs` (build defaults),
  `vite-plugin.ts` (redirects upstream `$app/stores|state|navigation` imports to the shims;
  patches `isRelayUrl` in `@welshman/util` so trusted dotless intranet hosts such as
  `ws://relay:3334` work — the build warns if upstream changes that check), `logo.mjs`.
- `static/beamhop-logo.{svg,png}` — placeholder mark (source for generated PWA icons).

Upstream files touched (every change is marked with a `beamhop` comment; grep `beamhop`):

| File | Change |
|---|---|
| `package.json` | name/private/license, `build`/`dev` → Beamhop scripts (`build:upstream`, `dev:upstream` kept); dropped `husky`, `@capacitor/assets` (pulls sharp 0.32 with a native install script), `nostr-signer-capacitor-plugin` (GitHub dep, Android only), `packageManager` |
| `svelte.config.js` | `paths.base` from `BEAMHOP_BASE` (default `/app`), `relative: false`; alias stub for `nostr-signer-capacitor-plugin`; plausible removed from CSP |
| `vite.config.ts` | `beamhop()` plugin; PWA fallback under the base path; manifest `background_color` |
| `src/app.html` | icons via `%sveltekit.assets%`; plausible analytics script removed |
| `src/app/core/env.ts` | `env()` passes through `beamhopEnv()`; `DUFFLEPUD_URL` configurable |
| `src/app/ui/app.css` | imports `src/beamhop/theme.css`; `@config` path fix for tailwind ≥ 4.3.3 |
| `src/app/ui/theme.ts` | `beamhop` theme listed; dark-first default |
| `src/routes/+layout.svelte` | `import "@src/beamhop"` (after policies), `<BeamhopOverlay />` (escrow notice + company sign-in), manifest href |
| `src/app/components/Landing.svelte` | legal links from config.json via `<LegalLinks />` (hidden when absent; unused `Link`/`PLATFORM_TERMS`/`PLATFORM_PRIVACY` imports dropped); `<SsoButtons />` |
| `src/app/components/PrimaryNav.svelte` | `<DirectoryNavItem />` (desktop + mobile nav) |
| `src/app/components/RoomTranscript.svelte` | messages wrapped in `<MessageSwipeRow>` (swipe: reply / hide / remove / remove person); hidden messages filtered out |
| `src/app/components/RoomItemMenu.svelte` | `<MessageMenuItems>` (Hide, Remove person: desktop parity for the swipe actions) |
| `src/app/components/HomeInbox.svelte` | rows wrapped in `<InboxSwipeRow>` (mark read / hide); hidden rows filtered out |
| `src/app/components/RoomChat.svelte` | `<GroupRelayNotice>` above the composer (per-group outbound relays, PLAN §12.10) |
| `src/app/core/session.ts`, `src/app/features/callEngine.ts`, `src/app/components/NewNotificationSound.svelte` | root-absolute asset/redirect paths prefixed with `base` |
| (many) | payment removal, see "No payments" below |

## No payments

Product rule (repo `CLAUDE.md` rule 9, `PLAN.md` §2): no Lightning, no cryptocurrency, no zaps, no
wallets, no payments of any kind. Upstream Flotilla has zaps, NWC/WebLN wallets, zap goals (NIP-75),
paid spaces (NIP-11 fees + `payments_url` checkout), paid relay hosting and Cashu/invoice tokens; all
of it is gone from the UI. Every upstream line touched for this carries a `beamhop: no-payments`
comment (`grep -rn "beamhop: no-payments"`), and `src/beamhop/no-payments.test.ts` (repo-root
`bun test`) fails if payment words reappear in `src/`, `static/` or `scripts/beamhop/` on an unmarked
line, if a deleted route/module comes back, if a Lightning SDK is re-added, or (when
`packages/team-client/build` exists) if payment UI strings or routes are in the bundle.

How the payment event kinds render now:

- **9734 zap request / 9735 zap receipt**: never requested (removed from `EVENT_CONTEXT_KINDS`,
  `REACTION_KINDS` and home-notification kinds), so no zap pills, no "zapped this", no Zaps filter. A
  quoted one falls through `NoteContent`/`NoteContentMinimal` to plain `Content` (its text content).
- **9041 zap goal**: removed from `CONTENT_KINDS` (not synced, no Goals section or route, no
  "Funding Goal" composer entry); a quoted one renders as plain content text.
- **Lightning invoices / Cashu tokens in text**: rendered as their raw text (no copy-token button, no
  `lightning:` link); summaries show the raw text instead of "a lightning invoice"; the composer's
  bolt11 node is disabled (`bolt11: false`).

Deleted upstream files (merge conflicts on these: keep them deleted):

- Features: `src/app/features/{lightning,goals,hosting,payments}.ts`
- Components: `Zap`, `ZapButton`, `ZapForm`, `InfoZapperError`, `RoomItemZapButton`, `Wallet*` (6),
  `Goal*` (6), `NoteContentGoal`, `NoteContentMinimalGoal`, `ContentToken`, `SpacePaymentGate`,
  `SpacePrice`, `HomeHosting`, `hosting/*` (15) under `src/app/components/`
- Routes: `src/routes/settings/{wallet,hosting}`, `src/routes/spaces/create` (paid-hosting plan
  picker), `src/routes/spaces/[relay]/{goals,goals/[id],admin}` (admin = hosted-relay billing)
- `static/fonts/Satoshi Symbol.ttf`
- e2e tests for removed features: US-050 (`community.spec.ts`), US-091 (`settings.spec.ts`), US-115
  (`rooms.spec.ts`), US-098..102 + US-122 (`admin.spec.ts`)

Upstream files edited (all marked `beamhop: no-payments`):

| File | Change |
|---|---|
| `package.json` | dropped `@getalby/lightning-tools`, `@getalby/sdk` (no comment possible in JSON) |
| `src/app/core/env.ts` | `ENABLE_ZAPS`, `ENABLE_PAID_SPACES`, `HOSTING_BACKEND_URL`, `HOSTING_RELAY_DOMAIN` removed (and the now-unused `Capacitor` import) |
| `src/app/core/nip46.ts` | `ZAP_REQUEST` (9734) dropped from the requested `sign_event` permissions |
| `src/app/core/session.ts` | legacy session `wallet` no longer imported into a wallet store |
| `src/app/core/settings.ts` | `zap_amounts` setting and `zapAmounts` store removed |
| `src/app/core/storage.ts` | Zappers cache no longer persisted; `zappers` table kept in `TABLES` so the IndexedDB schema is unchanged |
| `src/app/features/access.ts` | `derivePaidGated`, `pendingCheckouts`, `openCheckout`, `reconcileSpaceMembership` removed |
| `src/app/features/content.ts` | `ZAP_RECEIPT` out of `EVENT_CONTEXT_KINDS`/`REACTION_KINDS`, `ZAP_GOAL` out of `CONTENT_KINDS` and nouns |
| `src/app/features/editor/index.ts` | `bolt11: false` (no invoice node in the composer) |
| `src/app/ui/notifications.ts` | no zap receipts in home notifications; "Zaps" type/filter removed |
| `src/app/ui/render.ts` | Cashu/invoice summarize as their raw text |
| `src/app/ui/routes.ts`, `src/app/ui/title.ts` | goal route/path helper and wallet/hosting/goals/admin/space-create titles removed |
| `src/app/components/Content.svelte`, `ContentMinimal.svelte` | Cashu/invoice tokens rendered as plain text (was `ContentToken` copy button) |
| `src/app/components/NoteContent.svelte`, `NoteContentMinimal.svelte` | no `ZAP_GOAL` renderer (falls through to plain content) |
| `src/app/components/ReactionSummary.svelte` | zap receipts not validated or shown; `hideZaps` prop removed |
| `src/app/components/ContentActions.svelte`, `EventActions.svelte`, `EventReactButtons.svelte` | zap button and `hideZap` prop removed |
| `src/app/components/RoomItem.svelte`, `RoomItemMenuMobile.svelte` | zap hover button / zap tile removed |
| `src/app/components/HomeNetworkNotificationItem.svelte`, `HomeNetworkNotificationFilters.svelte` | "zapped this" reason and Zaps filter removed |
| `src/app/components/ComposeMenu.svelte` | "Funding Goal" entry removed |
| `src/app/components/SpaceMenuNavItems.svelte` | Goals section removed |
| `src/app/components/SpaceMenuActions.svelte` | payment gate on join, "Manage membership" (checkout) and "Hosting settings" removed |
| `src/app/components/SpaceResult.svelte` | paid spaces use the normal join flow |
| `src/app/components/SpaceAdd.svelte` | "Create a space" (the paid-hosting plan picker) removed |
| `src/app/components/MenuSettings.svelte`, `src/routes/settings/+layout.svelte` | Wallet and Hosting settings entries removed |
| `src/routes/settings/about/+page.svelte` | "Donate / Zap the Developer" card removed |
| `src/routes/home/+page.svelte` | hosting card removed |
| `src/routes/+layout.svelte` | no `wallet.ready` at boot |
| `src/routes/spaces/[relay]/+layout.svelte` | no payment-gate modal for paid relays |
| `src/routes/spaces/[relay]/about/+page.svelte` | "Payment Required" badge removed |
| `src/lib/currency.ts`, `src/lib/components/CurrencySymbol.svelte`, `src/lib/components/base.css` | SAT/BTC currency options, the sats glyph and its font removed; default currency USD; unknown codes show the code |
| `src/app/components/CurrencyInput.svelte`, `ClassifiedEdit.svelte`, `ClassifiedForm.svelte`, `ClassifiedItem.svelte`, `NoteContentClassified.svelte` | classified listings default to USD instead of SAT; no BTC/SAT suggestions |
| `e2e/specs/notifications.spec.ts`, `articles-threads.spec.ts` | hover-action order without zap (reply is `nth(1)`); no Zaps filter assertion |
| `e2e/specs/content-rendering.spec.ts` | US-067 now asserts an invoice is plain text (no button, no `lightning:` link) |

Beamhop-owned: `scripts/beamhop/env.mjs` no longer sets `VITE_HOSTING_*`.

Left in place on purpose: vendored `@welshman/*` protocol code (kind constants, `Zappers`/`ZapGoals`
classes, the content parser's Cashu/invoice token types) is bundled but unused by the UI; the
room-icon picker still lists generic `wallet`/`bolt` glyphs from `src/assets/icons/`; the e2e
harness keeps its (now unused) hosting/WebLN/zapper mocks; `e2e/USER_STORIES.md` and upstream docs
still describe the removed stories; `pnpm-lock.yaml` (upstream, unused by Beamhop) still lists the
dropped `@getalby/*` packages.

## How to pull upstream changes

```bash
SHA=<new upstream commit>
curl -L https://codeload.github.com/coracle-social/flotilla/tar.gz/$SHA | tar -xz -C "$TMPDIR"
UP="$TMPDIR/flotilla-$SHA"
# 1. Diff old vs new upstream and apply it on top of this package (3-way, keeps our edits):
curl -L https://codeload.github.com/coracle-social/flotilla/tar.gz/10cf8244e3d21d98c5281add0b4655bdbcb97639 | tar -xz -C "$TMPDIR"
git diff --no-index --binary "$TMPDIR/flotilla-10cf8244e3d21d98c5281add0b4655bdbcb97639" "$UP" \
  | sed "s#$TMPDIR/flotilla-[0-9a-f]*/##g" > upstream.patch
git apply -3 --directory=packages/team-client --exclude='android/*' --exclude='ios/*' \
  --exclude='electron/*' --exclude='fastlane/*' --exclude='fdroid/*' --exclude='website/*' upstream.patch
# 2. Resolve conflicts (only in the files listed above), update the SHA in this file.
# 3. Re-check: no new root-absolute asset paths (grep -rn '"/[a-z-]*\.\(mp3\|png\)"' src),
#    no new third-party hosts in src/app/core/env.ts, then:
bun run build && bun run check   # in packages/team-client
```

Simpler alternative for small upstream ranges: `git format-patch` from a Flotilla clone and
`git am --directory=packages/team-client -3`.

## Runtime configuration (served by Beamhop)

`<base>/config.json` (default `/app/config.json`), all keys optional:

```json
{
  "allowedRelays": [],
  "features": {"sso": false, "escrowNotice": false, "directory": false},
  "escrowNotice": false,
  "sso": {"providers": [{"id": "okta", "label": "Okta", "startUrl": "/api/v1/sso/okta/start?audience=team"}]},
  "links": {"terms": "https://example.com/terms", "privacy": "https://example.com/privacy"}
}
```

- `features.sso` + `sso.providers`: "Sign in with …" buttons (same-origin start URLs only). After the
  IdP, `POST /api/v1/team/session` decides: `managed` → NIP-46 login through Beamhop's bunker;
  `self-custody` → the person's NIP-07/NIP-46 signer, pubkey must match; `link-required` →
  `GET /api/v1/team/link` challenge, signed (kind 22242) and `POST`ed, then the session again.
- `escrowNotice` (top level or under `features`): DM escrow disclosure banner.
- `features.directory`: Directory screen at `<base>/directory` from `GET /api/v1/team/directory`.
- `links.terms` / `links.privacy`: legal links on the welcome screen; hidden when absent
  (build-time fallback `VITE_PLATFORM_TERMS` / `VITE_PLATFORM_PRIVACY`).

- `allowedRelays`: extra relays the client may connect to. Empty (default) = home relay only.
  Build-time equivalent: `VITE_BEAMHOP_ALLOWED_RELAYS` (CSV).
- Home relay: same-origin WebSocket (`wss://<host>/`), or `VITE_BEAMHOP_HOME_RELAY` at build time.
- Base path: `BEAMHOP_BASE` at build time (default `/app`, `""` for the domain root).
