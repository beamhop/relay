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
  escrow banner, Wave 4 stubs (`features/sso.ts`, `features/directory.ts`), unit tests.
- `scripts/beamhop/` — `build.mjs` (static build), `dev.mjs`, `env.mjs` (build defaults),
  `vite-plugin.ts` (redirects upstream `$app/stores|state|navigation` imports to the shims),
  `logo.mjs`.
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
| `src/routes/+layout.svelte` | `import "@src/beamhop"` (after policies), `<EscrowNotice />`, manifest href |
| `src/app/core/session.ts`, `src/app/features/callEngine.ts`, `src/app/components/NewNotificationSound.svelte` | root-absolute asset/redirect paths prefixed with `base` |

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
  "features": {"sso": false, "escrowNotice": false, "directory": false}
}
```

- `allowedRelays`: extra relays the client may connect to. Empty (default) = home relay only.
  Build-time equivalent: `VITE_BEAMHOP_ALLOWED_RELAYS` (CSV).
- Home relay: same-origin WebSocket (`wss://<host>/`), or `VITE_BEAMHOP_HOME_RELAY` at build time.
- Base path: `BEAMHOP_BASE` at build time (default `/app`, `""` for the domain root).
