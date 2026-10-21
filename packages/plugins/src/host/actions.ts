// SPDX-License-Identifier: AGPL-3.0-or-later
/** `plugins.*` admin actions (§6.13). Routes, CLI and palette entries are generated from these. */
import { type ActionDef, type BeamhopConfig, type DiffLine, defineAction } from '@beamhop/core';
import { z } from 'zod';
import { BUILTIN_PLUGINS } from '../builtin/index.ts';
import { BUILTIN_PREFIX, type CatalogEntry } from '../catalog/index.ts';
import {
  PERMISSION_TEXT,
  type PluginPermission,
  compareSemver,
  parsePluginConfig,
} from '../sdk/index.ts';
import { INSTALLED_COLLECTION, type PluginHost } from './host.ts';
import { PluginEntrySettingsSchema, readSettings } from './settings.ts';
import type { InstalledRecord } from './types.ts';

const UNDO_SECONDS = 300;
const idInput = z.object({ id: z.string().min(1).describe('Plugin id, e.g. keyword-filter') });

type PluginsList = BeamhopConfig['plugins'];

export function permissionLines(perms: readonly PluginPermission[]): DiffLine[] {
  if (perms.length === 0) {
    return [
      {
        kind: 'info',
        text: 'It cannot read your data, save anything, or connect to the internet',
        technical: 'permissions: none',
      },
    ];
  }
  return perms.map((p) => ({
    kind: PERMISSION_TEXT[p].risky ? 'warning' : 'info',
    text: `It will be able to: ${PERMISSION_TEXT[p].text.toLowerCase()}`,
    technical: PERMISSION_TEXT[p].technical,
  }));
}

function nameOf(host: PluginHost, id: string, entry?: CatalogEntry): string {
  return host.manifestOf(id)?.name ?? entry?.name ?? id;
}

function upsert(list: PluginsList, id: string, patch: Partial<PluginsList[number]>): PluginsList {
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return [...list, { id, enabled: true, config: {}, ...patch }];
  const out = [...list];
  out[i] = { ...out[i]!, ...patch };
  return out;
}

function validateBuiltinConfig(id: string, config: unknown): void {
  const def = BUILTIN_PLUGINS[id];
  if (def) parsePluginConfig(def.spec, config);
}

function isBuiltin(entry: CatalogEntry | undefined): boolean {
  return !!entry && entry.package.startsWith(BUILTIN_PREFIX);
}

export function pluginActions(host: PluginHost): ActionDef[] {
  const kernel = host.kernel;
  const undoAt = () => kernel.ports.clock.now() + UNDO_SECONDS;
  const restorePlugins = async (payload: unknown, principalId: string) => {
    const p = payload as { plugins: PluginsList };
    await host.commitConfig((c) => ({ ...c, plugins: p.plugins }), {
      principalId,
      summary: 'Undo plugin change',
    });
  };

  const catalog = defineAction({
    id: 'plugins.catalog',
    title: 'Browse plugins',
    description: 'See plugins you can add to your relay, and which ones you already have.',
    technical: 'Built-in catalog merged with the signed remote catalog (kind 30078, NIP-78).',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['plugins', 'extensions', 'add-ons', 'catalog', 'store'],
    input: z.object({ refresh: z.boolean().default(false) }),
    async run(input) {
      const { entries, remoteError } = await host.catalog({ refresh: input.refresh });
      const config = kernel.config();
      const items = await Promise.all(
        entries.map(async (e) => ({
          ...e,
          builtin: isBuiltin(e),
          installed: isBuiltin(e) || !!(await host.installedRecord(e.id)),
          enabled: config.plugins.some((p) => p.id === e.id && p.enabled),
          compatible: compareSemver(host.beamhopVersion, e.minBeamhop) >= 0,
          permissionText: e.permissions.map((p) => PERMISSION_TEXT[p].text),
        })),
      );
      return {
        output: { items, ...(remoteError ? { remoteError } : {}) },
        summary: `${items.length} plugins available`,
      };
    },
  });

  const install = defineAction({
    id: 'plugins.install',
    title: 'Add a plugin',
    description: 'Add a plugin from the catalog. You will see what it is allowed to do first.',
    technical:
      'Downloads the pinned version, verifies its integrity hash, installs into <dataDir>/plugins and adds it to config.plugins.',
    scope: 'node',
    permission: 'plugins.write',
    keywords: ['install plugin', 'add plugin'],
    input: z.object({
      id: z.string().min(1).describe('Plugin id from the catalog'),
      enable: z.boolean().default(true).describe('Turn it on right away'),
      config: z.record(z.string(), z.unknown()).optional().describe('Plugin settings'),
    }),
    async preview(input) {
      const entry = await host.catalogEntry(input.id);
      if (!entry) {
        return [
          { kind: 'warning', text: `There is no plugin called “${input.id}” in the catalog` },
        ];
      }
      const lines: DiffLine[] = [
        {
          kind: 'add',
          text: `Add “${entry.name ?? entry.id}” (version ${entry.version})`,
          technical: `${entry.package}@${entry.version}${entry.integrity ? ` ${entry.integrity.slice(0, 22)}…` : ''}`,
        },
        ...permissionLines(entry.permissions),
      ];
      const s = readSettings(kernel.config().modules.plugins);
      lines.push(
        isBuiltin(entry)
          ? {
              kind: 'info',
              text: 'It is built into Beamhop and has been reviewed by the Beamhop team',
            }
          : {
              kind: 'info',
              text: `It runs in a separate sandbox and gets ${s.timeBudgetMs} ms per check; if it misbehaves it is turned off automatically`,
              technical: `Bun Worker, timeBudgetMs=${s.timeBudgetMs}, breaker.threshold=${s.breaker.threshold}`,
            },
      );
      if (compareSemver(host.beamhopVersion, entry.minBeamhop) < 0) {
        lines.push({
          kind: 'warning',
          text: `It needs a newer Beamhop (${entry.minBeamhop} or later)`,
        });
      }
      if (input.enable) {
        lines.push({ kind: 'change', text: 'It will start checking new activity right away' });
      }
      return lines;
    },
    async run(input, ctx) {
      const entry = await host.catalogEntry(input.id);
      if (!entry) throw new Error(`There is no plugin called “${input.id}” in the catalog`);
      if (compareSemver(host.beamhopVersion, entry.minBeamhop) < 0) {
        throw new Error(`This plugin needs Beamhop ${entry.minBeamhop} or later`);
      }
      const prev = kernel.config().plugins;
      const existing = prev.find((p) => p.id === entry.id);
      const config = input.config ?? (existing?.config as Record<string, unknown>) ?? {};
      let rec: InstalledRecord;
      if (isBuiltin(entry)) {
        // Settings may be filled in later; only a plugin being turned on must be valid now.
        if (input.enable) validateBuiltinConfig(entry.id, config);
        rec = {
          id: entry.id,
          package: entry.package,
          version: entry.version,
          permissions: entry.permissions,
          source: 'builtin',
          installedAt: kernel.ports.clock.now(),
        };
      } else {
        if (!host.loader.canInstall || !host.installer) {
          throw new Error(
            'Plugins cannot be downloaded on this server while it runs. Add the plugin to your configuration and deploy again.',
          );
        }
        rec = await host.installer.install(entry);
      }
      await kernel.ports.docs.put(INSTALLED_COLLECTION, entry.id, rec);
      await host.untrip(entry.id);
      await host.commitConfig(
        (c) => ({ ...c, plugins: upsert(c.plugins, entry.id, { enabled: input.enable, config }) }),
        {
          principalId: ctx.principal.id,
          summary: `Added plugin ${entry.name ?? entry.id}`,
          reason: ctx.reason,
        },
      );
      const row = host.status().find((r) => r.id === entry.id);
      return {
        output: row,
        summary: `Added “${entry.name ?? entry.id}”${input.enable ? ' and turned it on' : ''}`,
        undo: { actionId: 'plugins.install', payload: { plugins: prev }, expiresAt: undoAt() },
      };
    },
    async undo(payload, ctx) {
      await restorePlugins(payload, ctx.principal.id);
    },
  });

  const setEnabled = (enabled: boolean) =>
    defineAction({
      id: enabled ? 'plugins.enable' : 'plugins.disable',
      title: enabled ? 'Turn a plugin on' : 'Turn a plugin off',
      description: enabled
        ? 'Start using a plugin you have added.'
        : 'Stop using a plugin without removing it.',
      technical: `config.plugins[id].enabled = ${enabled}${enabled ? '; clears the circuit breaker' : ''}`,
      scope: 'node',
      permission: 'plugins.write',
      keywords: ['plugin', enabled ? 'enable' : 'disable'],
      input: idInput,
      async preview(input) {
        const name = nameOf(host, input.id, await host.catalogEntry(input.id));
        const lines: DiffLine[] = [
          {
            kind: 'change',
            text: enabled
              ? `“${name}” will start checking new activity`
              : `“${name}” will stop checking new activity`,
            technical: `plugins[${input.id}].enabled: ${!enabled} → ${enabled}`,
          },
        ];
        const t = host.trippedState(input.id);
        if (enabled && t) {
          lines.push({
            kind: 'warning',
            text: `It was turned off automatically because ${t.reason}. If it keeps failing it will be turned off again.`,
          });
        }
        return lines;
      },
      async run(input, ctx) {
        const prev = kernel.config().plugins;
        const exists = prev.some((p) => p.id === input.id);
        if (!exists) {
          const known =
            BUILTIN_PLUGINS[input.id] !== undefined || !!(await host.installedRecord(input.id));
          if (!enabled || !known) throw new Error(`There is no plugin called “${input.id}” here`);
        }
        if (enabled) await host.untrip(input.id);
        await host.commitConfig(
          (c) => ({ ...c, plugins: upsert(c.plugins, input.id, { enabled }) }),
          {
            principalId: ctx.principal.id,
            summary: `${enabled ? 'Turned on' : 'Turned off'} plugin ${input.id}`,
            reason: ctx.reason,
          },
        );
        const row = host.status().find((r) => r.id === input.id);
        return {
          output: row,
          summary: `${enabled ? 'Turned on' : 'Turned off'} “${nameOf(host, input.id)}”${
            enabled && row?.status === 'error' ? ` — but it could not start: ${row.error}` : ''
          }`,
          undo: {
            actionId: enabled ? 'plugins.enable' : 'plugins.disable',
            payload: { plugins: prev },
            expiresAt: undoAt(),
          },
        };
      },
      async undo(payload, ctx) {
        await restorePlugins(payload, ctx.principal.id);
      },
    });

  const configure = defineAction({
    id: 'plugins.configure',
    title: 'Change plugin settings',
    description: 'Adjust how a plugin behaves.',
    technical:
      'Merges into config.plugins[id].config; `run` settings go to modules.plugins.entries[id] (sandbox, fail mode, budget).',
    scope: 'node',
    permission: 'plugins.write',
    keywords: ['plugin settings', 'configure plugin'],
    input: z.object({
      id: z.string().min(1),
      config: z.record(z.string(), z.unknown()).optional().describe('Settings to change'),
      replace: z.boolean().default(false).describe('Replace all settings instead of merging'),
      run: PluginEntrySettingsSchema.partial().optional().describe('How Beamhop runs the plugin'),
    }),
    async preview(input) {
      const cur = kernel.config().plugins.find((p) => p.id === input.id);
      const lines: DiffLine[] = [];
      const old = (cur?.config ?? {}) as Record<string, unknown>;
      const next = input.replace ? (input.config ?? {}) : { ...old, ...(input.config ?? {}) };
      const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
      for (const k of keys) {
        const a = JSON.stringify(old[k]);
        const b = JSON.stringify(next[k]);
        if (a === b) continue;
        lines.push({
          kind: a === undefined ? 'add' : b === undefined ? 'remove' : 'change',
          text: `${k}: ${a ?? '(not set)'} → ${b ?? '(not set)'}`,
          technical: `plugins[${input.id}].config.${k}`,
        });
      }
      if (input.run) {
        for (const [k, v] of Object.entries(input.run)) {
          lines.push({
            kind: 'change',
            text:
              k === 'trusted' && v === true
                ? 'The plugin will run inside Beamhop without a sandbox or time limit'
                : k === 'failMode'
                  ? v === 'closed'
                    ? 'If the plugin fails, activity it checks will be blocked'
                    : 'If the plugin fails, activity it checks will be let through'
                  : `${k} → ${JSON.stringify(v)}`,
            technical: `modules.plugins.entries.${input.id}.${k} = ${JSON.stringify(v)}`,
          });
        }
        if (input.run.trusted) {
          lines.push({
            kind: 'warning',
            text: 'Only do this for plugins whose code you trust completely',
          });
        }
      }
      if (lines.length === 0) lines.push({ kind: 'info', text: 'Nothing changes' });
      return lines;
    },
    async run(input, ctx) {
      const prev = kernel.config();
      const cur = prev.plugins.find((p) => p.id === input.id);
      if (!cur) throw new Error(`There is no plugin called “${input.id}” here`);
      const old = (cur.config ?? {}) as Record<string, unknown>;
      const next = input.replace ? (input.config ?? {}) : { ...old, ...(input.config ?? {}) };
      validateBuiltinConfig(input.id, next);
      await host.commitConfig(
        (c) => {
          let modules = c.modules;
          if (input.run) {
            const s = (c.modules.plugins ?? {}) as { entries?: Record<string, unknown> };
            const entries = { ...(s.entries ?? {}) };
            entries[input.id] = { ...((entries[input.id] as object) ?? {}), ...input.run };
            modules = { ...c.modules, plugins: { ...s, entries } };
          }
          return { ...c, modules, plugins: upsert(c.plugins, input.id, { config: next }) };
        },
        {
          principalId: ctx.principal.id,
          summary: `Changed settings of plugin ${input.id}`,
          reason: ctx.reason,
        },
      );
      const row = host.status().find((r) => r.id === input.id);
      return {
        output: row,
        summary:
          row?.status === 'error'
            ? `Saved, but “${nameOf(host, input.id)}” could not start: ${row.error}`
            : `Updated “${nameOf(host, input.id)}”`,
        undo: {
          actionId: 'plugins.configure',
          payload: { plugins: prev.plugins, modulesPlugins: prev.modules.plugins ?? null },
          expiresAt: undoAt(),
        },
      };
    },
    async undo(payload, ctx) {
      const p = payload as { plugins: PluginsList; modulesPlugins: unknown };
      await host.commitConfig(
        (c) => ({
          ...c,
          plugins: p.plugins,
          modules: { ...c.modules, plugins: p.modulesPlugins ?? {} },
        }),
        { principalId: ctx.principal.id, summary: 'Undo plugin settings change' },
      );
    },
  });

  const uninstall = defineAction({
    id: 'plugins.uninstall',
    title: 'Remove a plugin',
    description: 'Turn a plugin off and delete it from this server.',
    technical:
      'Removes config.plugins[id] and modules.plugins.entries[id], deletes installed files and the install record.',
    scope: 'node',
    permission: 'plugins.write',
    keywords: ['remove plugin', 'uninstall', 'delete plugin'],
    input: idInput,
    async preview(input) {
      const rec = await host.installedRecord(input.id);
      const lines: DiffLine[] = [
        {
          kind: 'remove',
          text: `“${nameOf(host, input.id)}” will be turned off and removed`,
          technical: `config.plugins − ${input.id}`,
        },
      ];
      if (rec && rec.source !== 'builtin') {
        lines.push({
          kind: 'warning',
          text: 'Its files will be deleted; you can add it again from the catalog later',
          technical: rec.entry ?? rec.package,
        });
      }
      return lines;
    },
    async run(input, ctx) {
      const rec = await host.installedRecord(input.id);
      const cfg = kernel.config();
      if (!rec && !cfg.plugins.some((p) => p.id === input.id)) {
        throw new Error(`There is no plugin called “${input.id}” here`);
      }
      await host.commitConfig(
        (c) => {
          const s = (c.modules.plugins ?? {}) as { entries?: Record<string, unknown> };
          const entries = { ...(s.entries ?? {}) };
          delete entries[input.id];
          return {
            ...c,
            plugins: c.plugins.filter((p) => p.id !== input.id),
            modules: { ...c.modules, plugins: { ...s, entries } },
          };
        },
        {
          principalId: ctx.principal.id,
          summary: `Removed plugin ${input.id}`,
          reason: ctx.reason,
        },
      );
      if (rec && rec.source !== 'builtin' && host.installer) await host.installer.remove(rec);
      await kernel.ports.docs.delete(INSTALLED_COLLECTION, input.id);
      await host.untrip(input.id);
      await host.forget(input.id);
      return { output: { id: input.id, removed: true }, summary: `Removed “${input.id}”` };
    },
  });

  const status = defineAction({
    id: 'plugins.status',
    title: 'Plugin health',
    description:
      'See how each plugin is doing: how often it runs, what it blocks, and how fast it is.',
    technical: 'Per plugin: calls, rejections, errors, timeouts, p95/avg hook latency (ms), mode.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['plugins', 'plugin stats', 'plugin health'],
    input: z.object({}),
    async run() {
      const rows = host.status();
      const bad = rows.filter((r) => r.status === 'error' || r.status === 'tripped').length;
      return {
        output: { plugins: rows },
        summary: `${rows.filter((r) => r.status === 'running').length} running${bad ? `, ${bad} need attention` : ''}`,
      };
    },
  });

  return [catalog, install, setEnabled(true), setEnabled(false), configure, uninstall, status];
}
