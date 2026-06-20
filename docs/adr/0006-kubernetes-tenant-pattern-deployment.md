# ADR-0006 — Deploy via the platform tenant pattern; slim platform split

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context source:** Grill session 2026-06-20

## Context

The relay currently runs on the platform-gitops cluster at `relay.beamhop.com` as **nostream**,
with its k8s manifests living **inside** platform-gitops at `platform/relay/` (platform-managed)
and wired by `apps/children/application-relay.yaml`. That deployment already provisions a CNPG
`relay` database (in `cnpg-system`), an in-namespace Redis cache, the ingress, and a TLS cert.

We are replacing nostream with this repo's relay, and moving to the **tenant pattern** used by
music-manager: the app's k8s config lives in the app's **own repo** under `gitops/apps/`, and
platform-gitops carries only a thin `projects/<name>.yaml` (AppProject) + `tenants/<name>.yaml`
(root Application pointing at the repo). This is the thin-waist contract
(platform-gitops ADR-0001).

The wrinkle versus music-manager: the relay needs a CNPG `Database` CR and DB-credential /
app secrets that live in `cnpg-system` and the `relay` namespace. A pure namespace-scoped
tenant AppProject cannot write those.

## Decision

**Tenant pattern**, with a **slim platform** split:

- **In this repo (`beamhop/relay`):** `gitops/apps/` flat Kustomize dir owning the app
  workload — namespace, Deployment, Service, Ingress, Certificate, and the relay settings
  ConfigMap. Plus `.github/workflows/image.yml` mirroring music-manager (build → push GHCR →
  promote job pins the short-SHA into `gitops/apps/deployment.yaml` → Argo syncs).
- **In platform-gitops:** remove `platform/relay/` and `apps/children/application-relay.yaml`;
  add thin `projects/beamhop-relay.yaml` + `tenants/beamhop-relay.yaml`. Keep the
  cross-namespace / shared bits platform-side: the CNPG `Database` CR (in `cnpg-system`) and
  the relay secrets in their namespaces. The tenant consumes these by name.

**Phase 1 runtime:**

- Postgres SQL-native backend (ADR-0002), pointed at `shared-pg-rw.cnpg-system.svc.cluster.local`,
  db `relay`.
- **Single pod, `Recreate` strategy** (in-process broadcaster, ADR-0003 — multi-pod is unsafe
  until the HA phase).
- **No Redis** (ADR-0003).
- Namespace `relay`, host `relay.beamhop.com`, nginx ingress with WebSocket upgrade and long
  proxy timeouts (carried over from the nostream ingress).

## Consequences

- ✅ The relay's k8s config is owned and versioned in this repo, like the other tenants.
- ✅ DB provisioning and secrets stay in the proven platform sops/CNPG setup; minimal churn.
- ✅ Cutover is a single switch from the nostream Application to the new tenant Application.
- ✅ **No cross-org credentials needed** (verified 2026-06-20): `beamhop/relay` is public, so
  Argo reads it credential-free; existing tenants pull `ghcr.io/...` with no `imagePullSecret`
  (public packages), and CI pushes via the repo's own `GITHUB_TOKEN`. The only manual step is
  setting the `ghcr.io/beamhop/relay` package public on first publish (org admin). See
  `docs/HUMAN-TODO.md`.
- ⚠️ Brief downtime at cutover (single pod, `Recreate`). Acceptable for the current phase.
- ➡️ Multi-pod HA, shared state, and Redis/NOTIFY fan-out are a later phase (ADR-0003).
