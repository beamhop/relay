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
| npm packages named `beamhop-plugin-*` or `@scope/beamhop-plugin-*` in `node_modules` | `bun add beamhop-plugin-foo` |
| Packages listed in `plugins.packages` / `BEAMHOP_PLUGINS` | `"packages": ["my-private-plugin"]` |

For folders, the entry is resolved in this order:

1. `package.json` → `"beamhop": { "entry": "…" }`
2. `main`
3. `exports`
4. `module`
5. `index.ts`, `index.js` or `src/index.ts`

Folders whose names start with `_` or `.` are ignored.

**Plugins are disabled by default.** You can enable one in any of these ways:

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
| `ctx.http` | A Hono app with public routes, mounted at `/plugins/<name>/`. |
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

### Migrations

```ts
migrations: [{ id: "001_init", up: { sqlite: "CREATE TABLE plugin_x_…", postgres: "CREATE TABLE plugin_x_…" } }]
```

Migrations run on first enable as `db.migrate("plugin:<name>", migrations)` and are tracked per plugin.
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
- Users install your package next to beamhop. It is discovered automatically and then enabled in the panel.
