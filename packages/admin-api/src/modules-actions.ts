// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional modules (§12.0): turn company features on and off while running.
 *
 * - `modules.list`    — optional modules this server can load, with plain titles
 * - `modules.enable`  — writes a minimal `config.modules[id]` section (versioned,
 *                       undoable config revision); the runtime's module manager
 *                       (`runtime.modules`) hot-loads the module before this returns
 * - `modules.disable` — removes the section; the module is unloaded (its data is kept)
 *
 * Nothing here is enterprise-specific code: the runtime decides which modules exist
 * ({@link ModuleManager}); this file only holds their plain-language descriptions.
 */
import {
  type ActionDef,
  type ActionResult,
  type BeamhopConfig,
  type DiffLine,
  type Kernel,
  MODULE_MANAGER_SERVICE,
  type ModuleManager,
  type UiRoute,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import type { ConfigService } from './config/service.ts';
import { HttpError } from './util.ts';

export interface OptionalModuleText {
  title: string;
  description: string;
  technical: string;
  /** What shows up in the admin app once it is on (plain language). */
  appears: string[];
}

/** Plain-language catalog of known optional modules (unknown ids fall back to their id). */
export const OPTIONAL_MODULE_TEXT: Record<string, OptionalModuleText> = {
  'enterprise-identity': {
    title: 'Company sign-in',
    description:
      'People sign in with their Google Workspace, Microsoft or other company account, and leavers lose access automatically.',
    technical:
      'OIDC SSO (Google, Entra ID, generic), SCIM 2.0 provisioning, Google Directory sync, identity ↔ npub binding, group mapping, NIP-05 from the directory.',
    appears: [
      'Settings → Company sign-in (connect Google, Microsoft or another provider)',
      'People → Company groups',
      'A “Sign in with your company account” button',
    ],
  },
  'enterprise-keyvault': {
    title: 'Company-held keys',
    description:
      'The company keeps signing keys for staff in an encrypted vault, with a built-in remote signer.',
    technical:
      'Envelope encryption under a KEK (local master key, AWS/GCP/Azure KMS, Vault Transit), audited signer, NIP-46 bunker, crypto-shredding, optional DM escrow.',
    appears: ['Settings → Company keys', 'Key vault health checks'],
  },
  'enterprise-compliance': {
    title: 'Compliance tools',
    description:
      'Two-person approvals, legal hold and export, retention by group, data residency checks and usage reports.',
    technical:
      'Approval gate on sensitive actions, SIEM export, legal hold & eDiscovery, retention by group, residency checks, encryption at rest, usage reports.',
    appears: ['Settings → Compliance', 'Activity → Approvals'],
  },
  'enterprise-network': {
    title: 'Network access controls',
    description:
      'Only allow access from your office networks, company devices or your company access gateway.',
    technical:
      'IP/CIDR allowlists (relay + admin), mTLS device certificates, zero-trust proxies (Google IAP, Cloudflare Access, Entra App Proxy), private-only mode.',
    appears: ['Settings → Network access'],
  },
};

const UNDO_SECONDS = 300;

/** Output of `modules.enable` / `modules.disable`. */
export interface ModuleToggleOutput {
  id: string;
  /** Registered with the kernel after the change. */
  enabled: boolean;
  /** False when it already was in the requested state (no revision written). */
  changed: boolean;
  /** Config revision written. */
  revision?: number;
  /** Admin app routes the module contributes now (enable). */
  ui?: UiRoute[];
  /** Action ids that appeared (enable). */
  actions?: string[];
}

function textOf(id: string): OptionalModuleText {
  return (
    OPTIONAL_MODULE_TEXT[id] ?? {
      title: id,
      description: 'An optional feature.',
      technical: `config.modules['${id}']`,
      appears: [],
    }
  );
}

/** UI routes contributed by a module (its lazy chunk is named after it). */
function uiOf(kernel: Kernel, id: string): UiRoute[] {
  return kernel.ui.filter((u) => u.chunk === id || u.chunk.startsWith(`${id}/`));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function moduleActions(kernel: Kernel, config: ConfigService): ActionDef[] {
  const manager = () => kernel.use<ModuleManager>(MODULE_MANAGER_SERVICE);
  const requireKnown = (id: string): ModuleManager => {
    const m = manager();
    if (!m?.has(id))
      throw new HttpError(
        404,
        'not_found',
        `“${textOf(id).title}” can't be turned on on this server`,
        m ? `no optional module source for ${id}` : 'runtime has no module manager',
      );
    return m;
  };
  const undoAt = () => kernel.ports.clock.now() + UNDO_SECONDS;
  const withSection = (cur: BeamhopConfig, id: string, section: unknown): BeamhopConfig => {
    const modules = { ...cur.modules };
    if (section === undefined) delete modules[id];
    else modules[id] = section;
    return { ...cur, modules };
  };

  const IdInput = z.object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .describe('Which feature, e.g. enterprise-identity'),
  });

  const list = defineAction({
    id: 'modules.list',
    title: 'Show optional features',
    description: 'Company features this server can turn on, and which are on.',
    technical:
      'Optional modules known to the runtime module manager (runtime.modules): available (loadable here), enabled (registered), configured (config.modules[id] present).',
    scope: 'node',
    permission: 'node.manage',
    readOnly: true,
    keywords: ['modules', 'features', 'enterprise', 'company'],
    input: z.object({}),
    async run() {
      const states = manager()?.list() ?? [];
      const modules = states.map((s) => {
        const t = textOf(s.id);
        return {
          id: s.id,
          title: t.title,
          description: t.description,
          technical: t.technical,
          appears: t.appears,
          available: s.available,
          enabled: s.enabled,
          configured: s.configured,
          ...(s.error ? { error: s.error } : {}),
          ui: s.enabled ? uiOf(kernel, s.id) : [],
        };
      });
      const on = modules.filter((m) => m.enabled).length;
      return { output: { modules }, summary: `${on} of ${modules.length} optional features on` };
    },
  });

  const enable = defineAction({
    id: 'modules.enable',
    title: 'Turn on an optional feature',
    description: 'Adds a company feature to this server right away, without a restart.',
    technical:
      'Writes a minimal config.modules[id] section as a new config revision; the runtime hot-loads the module (kernel.enableModule) before the revision is committed. Undo removes the section again.',
    scope: 'node',
    permission: 'node.manage',
    keywords: ['enable', 'turn on', 'company', 'enterprise', 'sso'],
    input: IdInput,
    async preview(input) {
      const t = textOf(input.id);
      const m = manager();
      if (!m?.has(input.id))
        return [{ kind: 'warning', text: `“${t.title}” can't be turned on on this server` }];
      if (kernel.isEnabled(input.id)) return [{ kind: 'info', text: `“${t.title}” is already on` }];
      const lines: DiffLine[] = [
        {
          kind: 'add',
          text: `${t.title} turns on: ${t.description}`,
          technical: `config.modules['${input.id}'] added → ${t.technical}`,
        },
      ];
      for (const a of t.appears) lines.push({ kind: 'add', text: `New: ${a}` });
      lines.push({
        kind: 'info',
        text: 'Nothing changes for your members until you finish setting it up. You can undo this.',
      });
      return lines;
    },
    async run(input, ctx): Promise<ActionResult<ModuleToggleOutput>> {
      const m = requireKnown(input.id);
      const t = textOf(input.id);
      const cur = kernel.config();
      const prev = cur.modules[input.id];
      if (
        prev !== undefined &&
        kernel.isEnabled(input.id) &&
        !(isObject(prev) && prev.enabled === false)
      )
        return {
          output: { id: input.id, enabled: true, changed: false, ui: uiOf(kernel, input.id) },
          summary: `${t.title} is already on`,
        };
      const section = isObject(prev)
        ? { ...prev, ...(prev.enabled === false ? { enabled: true } : {}) }
        : await m.defaultSection(input.id);
      const actionsBefore = new Set(kernel.actions.list().map((a) => a.id));
      const res = await config.apply(withSection(cur, input.id, section), {
        principalId: ctx.principal.id,
        summary: `Turned on ${t.title}`,
        ...(ctx.reason ? { reason: ctx.reason } : {}),
      });
      await m.sync();
      const enabled = kernel.isEnabled(input.id);
      return {
        output: {
          id: input.id,
          enabled,
          changed: true,
          revision: res.revisionId,
          ui: uiOf(kernel, input.id),
          actions: kernel.actions
            .list()
            .map((a) => a.id)
            .filter((id) => !actionsBefore.has(id)),
        },
        summary: `Turned on ${t.title}`,
        undo: { actionId: 'modules.enable', payload: { id: input.id, prev }, expiresAt: undoAt() },
      };
    },
    async undo(payload, ctx) {
      const p = payload as { id: string; prev: unknown };
      await config.apply(withSection(kernel.config(), p.id, p.prev), {
        principalId: ctx.principal.id,
        summary: `Undid turning on ${textOf(p.id).title}`,
      });
    },
  });

  const disable = defineAction({
    id: 'modules.disable',
    title: 'Turn off an optional feature',
    description: 'Removes a company feature from this server right away. Its data is kept.',
    technical:
      'Removes config.modules[id] as a new config revision; the runtime unloads the module (kernel.disableModule: hooks, routes, actions, jobs…). Stored module data stays; undo restores the section.',
    scope: 'node',
    permission: 'node.manage',
    keywords: ['disable', 'turn off', 'company', 'enterprise'],
    input: IdInput,
    async preview(input) {
      const t = textOf(input.id);
      if (kernel.config().modules[input.id] === undefined && !kernel.isEnabled(input.id))
        return [{ kind: 'info', text: `“${t.title}” is already off` }];
      const lines: DiffLine[] = [
        {
          kind: 'remove',
          text: `${t.title} turns off`,
          technical: `config.modules['${input.id}'] removed`,
        },
      ];
      for (const u of uiOf(kernel, input.id))
        lines.push({ kind: 'remove', text: `${u.title} disappears from the admin app` });
      if (input.id === 'enterprise-identity')
        lines.push({
          kind: 'warning',
          text: 'People can no longer sign in with their company account',
        });
      lines.push({
        kind: 'info',
        text: 'Its stored data is kept, and you can undo this.',
      });
      return lines;
    },
    async run(input, ctx): Promise<ActionResult<ModuleToggleOutput>> {
      const t = textOf(input.id);
      const cur = kernel.config();
      const prev = cur.modules[input.id];
      if (prev === undefined) {
        if (kernel.isEnabled(input.id) && manager()?.has(input.id)) await manager()?.sync();
        return {
          output: { id: input.id, enabled: kernel.isEnabled(input.id), changed: false },
          summary: `${t.title} is already off`,
        };
      }
      const res = await config.apply(withSection(cur, input.id, undefined), {
        principalId: ctx.principal.id,
        summary: `Turned off ${t.title}`,
        ...(ctx.reason ? { reason: ctx.reason } : {}),
      });
      await manager()?.sync();
      return {
        output: {
          id: input.id,
          enabled: kernel.isEnabled(input.id),
          changed: true,
          revision: res.revisionId,
        },
        summary: `Turned off ${t.title}`,
        undo: { actionId: 'modules.disable', payload: { id: input.id, prev }, expiresAt: undoAt() },
      };
    },
    async undo(payload, ctx) {
      const p = payload as { id: string; prev: unknown };
      await config.apply(withSection(kernel.config(), p.id, p.prev), {
        principalId: ctx.principal.id,
        summary: `Undid turning off ${textOf(p.id).title}`,
      });
    },
  });

  return [list, enable, disable] as unknown as ActionDef[];
}
