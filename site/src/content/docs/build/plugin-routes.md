---
title: HTTP routes
description: Serve public pages and APIs at /plugins/<name>/ and admin-only APIs at /admin/api/plugins/x/<name>/ from a beamhop plugin.
sidebar:
  order: 7
---

Every plugin gets two [Hono](https://hono.dev) apps. You don't create or mount them; just add routes in `setup()`.

| App | Mounted at | Who can call it |
| --- | --- | --- |
| `ctx.http` | `/plugins/<name>/` | anyone |
| `ctx.adminHttp` | `/admin/api/plugins/x/<name>/` | signed-in admins with the `plugins.use` permission |

Routes are only served while the plugin is running. A disabled plugin's paths answer `404`.

## Public routes

```ts
ctx.http.get("/", (c) => c.json({ greeting: ctx.settings.get().greeting }));
ctx.http.get("/ping", (c) => c.text("pong"));
```

With a plugin named `hello`, these answer at `/plugins/hello/` and `/plugins/hello/ping`. The prefix is stripped
before your app sees the request, so you register `/ping`, not `/plugins/hello/ping`. The query string is kept.

### Security defaults

Public plugin routes are served from the same origin as the admin panel. Script running in a plugin page could
call the admin API with an admin's cookie, so beamhop adds two headers to every response that doesn't set them:

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox
X-Content-Type-Options: nosniff
```

JSON and plain-text APIs are unaffected. If you serve a page that needs script, set a `Content-Security-Policy` of
your own — and never render untrusted HTML in it.

Other things to know:

- Public routes are anonymous. Request headers starting with `x-beamhop-admin-` are removed, so a client can't pose
  as the admin proxy.
- IP block rules apply: a blocked address gets `403` before your route runs.
- If a route does real work for anonymous callers, think about how it behaves under abuse (caps, caching).

## Admin routes

```ts
ctx.adminHttp.get("/stats", async (c) => {
  const recent = await ctx.db.all("SELECT id, pubkey, at, reason FROM plugin_hello_rejections ORDER BY at DESC LIMIT 20");
  return c.json({ recent });
});

ctx.adminHttp.post("/reset", async (c) => {
  await ctx.db.run("DELETE FROM plugin_hello_rejections");
  await ctx.audit.record({ actor: `plugin:${ctx.name}`, action: "hello.reset", target: null, details: {}, ip: null });
  return c.json({ ok: true });
});
```

These answer at `/admin/api/plugins/x/hello/stats` and `/admin/api/plugins/x/hello/reset`.

The admin API authenticates the request before it reaches your app, using the same rules as every other admin route
(session cookie or NIP-98; see [Admin API](/relay/build/admin-api/#authentication)). Then it:

- requires the `plugins.use` permission (owners, admins and moderators have it; viewers don't);
- removes the `Cookie` and `Authorization` headers;
- adds `x-beamhop-admin-pubkey` (the caller's hex pubkey) and `x-beamhop-admin-role` (`owner`, `admin` or
  `moderator`).

Use those headers when a route needs to know who called it, or to apply finer rules:

```ts
ctx.adminHttp.post("/purge", async (c) => {
  if (c.req.header("x-beamhop-admin-role") !== "owner") return c.json({ error: "owners only" }, 403);
  const actor = c.req.header("x-beamhop-admin-pubkey")!;
  // …
  return c.json({ ok: true });
});
```

Unlike the core admin API, plugin admin routes accept any request body format, so a route can take raw uploads.
The CSRF rule still applies: a cookie-authenticated `POST`, `PUT`, `PATCH` or `DELETE` must send
`X-Requested-With: beamhop`. The admin panel's `api.fetch` does this for you
(see [Admin UI extensions](/relay/build/plugin-admin-ui/)).

Request bodies are capped at 1 MiB by the admin API.

## Calling admin routes from a script

```sh
# with a session cookie from a password login
curl -b cookies.txt -H 'X-Requested-With: beamhop' -X POST \
  https://relay.example.com/admin/api/plugins/x/hello/reset
```

Or sign a NIP-98 event for the full URL and send it as `Authorization: Nostr <base64>`; NIP-98 requests need no
extra header.
