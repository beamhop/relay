---
title: Settings
description: Define plugin settings with a zod schema, get an admin form for free, react to changes and keep secrets masked.
sidebar:
  order: 9
---

Give your plugin a `settings` schema and beamhop does the rest: the admin panel renders a form, values are validated
on save and stored in the database, and your plugin reads them through `ctx.settings`.

## Defining settings

Settings are a [zod](https://zod.dev) **v4** schema:

```ts
import { z } from "zod";

const Settings = z.object({
  kinds: z.array(z.number().int()).default([1, 1111, 42, 9802, 30023]).describe("Kinds to score (empty = all non-ephemeral kinds)"),
  threshold: z.number().min(0.1).default(1).describe("Score at which an event is considered spam"),
  action: z.enum(["reject", "shadow"]).default("reject").describe("reject = OK false; shadow = pretend success but drop"),
  exemptAdmins: z.boolean().default(true).describe("Skip pubkeys with an admin role"),
});

const plugin: BeamhopPlugin<typeof Settings> = {
  name: "spam-filter",
  version: "0.1.0",
  settings: Settings,
  setup(ctx) {
    ctx.settings.get().threshold; // typed as number
  },
};
```

- **Give every field a `.default()`.** A freshly enabled plugin starts from `schema.parse({})`. If a required field
  has no default, enabling fails with "plugin settings have required fields without defaults".
- **Use `.describe()`.** The description is shown as help text in the form.
- Constraints like `.min()`, `.max()`, `.int()` and `z.enum()` are enforced on save and show up in the form.

The panel builds its form from the JSON Schema that `z.toJSONSchema` produces. Strings, numbers, booleans, enums,
arrays of primitives, nested objects and nullable fields get proper inputs; anything else falls back to a JSON
editor. Secret fields (below) render as password inputs.

## Reading settings

```ts
settings: {
  get(): S;
  onChange(fn: (s: S) => void | Promise<void>): () => void;
}
```

`ctx.settings.get()` is cheap: call it whenever you need a value instead of copying settings into variables at setup
time. Then a change takes effect on the next call, with no extra code.

Use `onChange` when a change needs work, like restarting a job with a new interval or rebuilding a cache:

```ts
const off = ctx.settings.onChange((s) => {
  matcher = buildMatcher(s.words);
});
```

Listeners are removed on disable. A listener that throws (or rejects) is logged and doesn't affect the save.

## How saving works

1. An admin with `plugins.manage` submits the form (`PATCH /admin/api/plugins/<name>/settings` with `{ values }`).
2. `values` is parsed with your schema. Invalid input is refused with `400` and the zod issues.
3. The parsed result — defaults filled in, unknown keys dropped — is stored in the key-value store under namespace
   `plugins`, key `settings:<name>`.
4. `onChange` listeners get the new value, and the change is recorded in the audit log.

`values` is the complete settings object, not a patch: a field you leave out goes back to its default.

If stored settings no longer match the schema (say, after you tightened a constraint in a new version), the plugin
logs a warning and falls back to the defaults.

## Secrets

Mark credentials so viewers and the audit log never see them:

```ts
const Settings = z.object({
  apiUrl: z.string().default(""),
  apiKey: z.string().default("").meta({ format: "password" }),
});
```

`writeOnly: true` or `"x-secret": true` in `.meta()` work too. Values are masked:

- for admins who have `plugins.view` but not `plugins.manage` (moderators and viewers);
- in the audit log entry for every settings change.

Fields are also masked when their **name** looks like a credential (`apiKey`, `smtpPassword`, …), and marked fields are
found inside `.nullable()`, unions and shared definitions. A field named `…Auth` is only masked when its value looks
like a credential (`proxyAuth: "user:pass"`), not for something like `uploadAuth: "required"`.

Masking is about what other admins see. It doesn't encrypt anything: the value is stored as-is in the database.

## Settings from outside the panel

The same routes the panel uses work from scripts (see [Admin API](/relay/build/admin-api/)):

```sh
# read: { values, schema }
curl -b cookies.txt https://relay.example.com/admin/api/plugins/spam-filter/settings

# write: the full settings object
curl -b cookies.txt -X PATCH \
  -H 'X-Requested-With: beamhop' -H 'Content-Type: application/json' \
  -d '{"values":{"threshold":1.5,"action":"shadow"}}' \
  https://relay.example.com/admin/api/plugins/spam-filter/settings
```
