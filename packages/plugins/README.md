# Writing a Beamhop plugin

A plugin is a small set of **policy hooks** that look at activity on your relay
(new posts, subscriptions, uploads…) and decide: let it through, refuse it, hide
it quietly, or hold it for review.

## 1. Write it

```ts
// beamhop-plugin-no-links/index.ts
import { definePlugin, reject } from '@beamhop/plugins/sdk';
import { z } from 'zod';

export default definePlugin({
  id: 'no-links',                 // config id; hook id becomes `plugin.no-links`
  name: 'No links from newcomers',
  description: 'Refuse posts with links unless the author is on the allowlist.',
  version: '1.0.0',
  permissions: [],                // 'read-events' | 'write-events' | 'network' | 'docs'
  configSchema: z.object({ allow: z.array(z.string()).default([]) }),
  hooks: {
    onEvent(event, ctx) {
      if (ctx.config.allow.includes(event.pubkey)) return;        // nothing = accept
      if (/https?:\/\//.test(event.content)) return reject('blocked', 'links are not allowed yet');
    },
  },
});
```

Shorthand: hooks may sit at the top level, and `version`, `permissions` and
`configSchema` may be left out:

```ts
export default definePlugin({ id: 'quiet', name: 'Quiet', description: '…',
  onEvent(e) { if (e.content.length > 5000) return reject('invalid', 'too long'); } });
```

**Hooks**: `onConnect(ctx)`, `onAuth(pubkey, ctx)`, `onEvent(event, ctx)`,
`onReq(filters, ctx)`, `onUpload(info, ctx)`, `onBlobServe(sha256, ctx)`.
Return nothing (accept), `reject(prefix, message)`, `shadow()` or `hold()`.

**Context** (plain data): `{ relayId, now, tier?, dryRun?, conn?: { id, ipHash, authed[] }, config, api }`.

**api**: `clock.now()/nowMs()`, `log()`, `state` (per-instance Map),
`events.query/count` (`read-events`), `events.save` (`write-events`),
`docs.get/put/delete/list` (`docs`, stored in collection `plugin.<id>`),
`fetch` (`network`). Calling something you did not ask for throws.

Need per-instance state (caches, counters)? Pass a factory:
`hooks: (api) => { const seen = new Map(); return { onEvent(e) { … } }; }` —
it runs again on every reload.

## 2. Test it

```ts
import { expect, test } from 'bun:test';
import { createPluginTestbed, expectReject } from '@beamhop/plugins/testing';
import plugin from './index.ts';

test('refuses links', async () => {
  const tb = await createPluginTestbed({ plugin, config: { allow: [] } });
  expectReject(await tb.event({ content: 'see https://x.example' }), 'blocked');
  expect((await tb.event({ content: 'hi' })).action).toBe('accept');
  tb.ports.clock.advance(60);                  // FakeClock
  await tb.store({ kind: 3, tags: [['p', tb.key.pk]] });   // seed data
});
```

The testbed is a real kernel with in-memory storage running your plugin through
the same host as production. Also: `tb.req()`, `tb.upload()`, `tb.connect()`,
`tb.auth()`, `tb.blobServe()`, `tb.configure()`, `tb.status()`; pass `fetch`
to fake the network. `createTestbed(plugin)` (from `@beamhop/plugins/testbed`)
is a synchronous shorthand.

## 3. Run it

```yaml
plugins:
  - id: no-links            # npm package beamhop-plugin-no-links, or…
    enabled: true
    config: { allow: [] }
modules:
  plugins:
    entries:
      no-links:
        source: file:./plugins/no-links/index.ts   # local file (dev)
        failMode: open        # open = let traffic through if it breaks; closed = block
        timeBudgetMs: 20      # per call, sandboxed plugins
    hotReload: true           # reload local files on save
```

- **Sandbox (Bun)**: plugins that are not built in run in a Worker with an empty
  environment. Each call has a time budget (20 ms default); a stuck worker is
  killed and restarted; `maxMemoryMb` restarts a worker that grows too large
  (soft limit: Bun has no hard per-worker heap cap). `trusted: true` runs a
  plugin in-process instead (full speed, no limits — only for code you trust).
- **Safety switch**: after `breaker.threshold` (5) failures in a row the plugin
  is turned off automatically and an attention card offers to turn it back on or
  remove it. This is the one thing Beamhop does without asking — to keep your
  relay up. `beamhop --safe` starts with every plugin off.
- **Cloudflare**: plugins are compiled in at deploy time (`createBundledPluginHost(importMap)`);
  nothing is downloaded or evaluated at runtime.

## 4. Publish it

Publish to npm as `beamhop-plugin-<id>` and get it into a catalog. A catalog is
a Nostr event (kind 30078, `d` tag `beamhop-plugin-catalog`) whose content lists
`{ id, package, version, integrity, description, permissions, minBeamhop }`;
sign it with `signCatalog(catalog, secretKey)`. Admins trust catalog keys in
`modules.plugins.catalogPubkeys`; installs verify both the signature and the
tarball's integrity hash.

## Webhooks

`modules.webhooks.hooks: [{ id, url, events: ['blob.uploaded', …], filter?: { kinds, authors }, secret }]`.
Each POST carries `X-Beamhop-Timestamp` and
`X-Beamhop-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<body>")` — check
it with `verifySignature()`. Failures retry with exponential backoff, then land
in the `webhooks.dead` collection. Private network targets are blocked unless
`allowPrivate: true`.
