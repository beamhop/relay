// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generated action endpoints (§6.13): every action in `kernel.actions` gets a
 * catalog entry (with JSON Schema), preview, run (audited, returns an undo
 * token), bulk run and undo — no hand-written admin endpoints.
 */
import {
  type ActionContext,
  type ActionDef,
  type DiffLine,
  type Principal,
  type RelayId,
  can,
} from '@beamhop/core';
import { z } from 'zod';
import { HttpError, lowerFirst } from '../util.ts';
import { type Api, type Deps, op, parseWith, requirePrincipal } from './api.ts';

const schemaCache = new WeakMap<object, unknown>();

export function inputJsonSchema(def: ActionDef): unknown {
  let s = schemaCache.get(def.input);
  if (s === undefined) {
    try {
      s = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' });
    } catch {
      s = {};
    }
    schemaCache.set(def.input, s);
  }
  return s;
}

export function catalogEntry(
  def: ActionDef,
  principal: Principal | undefined,
  relayId: RelayId | null,
) {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    technical: def.technical,
    scope: def.scope,
    permission: def.permission,
    readOnly: !!def.readOnly,
    sensitive: !!def.sensitive,
    bulk: !!def.bulk,
    undoable: !!def.undo,
    hasPreview: !!def.preview,
    keywords: def.keywords ?? [],
    shortcut: def.shortcut,
    cli: `beamhop ${def.id.split('.').join(' ')}`,
    inputSchema: inputJsonSchema(def),
    allowed: principal ? can(principal, def.permission, relayId) : false,
  };
}

function findAction(deps: Deps, id: string, relayId: RelayId | null): ActionDef {
  const def = deps.kernel.actions.get(id);
  if (!def) throw new HttpError(404, 'unknown_action', 'That action does not exist');
  if (def.scope === 'relay' && !relayId)
    throw new HttpError(
      404,
      'wrong_scope',
      'This action works on a single relay. Use the relay’s address.',
      `use /nodes/{node}/relays/{relay}/actions/${id}`,
    );
  if (def.scope === 'node' && relayId)
    throw new HttpError(
      404,
      'wrong_scope',
      'This action works on the whole server.',
      `use /nodes/{node}/actions/${id}`,
    );
  return def;
}

function checkPermission(def: ActionDef, principal: Principal, relayId: RelayId | null) {
  if (!can(principal, def.permission, relayId))
    throw new HttpError(
      403,
      'forbidden',
      `You don't have permission to “${def.title}”`,
      `requires ${def.permission}`,
    );
}

function context(
  deps: Deps,
  principal: Principal,
  relayId: RelayId | null,
  reason?: string,
): ActionContext {
  const ctx: ActionContext = { principal, relayId, ports: deps.kernel.ports };
  if (reason) ctx.reason = reason;
  return ctx;
}

export interface RunOutcome {
  output: unknown;
  summary: string;
  undo?: { token: string; expiresAt: number };
}

/** Validate, authorize, run and audit one action invocation. Shared by REST, bulk and NIP-86. */
export async function runAction(
  deps: Deps,
  def: ActionDef,
  rawInput: unknown,
  principal: Principal,
  relayId: RelayId | null,
  reason?: string,
): Promise<RunOutcome> {
  checkPermission(def, principal, relayId);
  const input = parseWith(def.input, rawInput ?? {});
  const bus = deps.kernel.bus;
  let result: Awaited<ReturnType<ActionDef['run']>>;
  try {
    result = await def.run(input, context(deps, principal, relayId, reason));
  } catch (err) {
    bus.emit('admin.action', {
      relayId,
      actionId: def.id,
      principalId: principal.id,
      input,
      summary: `Tried to ${lowerFirst(def.title)}, but it failed`,
      ok: false,
    });
    await deps.audit.flush();
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'action_failed', `“${def.title}” did not work`, String(err));
  }
  const out: RunOutcome = { output: result.output, summary: result.summary };
  if (!def.readOnly) {
    if (result.undo && def.undo) {
      const token = await deps.undo.create({
        kind: 'action',
        actionId: def.id,
        payload: result.undo.payload,
        principalId: principal.id,
        relayId,
        expiresAt: result.undo.expiresAt,
        summary: result.summary,
      });
      out.undo = { token, expiresAt: result.undo.expiresAt };
    }
    bus.emit('admin.action', {
      relayId,
      actionId: def.id,
      principalId: principal.id,
      input,
      summary: result.summary,
      ok: true,
    });
    await deps.audit.flush();
  }
  return out;
}

export async function previewAction(
  deps: Deps,
  def: ActionDef,
  rawInput: unknown,
  principal: Principal,
  relayId: RelayId | null,
): Promise<DiffLine[]> {
  checkPermission(def, principal, relayId);
  const input = parseWith(def.input, rawInput ?? {});
  if (def.readOnly) return [];
  if (!def.preview) return [{ kind: 'info', text: def.title, technical: def.technical }];
  return def.preview(input, { ...context(deps, principal, relayId), dryRun: true });
}

async function undoToken(deps: Deps, token: string, principal: Principal): Promise<string> {
  const entry = await deps.undo.peek(token);
  if (!entry) throw new HttpError(410, 'undo_expired', 'This can no longer be undone');
  if (entry.kind === 'config') {
    if (!(await deps.undo.take(token)))
      throw new HttpError(410, 'undo_expired', 'This can no longer be undone');
    await deps.config.undo(entry.revision!, principal);
    return entry.summary;
  }
  const undoOne = async (actionId: string, payload: unknown, summary: string) => {
    const def = deps.kernel.actions.get(actionId);
    if (!def?.undo) throw new HttpError(410, 'undo_expired', 'This can no longer be undone');
    checkPermission(def, principal, entry.relayId);
    await def.undo(payload, context(deps, principal, entry.relayId));
    deps.kernel.bus.emit('admin.action', {
      relayId: entry.relayId,
      actionId: `undo:${actionId}`,
      principalId: principal.id,
      input: {},
      summary: `Undid “${summary}”`,
      ok: true,
    });
  };
  if (entry.kind === 'bulk') {
    const children = [];
    for (const t of entry.children ?? []) {
      const child = await deps.undo.peek(t);
      if (child?.actionId) {
        const def = deps.kernel.actions.get(child.actionId);
        if (def) checkPermission(def, principal, child.relayId);
        children.push({ t, child });
      }
    }
    if (!(await deps.undo.take(token)))
      throw new HttpError(410, 'undo_expired', 'This can no longer be undone');
    for (const { t, child } of children.reverse()) {
      if (!(await deps.undo.take(t))) continue;
      await undoOne(child.actionId!, child.payload, child.summary);
    }
    await deps.audit.flush();
    return entry.summary;
  }
  const def = deps.kernel.actions.get(entry.actionId ?? '');
  if (def) checkPermission(def, principal, entry.relayId);
  if (!(await deps.undo.take(token)))
    throw new HttpError(410, 'undo_expired', 'This can no longer be undone');
  await undoOne(entry.actionId!, entry.payload, entry.summary);
  await deps.audit.flush();
  return entry.summary;
}

const RunBody = z.object({
  input: z.unknown().optional().describe('Action input (see the catalog’s inputSchema)'),
  reason: z.string().max(500).optional().describe('Why (kept in the audit log)'),
});

export function actionRoutes(api: Api, deps: Deps): void {
  const { kernel } = deps;
  const tags = ['Actions'];

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/actions',
      scope: 'both',
      guard: 'authenticated',
      tags,
      summary: 'Catalog of everything an admin can do (titles, help, JSON Schema)',
      description:
        'On the node route, relay-scoped actions are listed too (run them on a relay route).',
    },
    (c, { relayId, principal }) => {
      const defs = kernel.actions.list().filter((d) => !relayId || d.scope === 'relay');
      return c.json({ actions: defs.map((d) => catalogEntry(d, principal, relayId ?? null)) });
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/actions/{id}/preview',
      scope: 'both',
      guard: 'authenticated',
      tags,
      summary: 'Preview what an action would change',
      body: RunBody,
    },
    async (c, { body, relayId }) => {
      const def = findAction(deps, c.req.param('id') ?? '', relayId);
      return c.json({
        action: def.id,
        diff: await previewAction(deps, def, body.input, requirePrincipal(c), relayId),
      });
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/actions/{id}',
      scope: 'both',
      guard: 'authenticated',
      tags,
      summary: 'Run an action (audited; returns an undo token when undoable)',
      body: RunBody,
    },
    async (c, { body, relayId }) => {
      const def = findAction(deps, c.req.param('id') ?? '', relayId);
      return c.json(
        await runAction(deps, def, body.input, requirePrincipal(c), relayId, body.reason),
      );
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/actions/{id}/bulk',
      scope: 'both',
      guard: 'authenticated',
      tags,
      summary: 'Run a bulk-capable action for many items (one undo for all)',
      body: z.object({
        inputs: z.array(z.unknown()).min(1).max(500),
        reason: z.string().max(500).optional(),
      }),
    },
    async (c, { body, relayId }) => {
      const def = findAction(deps, c.req.param('id') ?? '', relayId);
      if (!def.bulk)
        throw new HttpError(400, 'not_bulk', 'This action cannot be run for many items at once');
      const principal = requirePrincipal(c);
      checkPermission(def, principal, relayId);
      const results: Array<{ ok: boolean; output?: unknown; summary?: string; error?: unknown }> =
        [];
      const tokens: string[] = [];
      let expiresAt = Number.POSITIVE_INFINITY;
      for (const input of body.inputs) {
        try {
          const r = await runAction(deps, def, input, principal, relayId, body.reason);
          results.push({ ok: true, output: r.output, summary: r.summary });
          if (r.undo) {
            tokens.push(r.undo.token);
            expiresAt = Math.min(expiresAt, r.undo.expiresAt);
          }
        } catch (err) {
          const e =
            err instanceof HttpError ? err : new HttpError(500, 'action_failed', String(err));
          results.push({
            ok: false,
            error: { code: e.code, message: e.message, issues: e.issues },
          });
        }
      }
      const done = results.filter((r) => r.ok).length;
      const summary = `${def.title}: ${done} done${done < results.length ? `, ${results.length - done} failed` : ''}`;
      let undo: { token: string; expiresAt: number } | undefined;
      if (tokens.length) {
        const token = await deps.undo.create({
          kind: 'bulk',
          principalId: principal.id,
          relayId,
          expiresAt,
          children: tokens,
          summary,
        });
        undo = { token, expiresAt };
      }
      return c.json({ results, summary, undo });
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/undo/{token}',
      scope: 'both',
      guard: 'authenticated',
      tags,
      summary: 'Undo a recent action or settings change',
    },
    async (c) => {
      const summary = await undoToken(deps, c.req.param('token') ?? '', requirePrincipal(c));
      return c.json({ ok: true, undone: summary });
    },
  );
}
