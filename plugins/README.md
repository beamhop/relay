# Writing beamhop plugins

A plugin is an ES module whose **default export** is a `BeamhopPlugin`, as defined in `@beamhop/sdk`.

```ts
import { definePlugin } from "@beamhop/sdk"; // or: import type { BeamhopPlugin } … and export a plain object
import { z } from "zod";

export default definePlugin({
  name: "word-guard",
  version: "1.0.0",
  description: "Rejects notes containing a word",
  settings: z.object({ word: z.string().default("spam") }),
  async setup(ctx) {
    ctx.hooks.onWrite((event) => {
      if (event.content.includes(ctx.settings.get().word)) return { action: "reject", reason: "blocked: bad word" };
    });
  },
});
```

The fastest way to start is to copy [`hello`](hello/src/index.ts), which uses every capability.
[`spam-filter`](spam-filter/src/index.ts) is a real-world example.

## Where plugins come from

| Source | Example |
| --- | --- |
| A subfolder of `plugins.dir` (default `./plugins`, env `BEAMHOP_PLUGINS_DIR`) | `plugins/my-plugin/package.json` plus its entry |
| A single file in `plugins.dir` | `plugins/my-plugin.ts` |
| Packages listed in `plugins.packages` / `BEAMHOP_PLUGINS` (relative paths resolve against the config file) | `bun add beamhop-plugin-foo`, then `"packages": ["beamhop-plugin-foo"]` |
| Only with `plugins.autoDiscoverNpm: true` / `BEAMHOP_PLUGINS_AUTO_DISCOVER=true`: every npm package named `beamhop-plugin-*` or `@scope/beamhop-plugin-*` in `node_modules` (the working directory and its parents, but not your home directory or `/`). Off by default, since a dependency with such a name would run inside the relay | `bun add beamhop-plugin-foo` |

For folders, the entry is resolved in this order:

1. `package.json` → `"beamhop": { "entry": "…" }`
2. `main`
3. `exports`
4. `module`
5. `index.ts`, `index.js`, `index.mjs`, `src/index.ts`, `src/index.js` or `dist/index.js`

Folders whose names start with `_` or `.` are ignored.

**Plugins are disabled by default.** "Disabled" means `setup()` never runs, so no hooks, routes or jobs are registered.
Every discovered plugin module is still *imported* at boot to read its name, version and settings schema, so its
top-level code runs. Only install plugins you trust, and keep side effects inside `setup()`.

**Plugins are not sandboxed.** They run in-process with the server's privileges: full database access
(`ctx.db`, including admin sessions and credentials), the key-value store (`ctx.kv`, where the generated relay
key and VAPID keys live), `process.env` (every `BEAMHOP_*` secret) and the filesystem. A plugin's admin UI bundle
runs in the admin panel's origin with the signed-in admin's session. `ctx.config` is a copy with the obvious
secrets removed (relay key, S3 credentials, VAPID private key, database password, OTel headers) — that keeps
them out of plugin logs and error reports; it is *not* an isolation boundary. Treat installing a plugin like
installing any other server software.

You can enable a plugin in any of these ways:

- in **Admin → Plugins**, which persists the choice
- by listing it in `plugins.enabled` / `BEAMHOP_PLUGINS_ENABLED`, which only sets the default
- with `POST /admin/api/plugins/<name>/enable` (or `/disable`)

Enabling and disabling takes effect immediately, without a restart.

> **Node compatibility:** On Node (≥ 22.18), `.ts` entries run through type stripping. This only works for files outside `node_modules`,
> and only with *erasable* TypeScript:
>
> - no `enum`, no parameter properties and no `namespace`
> - use `import type` for types
> - give relative imports explicit `.ts` extensions
>
> npm-published plugins should ship compiled `.js`. On Bun anything goes.

## The plugin context

`setup(ctx)` receives a `PluginContext`. Everything you register through it is **removed automatically when the plugin is disabled**.

| Member | What it does |
| --- | --- |
| `ctx.hooks.onWrite(fn, priority?)` | Write policy. Return one of: `{action:"accept"}`, `{action:"reject", reason}`, `{action:"shadow"}`, `{action:"replace", event}`, or nothing (no opinion). Lower priority values run first. |
| `ctx.hooks.onQuery(fn)` | Rewrites or rejects REQ/COUNT filters by returning `Filter[]` or `{reject}`. |
| `ctx.hooks.onVisibility(fn)` | Hides individual events from readers by returning `false`. |
| `ctx.hooks.onBlobUpload(fn)` | Accepts or rejects Blossom uploads. |
| `ctx.http` | A Hono app with public routes, mounted at `/plugins/<name>/`. They share the admin panel's origin, so responses without their own `Content-Security-Policy` get `default-src 'none'; frame-ancestors 'none'; sandbox` (no script). A page that needs script must set a policy of its own, and must never render untrusted HTML. |
| `ctx.adminHttp` | A Hono app mounted at `/admin/api/plugins/x/<name>/`. Requests need an admin session with the `plugins.use` permission. |
| `ctx.jobs.every(name, ms, fn)` | A periodic job. Errors are logged and the job keeps running. |
| `ctx.on(event, fn)` | Subscribes to bus events such as `event.accepted`, `event.rejected`, `connection.open`, `blob.uploaded` and `user.updated`. |
| `ctx.settings.get()` / `.onChange(fn)` | The plugin's settings, validated by its zod schema. |
| `ctx.metrics.counter/gauge` | Custom metrics. They appear in `/metrics` and the dashboard. |
| `ctx.db`, `ctx.events`, `ctx.users`, `ctx.kv`, `ctx.audit`, `ctx.relay`, `ctx.blossom` | Direct access to the server's services. |
| `ctx.logger` | A logger scoped to `plugin:<name>`. |

`teardown()` is optional. It runs on disable and at shutdown.

If `setup()` throws, the plugin is marked **error** and the error message is shown in the panel. The server keeps running.

### Settings

Settings are defined by a zod (v4) schema. The admin panel renders it as a form, using the JSON Schema produced by `z.toJSONSchema`.
Settings are validated on save, stored in the key-value store under `plugins/settings:<name>`, and delivered to `onChange` listeners.
Use `.default()` on every field so that a freshly enabled plugin starts with valid settings.
Mark credentials with `.meta({ format: "password" })` (or `writeOnly: true` / `"x-secret": true`). Marked fields — also inside
`.nullable()`, unions and shared definitions — and fields whose name looks like a credential (`apiKey`, `smtpPassword`, …;
an `…Auth` field only when its value looks like one, e.g. `proxyAuth: "user:pass"`, not `uploadAuth: "required"`) are
masked for admins without `plugins.manage` and in the audit log.

### Migrations

```ts
migrations: [{ id: "001_init", up: { sqlite: "CREATE TABLE plugin_x_…", postgres: "CREATE TABLE plugin_x_…" } }]
```

Migrations run on first enable as `db.migrate("plugin:<name>", migrations)` and are tracked per plugin.
`beamhop migrate` applies the migrations of *enabled* plugins only (enabled in the panel, or via `plugins.enabled` / `BEAMHOP_PLUGINS_ENABLED`) found in `plugins.dir` or `plugins.packages`. Auto-discovered npm `beamhop-plugin-*` packages are not loaded. Disabled plugins get their migrations when they are first enabled.
Prefix your table names with `plugin_<name>_`.

## Admin UI extensions

Set `ui` to a prebuilt **ESM bundle**. The path is relative to the package root, for example `ui: "./dist/ui.js"`.
The server serves the bundle at `/admin/plugins-ui/<name>.js`, and the panel imports it when the plugin is enabled.
The bundle's default export receives the `AdminUiPluginApi`:

```ts
export default function register(api) {
  api.registerPage({ path: "hello", title: "Hello", icon: "hand", component: HelloPage });
  api.registerWidget({ id: "hello-stats", title: "Hello", size: "sm", component: HelloWidget });
  api.registerUserAction({ id: "greet", label: "Say hello", run: (pubkey) => api.fetch("/greet", { method: "POST", body: pubkey }) });
}
```

`api.fetch(path)` calls your `ctx.adminHttp` routes with the admin's session.

### Using the host's React (the shim approach)

Do **not** bundle your own React. The panel exposes its React instance and shadcn components on `window.__BEAMHOP_UI__`:

```ts
{ React, ReactDOM, jsxRuntime, ui: { Button, Card, Badge, … }, toast }
```

The simplest approach, and the one `hello` uses, is a tiny host module that reads from that global.
JSX is compiled to its `h` function, so the bundle contains **no `import "react"`**. That means no bundler externals or import maps are needed:

```ts
// ui/host.ts
const host = (globalThis as any).__BEAMHOP_UI__;
export const h = host.React.createElement;
export const Fragment = host.React.Fragment;
export const { useState, useEffect } = host.React;
export const ui = (name: string, fallback: string) => host.ui?.[name] ?? fallback;
```

```jsonc
// ui/tsconfig.json
{ "compilerOptions": { "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" } }
```

```tsx
// ui/index.tsx
import { h, useState, ui } from "./host";
const Button = ui("Button", "button");
function Page() { const [n, setN] = useState(0); return <Button onClick={() => setN(n + 1)}>clicked {n}</Button>; }
export default function register(api) { api.registerPage({ path: "demo", title: "Demo", component: Page }); }
```

Build the bundle with:

```sh
bun build ./ui/index.tsx --outfile ./dist/ui.js --format esm --target browser --minify
```

In this repo, run `bun run build:plugins`.

(The panel also provides an import map for `react`, `react-dom`, `react/jsx-runtime` and `@beamhop/ui`. If you prefer real imports,
mark those modules as `--external`. The shim approach works regardless.)

## Publishing

- Name the package `beamhop-plugin-<name>` (or `@you/beamhop-plugin-<name>`) and add the keyword `beamhop-plugin`.
- Put `@beamhop/sdk` and `zod` in `peerDependencies`, or in `devDependencies` if you only use types.
- Ship compiled JS plus `dist/ui.js`.
- Users install your package next to beamhop and list it in `plugins.packages` / `BEAMHOP_PLUGINS` (npm auto-discovery
  of `beamhop-plugin-*` packages is off unless they set `plugins.autoDiscoverNpm`), then enable it in the panel.
