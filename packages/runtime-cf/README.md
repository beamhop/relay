# @beamhop/runtime-cf

Beamhop on Cloudflare: a Worker (HTTP, admin API, cron jobs), one `RelayRoom` Durable Object per
relay shard (WebSockets, hibernation), D1 for data and R2 for files. The deploy scaffold lives in
`deploy/cloudflare`; `npm create beamhop -- --cf` sets everything up.

## First sign-in (claim code)

A new relay has no owner. Whoever enters the one-time **claim code** in the admin app (`/admin/`)
becomes the owner.

- `npm create beamhop -- --cf` creates the code and prints it at the end of the setup.
- Otherwise the Worker creates it at first start and writes it **once** to the Worker log:
  run `npx wrangler tail` before opening the relay for the first time and look for
  `First run: your one-time claim code is …`.
- Lost it, or prefer your own? Set one as a secret (at least 8 characters), then open `/admin/`:

  ```bash
  npx wrangler secret put BEAMHOP_CLAIM_CODE
  ```

  The secret is only used while the relay has no owner; you can delete it afterwards
  (`npx wrangler secret delete BEAMHOP_CLAIM_CODE`). An existing unused code is never replaced
  automatically — only by this secret.

## Enterprise modules

`enterprise-compliance`, `enterprise-network`, `enterprise-identity` and `enterprise-keyvault`
run on Cloudflare too. They stay off until their `modules.<id>` section exists (same rule as on
the Bun server). Workers cannot load code at runtime, so the build bundles a package only when one
of its modules is configured in `beamhop.config.json`, or all of them with `--enterprise`
(`beamhop-cf-build … --enterprise`) so they can be switched on later from the admin app.

What differs from the Bun server:

| Feature | On Cloudflare |
|---|---|
| Legal holds, eDiscovery exports, approvals, usage reports | Same. Export files are stored in R2. |
| SIEM forwarding (Splunk, Sentinel, Chronicle, webhook) | Records are written to D1 during the request (kept alive with `waitUntil`) and sent by the one-minute Cron Trigger, with retries and back-off. Fastest interval is one minute. |
| SIEM over syslog | **Not available** (Workers cannot open raw TCP/UDP). Shown as a health warning. |
| Encryption at rest | Needs the key vault (or another key wrapper). Master key: `wrangler secret put BEAMHOP_MASTER_KEY` with `kek.keyEnv: BEAMHOP_MASTER_KEY`. |
| IP allow/deny lists | Checked in the Worker, before any Durable Object is contacted. The client address comes from `CF-Connecting-IP`; only a salted, daily-rotating hash is ever logged. |
| Proxy trust | `node.trustProxy` is ignored: Cloudflare forwards client-supplied headers, so proxy headers count only with a shared `proxySecret`. |
| Company-device certificates (mTLS) | **Not available** unless your own TLS proxy in front of Cloudflare passes the certificate with `mtls.proxySecret`. Otherwise the health page says so and such connections are refused. Cloudflare Access (`zeroTrust.provider: cloudflare-access`) works. |
| Per-group outbound relays (`/.well-known/beamhop/network`) | Same. Beamhop never forwards group posts to other relays itself; the team client enforces the list. |

## Tests

```bash
bun test packages/runtime-cf          # unit tests with fakes (part of `bun test`)
cd packages/runtime-cf && bun run test:workerd
```

`test:workerd` runs two suites inside workerd (via `@cloudflare/vitest-pool-workers`, with local
D1, R2 and Durable Objects; no network, no Cloudflare account):

- `test-cf/runtime.cf-spec.ts` — routing and hibernatable WebSockets.
- `test-cf/enterprise.enterprise-spec.ts` — boot with compliance, network, identity and key vault
  enabled; a legal hold keeping held posts and files; SIEM records sent to a mocked webhook from
  the cron trigger; a deny-listed address refused in the Worker; the claim code created and logged
  once.

`test:cf` is an alias. Local port binding is needed (workerd), so run it outside restrictive
sandboxes.
