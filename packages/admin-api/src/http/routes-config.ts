// SPDX-License-Identifier: AGPL-3.0-or-later
/** Settings: propose → plain diff → commit → undo, history/time machine, YAML. */
import { ConfigSchema, RelaySchema, can } from '@beamhop/core';
import { z } from 'zod';
import { describeChanges } from '../config/describe.ts';
import { redactPatch } from '../config/patch.ts';
import type { ConfigProposal, ConfigRevision } from '../config/service.ts';
import { HttpError, redact } from '../util.ts';
import { type Api, type Deps, op, requirePrincipal } from './api.ts';

const PatchOp = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string(),
  from: z.string().optional(),
  value: z.unknown().optional(),
});

const ProposeBody = z
  .object({
    patch: z.array(PatchOp).max(500).optional().describe('JSON Patch (RFC 6902)'),
    merge: z.unknown().optional().describe('JSON Merge Patch (RFC 7396)'),
    summary: z.string().max(200).optional(),
  })
  .refine((b) => b.patch !== undefined || b.merge !== undefined, 'Send either "patch" or "merge"');

function proposalView(p: ConfigProposal) {
  return {
    id: p.id,
    baseRevision: p.baseRevision,
    scope: p.scope,
    expiresAt: p.expiresAt,
    summary: p.summary,
    changed: p.patch.length > 0,
    diff: p.diff,
    patch: redactPatch(p.patch),
  };
}

function revisionInfo(r: ConfigRevision) {
  const { config: _c, patch, ...info } = r;
  return { ...info, changes: patch.length };
}

let cachedSchemas: { node: unknown; relay: unknown } | null = null;
function jsonSchemas() {
  cachedSchemas ??= {
    node: z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' }),
    relay: z.toJSONSchema(RelaySchema, { io: 'input', unrepresentable: 'any' }),
  };
  return cachedSchemas;
}

export function configRoutes(api: Api, deps: Deps): void {
  const svc = deps.config;
  const tags = ['Settings'];
  const revParam = (s: string) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_request', 'Unknown revision');
    return n;
  };

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/config',
      scope: 'both',
      guard: 'relay.read',
      tags,
      summary: 'Current settings',
    },
    async (c, { relayId }) => {
      const p = requirePrincipal(c);
      const { revision, config } = await svc.current();
      const full = can(p, 'config.write', relayId);
      if (relayId) {
        const relay = config.relays.find((r) => r.id === relayId);
        return c.json({ revision, relay: full ? relay : redact(relay) });
      }
      const kg = await svc.knownGood();
      return c.json({
        revision,
        config: full ? config : redact(config),
        knownGoodRevision: kg?.revision ?? null,
      });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/config/schema',
      scope: 'both',
      guard: 'relay.read',
      tags,
      summary: 'JSON Schema of the settings (for forms and help)',
    },
    (c, { relayId }) => c.json(relayId ? jsonSchemas().relay : jsonSchemas().node),
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/config/propose',
      scope: 'both',
      guard: 'config.write',
      tags,
      summary: 'Preview a change: validated result and a plain-language diff',
      description:
        'On a relay route, patch/merge paths are relative to that relay and may only change it.',
      body: ProposeBody,
    },
    async (c, { body, relayId }) => {
      const input: Parameters<typeof svc.propose>[0] = { relayId };
      if (body.patch) input.patch = body.patch as never;
      else input.merge = body.merge;
      if (body.summary) input.summary = body.summary;
      return c.json(proposalView(await svc.propose(input, requirePrincipal(c))));
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/config/commit',
      scope: 'both',
      guard: 'config.write',
      tags,
      summary: 'Apply a proposed change (undoable for a few minutes)',
      body: z.object({ proposalId: z.string(), summary: z.string().max(200).optional() }),
    },
    async (c, { body }) => {
      const opts: { summary?: string } = {};
      if (body.summary) opts.summary = body.summary;
      const r = await svc.commit(body.proposalId, requirePrincipal(c), opts);
      await deps.audit.flush();
      return c.json({ revision: revisionInfo(r.revision), undo: r.undo });
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/config/undo',
      scope: 'node',
      guard: 'authenticated',
      tags,
      summary: 'Undo the latest change (within the undo window)',
      body: z.object({ revision: z.number().int().positive() }),
    },
    async (c, { body }) => {
      const r = await svc.undo(body.revision, requirePrincipal(c));
      await deps.audit.flush();
      return c.json({ revision: revisionInfo(r) });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/config/revisions',
      scope: 'node',
      guard: 'relay.read',
      tags,
      summary: 'Settings history (time machine)',
      query: { limit: 'Max items', cursor: 'Paging cursor' },
    },
    async (c) => {
      const opts: { limit?: number; cursor?: string } = {};
      const limit = c.req.query('limit');
      const cursor = c.req.query('cursor');
      if (limit) opts.limit = Number(limit);
      if (cursor) opts.cursor = cursor;
      return c.json(await svc.history(opts));
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/config/revisions/{rev}',
      scope: 'node',
      guard: 'config.write',
      tags,
      summary: 'One revision with what changed',
    },
    async (c) => {
      const rev = revParam(c.req.param('rev') ?? '');
      const r = await svc.get(rev);
      if (!r) throw new HttpError(404, 'not_found', 'That revision does not exist');
      const prev = rev > 1 ? await svc.get(rev - 1) : null;
      return c.json({
        ...revisionInfo(r),
        patch: redactPatch(r.patch),
        config: r.config,
        diff: prev ? describeChanges(prev.config, r.config, ConfigSchema) : [],
      });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/config/revisions/{rev}/diff',
      scope: 'node',
      guard: 'relay.read',
      tags,
      summary: 'What restoring this revision would change',
    },
    async (c) => c.json({ diff: await svc.diffTo(revParam(c.req.param('rev') ?? '')) }),
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/config/revisions/{rev}/restore',
      scope: 'node',
      guard: 'config.write',
      tags,
      summary: 'Restore a past revision (undoable)',
    },
    async (c) => {
      const r = await svc.restore(revParam(c.req.param('rev') ?? ''), requirePrincipal(c));
      await deps.audit.flush();
      return c.json({ revision: revisionInfo(r.revision), undo: r.undo });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/config/export.yaml',
      scope: 'node',
      guard: 'config.write',
      tags,
      summary: 'Download settings as beamhop.yaml',
      produces: 'application/yaml',
      query: { revision: 'Revision (default: current)' },
    },
    async (c) => {
      const rev = c.req.query('revision');
      const text = await svc.exportYaml(rev ? revParam(rev) : undefined);
      return c.body(text, 200, { 'content-type': 'application/yaml; charset=utf-8' });
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/config/import',
      scope: 'node',
      guard: 'config.write',
      tags,
      summary: 'Preview importing a beamhop.yaml (commit it like any proposal)',
      body: z.object({ yaml: z.string().max(1_000_000) }),
    },
    async (c, { body }) =>
      c.json(proposalView(await svc.importYaml(body.yaml, requirePrincipal(c)))),
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/config/known-good',
      scope: 'node',
      guard: 'node.manage',
      tags,
      summary: 'Mark a revision as known-good (used by safe mode)',
      body: z.object({ revision: z.number().int().positive().optional() }),
    },
    async (c, { body }) => c.json({ revision: await svc.markKnownGood(body.revision) }),
  );
}
