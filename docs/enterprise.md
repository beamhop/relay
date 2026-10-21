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

Choosing **Company / Organization** turns on company sign-in right away — no restart. You can
also switch each company feature on or off later, without a restart (each change is a settings
revision you can undo):

```sh
beamhop modules list
beamhop modules enable --id enterprise-identity     # company sign-in
beamhop modules enable --id enterprise-keyvault     # company-held keys
beamhop modules enable --id enterprise-compliance   # approvals, legal hold, reports
beamhop modules enable --id enterprise-network      # IP allowlists, device certificates
beamhop modules disable --id enterprise-network
```

**Master key for company-held keys.** When you turn on company-held keys, Beamhop uses the
master key in the `BEAMHOP_MASTER_KEY` environment variable (32 random bytes, base64 or hex). If
that variable is not set, it generates one once into `<data dir>/secrets/master.key` (readable
only by the Beamhop user) and points `modules.enterprise-keyvault.kek.keyFile` at it. **Back
this file up** with your data — without it, company-held keys cannot be recovered. You can move
to KMS or Vault later. On Cloudflare Workers set the key as a secret
(`wrangler secret put BEAMHOP_MASTER_KEY`); company features must be included in the Worker
bundle to be turned on there.

## Running it seriously

- **Backups and a standby server:** [operations](operations.md) and the
  [standby runbook](../deploy/ha/RUNBOOK.md) (target: lose at most a minute, back within five).
- **No internet access:** [air-gapped install](airgap.md).
- **Every setting and action:** [reference](reference/README.md); the admin API is described live
  at `/api/v1/openapi.json`.

All of this is open source under the AGPL like the rest of Beamhop. A commercial license is
available if the AGPL does not fit your organization.
