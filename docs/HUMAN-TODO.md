# Human TODO

## Phase 1 cutover — DONE (2026-06-20)

`relay.beamhop.com` now runs **this** Bun/TypeScript relay (replacing nostream). Live, verified
end-to-end (publish / REQ / COUNT / NIP-11 / health / admin), serving real traffic.

How it is wired (so there is no future confusion):

- **Two Argo apps, by design** (tenant slim-split, ADR-0006):
  - `beamhop-relay` — the **workload** (this repo's `gitops/apps`: Deployment, Service, Ingress,
    Certificate, ConfigMap), project `beamhop-relay`, scoped to the `relay` namespace.
  - `relay-shared` — platform-side **shared infra only** (platform-gitops `platform/relay/`,
    project `default`): the `relay` namespace, the cnpg-system `Database` CR, and the secrets.
    A namespace-scoped tenant cannot own the cross-namespace Database CR, hence the split.
- **Storage:** SQL-native Postgres on the shared CNPG cluster, database `relay`. Our tables live
  in the **`beamhop` schema** (`storage.postgres.schema`), because the `relay` database is shared
  db-per-app and previously held nostream's `public.*` tables. nostream's `public.*` tables have
  been **dropped**; `beamhop` is our clean home.
- **Secrets:** `relay-app` (in `relay` ns) holds `DB_PASSWORD` + `ADMIN_PASSWORD` (the dead
  nostream keys `SECRET` / `REDIS_PASSWORD` were removed). `relay-db-credentials` (cnpg-system)
  holds the DB role password. The image `ghcr.io/beamhop/relay` is **public**.
- **Admin panel:** enabled (`--web`) at `https://relay.beamhop.com/admin`; password is
  `relay-app/ADMIN_PASSWORD` (retrieve with
  `sops -d platform/relay/secrets/gen.keep/relay-app.enc.yaml | grep ADMIN_PASSWORD`).

## Optional follow-ups

- [ ] Delete the obsolete nostream fork image `ghcr.io/yasinuslu/nostream` if it is no longer
      wanted (not referenced anywhere now).

## Out of scope now (HA phase — ADR-0003)

- Multi-pod operation, Postgres `NOTIFY` or Redis pub/sub Broadcaster, shared moderation/admin
  state. Tracked here so it is not forgotten, not to be done in Phase 1.
