# Beamhop for organizations

You chose **Company / Organization** in the setup wizard. This page covers what that adds.
Nothing here is needed for any other kind of relay, and none of it is loaded until you turn
it on.

## What you get

- **Sign in with your company accounts** — Google Workspace, Microsoft Entra ID, or any OpenID
  Connect provider (Okta, Keycloak, Authentik, …). People and groups stay in sync; when someone
  leaves, their access ends at once.
- **Nostr keys for everyone** — people can link their own key, or Beamhop manages one for them
  (stored encrypted; your KMS or Vault can hold the master key).
- **Groups do the work** — map a directory group to which relays it can use, its limits, its
  admin role and its key type, in one table.
- **Team chat** — a Slack-like app at `/app` for employees; any Nostr app works too.
- **Compliance** — audit log streaming (syslog, Splunk, Sentinel, Chronicle, webhook), legal hold
  and export, retention per group, usage reports, two-person approval for sensitive actions.
- **Network controls** — IP allowlists, device certificates, running behind an identity-aware
  proxy, private-only mode.

## Set it up

1. Install Beamhop as in the [quickstart](quickstart.md) and pick **Company / Organization**.
2. The wizard asks for your identity provider and shows the exact values to paste into its app
   registration, then tests the connection.
3. Map your groups (People → Groups). Start with one group and the defaults.
4. Turn on more only when you need it: Settings shows compliance, approvals and network
   controls as suggestions, one at a time.

## Running it seriously

- **Backups and a standby server:** [operations](operations.md) and the
  [standby runbook](../deploy/ha/RUNBOOK.md) (target: lose at most a minute, back within five).
- **No internet access:** [air-gapped install](airgap.md).
- **Every setting and action:** [reference](reference/README.md); the admin API is described live
  at `/api/v1/openapi.json`.

All of this is open source under the AGPL like the rest of Beamhop. A commercial license is
available if the AGPL does not fit your organization.
