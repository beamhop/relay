---
title: Enabling, disabling and publishing
description: How beamhop plugins are enabled and disabled at runtime without a restart, what happens on each transition, and how to publish one to npm.
sidebar:
  order: 12
---

## Disabled by default

Every discovered plugin starts **disabled**. Disabled means `setup()` never runs: no hooks, routes, jobs or
migrations. The module is still imported at boot, to read its name, version and settings schema.

## Enabling and disabling

All of these take effect immediately, without a restart:

- **Admin → Plugins** in the panel. The choice is stored in the database.
- The admin API: `POST /admin/api/plugins/<name>/enable` or `/disable` (needs `plugins.manage`).
- `plugins.enabled` in the config, or `BEAMHOP_PLUGINS_ENABLED=hello,spam-filter`. This only sets the **default**
  for plugins that have no stored choice yet; the panel can override it.

```sh
curl -b cookies.txt -X POST -H 'X-Requested-With: beamhop' \
  https://relay.example.com/admin/api/plugins/spam-filter/enable
```

On success the response is the plugin's `PluginInfo`; if setup fails, the call answers with an error and the
plugin's status is `error`:

```ts
interface PluginInfo {
  name: string;
  version: string;
  description: string;
  source: "npm" | "local";
  enabled: boolean;
  status: "running" | "disabled" | "error";
  error?: string;
  settingsSchema?: Record<string, unknown>;   // JSON Schema of the settings
  uiUrl?: string;                             // admin UI bundle, if any
}
```

`GET /admin/api/plugins` lists them all (needs `plugins.view`). Enable, disable and settings changes are recorded in
the audit log, failed enables included.

## What happens on enable

1. Pending [migrations](/relay/build/plugin-migrations/) are applied.
2. Settings are loaded (stored values, or the schema's defaults).
3. `setup(ctx)` runs, with a 30 s budget.
4. On success the status becomes `running`, and only then is `enabled` stored.

If a migration fails, `setup()` throws or the budget runs out, the status becomes `error` with the message, everything
the plugin registered so far is removed, and `teardown()` is called. A setup that keeps running in the background
after its budget can't register anything anymore: late registrations are undone at once. The server is unaffected.

Disabling a plugin while it is still setting up cancels the setup.

## What happens on disable

1. Its jobs stop being scheduled, and a run in progress is awaited (bounded).
2. `teardown()` runs, with a 5 s budget.
3. Everything registered through `ctx` is removed: hooks, public and admin routes, bus listeners, settings listeners.
4. The admin panel unloads its UI bundle.

Events that were already going through the pipeline finish with the hooks they started with. The plugin's tables
and stored settings stay, so enabling it again picks up where it left off.

At shutdown, plugins are torn down the same way (without changing their stored `enabled` state), before the database
closes, so `teardown()` can still write.

## Publishing a plugin

- Name the package `beamhop-plugin-<name>` (or `@you/beamhop-plugin-<name>`) and add the keyword `beamhop-plugin`.
- Put `@beamhop/sdk` and `zod` in `peerDependencies`, or in `devDependencies` if you only import types.
- Ship compiled JavaScript, plus `dist/ui.js` if you have an admin UI.

Users install your package next to beamhop, list it in `plugins.packages` (or `BEAMHOP_PLUGINS`), restart, and
enable it in the panel:

```json title="beamhop.config.json"
{
  "plugins": {
    "packages": ["beamhop-plugin-foo"]
  }
}
```

npm auto-discovery of `beamhop-plugin-*` packages exists (`plugins.autoDiscoverNpm`), but it is off by default:
any dependency with such a name would run inside the relay. Listing packages explicitly is the safer habit to
recommend to your users.

See the [configuration reference](/relay/config/reference/) for every `plugins.*` option.
