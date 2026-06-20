# Human TODO

Blockers and decisions that only a human (Yasin) can clear. Recorded during the 2026-06-20
grill so implementation work can proceed without pinging mid-way.

## Cross-org credentials — NOT a blocker (verified 2026-06-20)

Initially feared, then checked: `beamhop/relay` is **public** and Yasin is **admin** of the
`beamhop` org, so no cross-org credential is needed.

- Argo reads the public repo with **no creds**.
- Every existing tenant (music-manager, nostream) pulls its `ghcr.io/...` image with **no
  `imagePullSecret`** → GHCR packages are public and pulled anonymously. Same will apply here.
- CI runs *inside* `beamhop/relay` and uses that repo's own `GITHUB_TOKEN` (`packages: write`)
  to push to `ghcr.io/beamhop/relay`. No personal/cross-org token involved.

Remaining one-time manual step:

- [ ] On first image publish, set the `ghcr.io/beamhop/relay` **package visibility to public**
      (org admin), matching the other tenants. (Alternative: keep it private and add an
      `imagePullSecret` to the `relay` namespace — not the established pattern.)
- [ ] Add `https://github.com/beamhop/relay.git` to `sourceRepos` in
      `projects/beamhop-relay.yaml` (plain config, not a credential — done as part of the work).

## Platform-gitops changes (ADR-0006)

- [ ] Remove `platform/relay/` and `apps/children/application-relay.yaml` (the nostream
      Application) at cutover.
- [ ] Add `projects/beamhop-relay.yaml` (AppProject) + `tenants/beamhop-relay.yaml` (root
      Application → `beamhop/relay` `gitops/apps`).
- [ ] Keep the CNPG `Database` CR (`relay` in `cnpg-system`) and the relay secrets
      platform-managed; confirm the new Deployment references the existing secret names.
- [ ] Decide cutover timing (brief downtime: single pod, `Recreate`).

## Secrets

- [ ] Confirm the admin password / NIP-86 management pubkeys and DB credentials the production
      Deployment will consume, and that they exist as Secrets in the `relay` namespace.
- [ ] The in-repo Deployment (`gitops/apps/deployment.yaml`) reads the Postgres password from the
      existing **`relay-app` Secret, key `DB_PASSWORD`** (env `RELAY_POSTGRES_PASSWORD`); `user`,
      `host`, and `database` come from the `relay-config` ConfigMap. Confirm `relay-app` is
      retained at cutover (its nostream-only `SECRET` / `REDIS_PASSWORD` keys are unused here).
      If the credential moves to a different Secret/key, update the Deployment's `secretKeyRef`.

## Out of scope now (HA phase — ADR-0003)

- Multi-pod operation, Postgres `NOTIFY` or Redis pub/sub Broadcaster, shared moderation/admin
  state. Tracked here so it is not forgotten, not to be done in Phase 1.
