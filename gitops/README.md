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

## Stays platform-managed (slim-platform split)

The cross-namespace shared bits live in `platform-gitops`, not here:

- the `relay` namespace,
- the CNPG `Database` CR (`relay` in `cnpg-system`) and the `relay` DB role,
- the secrets in the `relay` namespace. The Deployment reads the DB password from the
  `relay-app` Secret (key `DB_PASSWORD`); `user`/`host`/`database` come from `relay-config`.

No Redis (ADR-0003): live fan-out is in-process this phase.

## How a deploy reaches here

`.github/workflows/image.yml` builds `ghcr.io/beamhop/relay:<short-sha>` on every push to
`main`, then its **promote** job rewrites the `image:` line in `deployment.yaml` and commits the
bump back to `main`. Argo CD watches this path and rolls out the new SHA. Don't hand-edit the
image tag — let the workflow pin it. Commits confined to `gitops/**`, `docs/**`, or `*.md` skip
the rebuild (`paths-ignore`), and `GITHUB_TOKEN` pushes never retrigger workflows, so promote
commits can't loop.
