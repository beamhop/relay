// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.plugins`: host-level settings. The per-plugin on/off switch
 * and plugin settings stay in core's `config.plugins[]`; `entries` holds how
 * the host runs each plugin (source, sandbox, budgets).
 */
import { z } from 'zod';

export const PluginEntrySettingsSchema = z.object({
  /**
   * Where the code comes from: npm package name, `file:/abs/path.ts` or an
   * absolute/relative path. Default: built-in, then the installed record, then
   * `beamhop-plugin-<id>` from the plugins directory.
   */
  source: z.string().optional(),
  /** Run in-process with full speed and no time budget. Built-ins are always trusted. */
  trusted: z.boolean().optional(),
  /** What to do when the plugin errors or runs out of time: let traffic through or block it. */
  failMode: z.enum(['open', 'closed']).default('open'),
  /** Per-call time budget for sandboxed plugins (ms). */
  timeBudgetMs: z.number().int().positive().max(10_000).optional(),
  /** Requested worker memory cap (best effort; see README). */
  maxMemoryMb: z.number().int().positive().max(4096).optional(),
  /** Pipeline priority (clamped to 300+). */
  priority: z.number().int().optional(),
  /** Permissions the admin approved; a plugin asking for more is not loaded. */
  approvedPermissions: z
    .array(z.enum(['read-events', 'write-events', 'network', 'docs']))
    .optional(),
});
export type PluginEntrySettings = z.infer<typeof PluginEntrySettingsSchema>;

export const PluginsModuleSchema = z
  .object({
    /** Install directory. Default `<dataDir>/plugins`. */
    dir: z.string().optional(),
    /**
     * Extra catalog (empty = built-in catalog only): `https://…` (signed, needs
     * `catalogPubkeys`) or `file:///path/catalog.json` for offline installs.
     */
    catalogUrl: z.string().default(''),
    /** Hex pubkeys trusted to sign the remote catalog. */
    catalogPubkeys: z.array(z.string().regex(/^[0-9a-f]{64}$/)).default([]),
    /** Default per-call budget for sandboxed plugins (ms). */
    timeBudgetMs: z.number().int().positive().max(10_000).default(20),
    /** Watch local plugin files and reload on change (development). */
    hotReload: z.boolean().default(false),
    breaker: z
      .object({
        /** Consecutive failures (errors/timeouts/crashes) before the plugin is turned off. */
        threshold: z.number().int().positive().default(5),
      })
      .prefault({}),
    entries: z.record(z.string(), PluginEntrySettingsSchema).default({}),
  })
  .prefault({});
export type PluginsModuleSettings = z.infer<typeof PluginsModuleSchema>;

export function readSettings(raw: unknown): PluginsModuleSettings {
  const r = PluginsModuleSchema.safeParse(raw ?? {});
  return r.success ? r.data : PluginsModuleSchema.parse({});
}

export function entrySettings(s: PluginsModuleSettings, id: string): PluginEntrySettings {
  return s.entries[id] ?? PluginEntrySettingsSchema.parse({});
}
