# gitops/ — deploy manifests for the beamhop relay

This folder is the **thin waist** between this repo and the `platform-gitops` cluster
(Hetzner k3s + Argo CD). The platform's root `Application` (`tenants/beamhop-relay.yaml` over
there) points at `gitops/apps/` and syncs whatever it finds; the platform never reaches deeper
than this folder (ADR-0006, slim-platform split).

`apps/` is a plain Kustomize directory:

| file               | what                                                                    |
|--------------------|-------------------------------------------------------------------------|
| `configmap.yaml`   | `relay-config` — the relay.yaml settings (postgres backend, host, db)    |
| `deployment.yaml`  | the `relay` Deployment — single pod, `Recreate`, image pinned to a SHA   |
| `service.yaml`     | ClusterIP `relay` :80 -> container :7777                                 |
| `certificate.yaml` | `relay-tls` cert for relay.beamhop.com (letsencrypt-prod ClusterIssuer)  |
| `ingress.yaml`     | `relay.beamhop.com`, WebSocket-friendly proxy timeouts                   |
| `kustomization.yaml` | ties them together under namespace `relay`                             |

## Two Argo apps — what's what (read this if confused)

The relay is split across **two** Argo Applications on purpose (tenant slim-split, ADR-0006):

- **`beamhop-relay`** — THIS folder. The relay **workload**: Deployment, Service, Ingress,
  Certificate, ConfigMap. Project `beamhop-relay`, scoped to the `relay` namespace.
- **`relay-shared`** — in `platform-gitops` (`platform/relay/`), project `default`. The
  cross-namespace **shared infra only**: the `relay` namespace, the CNPG `Database` CR (which
  lives in `cnpg-system`, so a namespace-scoped tenant can't own it), and the secrets.

They are NOT duplicates: `beamhop-relay` runs the relay, `relay-shared` holds the bits a tenant
can't manage. `relay-shared` must never be deleted with a resources-finalizer or it would prune
the database.

## Stays platform-managed (`relay-shared`)

- the `relay` namespace,
- the CNPG `Database` CR (`relay` in `cnpg-system`) and the `relay` DB role,
- the secrets. The Deployment reads the DB password from the `relay-app` Secret (`DB_PASSWORD`)
  and the admin password from `ADMIN_PASSWORD`; `user`/`host`/`database`/`schema` come from
  `relay-config`.

## Storage schema

The `relay` database is shared (db-per-app) and once held the previous relay's `public.*` tables,
so our tables live in a dedicated **`beamhop` schema** (`storage.postgres.schema` in
`configmap.yaml`). The old `public.*` tables have been dropped; `beamhop` is our clean home.

No Redis (ADR-0003): live fan-out is in-process this phase.

## How a deploy reaches here

`.github/workflows/image.yml` builds `ghcr.io/beamhop/relay:<short-sha>` on every push to
`main`, then its **promote** job rewrites the `image:` line in `deployment.yaml` and commits the
bump back to `main`. Argo CD watches this path and rolls out the new SHA. Don't hand-edit the
image tag — let the workflow pin it. Commits confined to `gitops/**`, `docs/**`, or `*.md` skip
the rebuild (`paths-ignore`), and `GITHUB_TOKEN` pushes never retrigger workflows, so promote
commits can't loop.
