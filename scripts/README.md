# Maintainer scripts

| Script | What |
|---|---|
| `install.sh` | The installer behind `curl -fsSL https://get.beamhop.dev \| sh` (POSIX sh). |
| `release.ts` | Builds every target, writes `SHA256SUMS`, minisign signatures (`MINISIGN_KEY_FILE`), and `latest.json` for `beamhop update`. |
| `airgap-bundle.ts` | Offline bundle for networks without internet (see `docs/airgap.md`). |
| `test/` | `bun test` coverage for the above and `deploy/ha/failover.sh`. |

## Cutting a release

1. Optional: write `docs/releases/v1.2.3.md` (plain-language notes; shown by `beamhop update`).
2. `git tag -s v1.2.3 && git push --tags`.
3. `.github/workflows/release.yml` tests, builds, uploads a draft release, pushes the multi-arch
   image to GHCR, then publishes the release. `latest.json` becomes visible last, so
   `beamhop update` never sees a half-published release.

`get.beamhop.dev` is the Worker in `deploy/get.beamhop.dev/` (redirects to GitHub Releases).

## Known gap

The binary's version comes from `VERSION` in `packages/runtime-bun/src/server.ts` (hard-coded).
`release.ts` passes `--version` / `BEAMHOP_BUILD_VERSION` to the build; until the build embeds it,
`release.ts` warns, because `beamhop update` rejects a binary whose `--version` does not match.
