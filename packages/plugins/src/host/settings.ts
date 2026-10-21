// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.plugins`: host-level settings. The per-plugin on/off switch
 * and plugin settings stay in core's `config.plugins[]`; `entries` holds how
 * the host runs each plugin (source, sandbox, budgets).
 */
import { example, labels, recommend, technical } from '@beamhop/core';
import { z } from 'zod';

export const PluginEntrySettingsSchema = z
  .object({
    /**
     * Where the code comes from: npm package name, `file:/abs/path.ts` or an
     * absolute/relative path. Default: built-in, then the installed record, then
     * `beamhop-plugin-<id>` from the plugins directory.
     */
    source: example(
      technical(
        z
          .string()
          .optional()
          .describe(
            'Where the plugin code comes from. Leave empty for built-in and catalog plugins.',
          ),
        'npm package name, file:/abs/path.ts or a path. Default: built-in, then the installed record, then beamhop-plugin-<id> in the plugins directory.',
      ),
      'file:/opt/beamhop/my-plugin.ts',
    ),
    /** Run in-process with full speed and no time budget. Built-ins are always trusted. */
    trusted: technical(
      z
        .boolean()
        .optional()
        .describe(
          'Run the plugin without safety limits for full speed. Only for code you fully trust; built-in plugins always are.',
        ),
      'In-process, no worker sandbox and no time budget.',
    ),
    /** What to do when the plugin errors or runs out of time: let traffic through or block it. */
    failMode: labels(z.enum(['open', 'closed']).default('open'), {
      open: 'Let posts through',
      closed: 'Block posts',
    }).describe(
      'What happens when the plugin breaks or is too slow. Block posts only if the plugin is a safety check you cannot do without.',
    ),
    /** Per-call time budget for sandboxed plugins (ms). */
    timeBudgetMs: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe(
        'How long the plugin may take per post, in milliseconds. Empty = the default for all plugins.',
      ),
    /** Requested worker memory cap (best effort; see README). */
    maxMemoryMb: z
      .number()
      .int()
      .positive()
      .max(4096)
      .optional()
      .describe('Memory limit for the plugin, in megabytes (best effort).'),
    /** Pipeline priority (clamped to 300+). */
    priority: technical(
      z
        .number()
        .int()
        .optional()
        .describe("Order among plugins: lower numbers run first. Empty = the plugin's own choice."),
      'Policy pipeline priority, ascending; clamped to 300+ so plugins run after built-in rules.',
    ),
    /** Permissions the admin approved; a plugin asking for more is not loaded. */
    approvedPermissions: z
      .array(
        labels(z.enum(['read-events', 'write-events', 'network', 'docs']), {
          'read-events': 'Read posts and profiles stored on this relay',
          'write-events': 'Publish new posts on its own',
          network: 'Connect to other websites and servers',
          docs: 'Keep its own saved data on this server',
        }),
      )
      .optional()
      .describe('What you allowed this plugin to do. A plugin that asks for more is not started.'),
  })
  .describe('How one plugin is run');
export type PluginEntrySettings = z.infer<typeof PluginEntrySettingsSchema>;

export const PluginsModuleSchema = z
  .object({
    /** Install directory. Default `<dataDir>/plugins`. */
    dir: example(
      z
        .string()
        .optional()
        .describe(
          'Folder where plugins are installed. Empty = a "plugins" folder in the data folder.',
        ),
      '/var/lib/beamhop/plugins',
    ),
    /**
     * Extra catalog (empty = built-in catalog only): `https://…` (signed, needs
     * `catalogPubkeys`) or `file:///path/catalog.json` for offline installs.
     */
    catalogUrl: example(
      technical(
        z
          .string()
          .default('')
          .describe('An extra list of plugins you can install. Empty = only the built-in list.'),
        'https://… (signed, needs catalogPubkeys) or file:///path/catalog.json for offline installs.',
      ),
      'https://plugins.example.com/catalog.json',
    ),
    /** Hex pubkeys trusted to sign the remote catalog. */
    catalogPubkeys: technical(
      z
        .array(z.string().regex(/^[0-9a-f]{64}$/))
        .default([])
        .describe('Keys of the people trusted to publish the extra plugin list.'),
      'Hex pubkeys trusted to sign the remote catalog.',
    ),
    /** Default per-call budget for sandboxed plugins (ms). */
    timeBudgetMs: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(20)
      .describe(
        'How long a plugin may take per post, in milliseconds. Raise it only if a slow plugin keeps timing out.',
      ),
    /** Watch local plugin files and reload on change (development). */
    hotReload: recommend(
      z
        .boolean()
        .default(false)
        .describe('Reload plugins automatically when their files change. For plugin development.'),
      false,
      'Not needed on a live relay.',
    ),
    breaker: z
      .object({
        /** Consecutive failures (errors/timeouts/crashes) before the plugin is turned off. */
        threshold: z
          .number()
          .int()
          .positive()
          .default(5)
          .describe('How many failures in a row before a plugin is turned off automatically.'),
      })
      .prefault({})
      .describe('Automatic shut-off of misbehaving plugins'),
    entries: z
      .record(z.string(), PluginEntrySettingsSchema)
      .default({})
      .describe('How each plugin is run, by plugin id.'),
  })
  .prefault({})
  .describe('Plugins');
export type PluginsModuleSettings = z.infer<typeof PluginsModuleSchema>;

export function readSettings(raw: unknown): PluginsModuleSettings {
  const r = PluginsModuleSchema.safeParse(raw ?? {});
  return r.success ? r.data : PluginsModuleSchema.parse({});
}

export function entrySettings(s: PluginsModuleSettings, id: string): PluginEntrySettings {
  return s.entries[id] ?? PluginEntrySettingsSchema.parse({});
}
