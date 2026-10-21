// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Assistant tools, generated per request from the action registry and the
 * caller's permissions (§6.13):
 * - every `readOnly` action → a callable read tool;
 * - every state-changing action → a `propose_*` tool that validates input and
 *   returns the action's `preview()` diff — it NEVER runs the action. The diff
 *   becomes a proposal card the admin approves through the normal run endpoint;
 * - built-in read tools: health, cards, metrics, recent errors, config sections,
 *   setting explanations, audit search; plus `propose_settings_change` (config
 *   service propose → commit endpoint).
 */
import {
  type ActionContext,
  type ActionDef,
  type AttentionCard,
  type DiffLine,
  type HealthResult,
  type Kernel,
  type Principal,
  type RelayId,
  type ToolSpec,
  can,
} from '@beamhop/core';
import { z } from 'zod';
import type { ErrorRing } from './errors.ts';
import { truncate, withTimeout } from './safety.ts';
import { configSection, explainSetting } from './settings.ts';

export type ToolKind = 'read' | 'propose';

export interface Proposal {
  id: string;
  kind: 'action' | 'settings';
  /** Action to run on approval (`config.commit` for settings proposals). */
  actionId: string;
  title: string;
  input: unknown;
  diffLines: DiffLine[];
  relayId: RelayId | null;
  sensitive: boolean;
  undoable: boolean;
  /** Always true: nothing is applied until the admin approves. */
  requiresApproval: true;
  /** How the UI applies it (the standard admin-api endpoint). */
  approve: { method: 'POST'; path: string; body: unknown };
}

export type ToolOutcome =
  | { ok: true; result: unknown; summary: string; proposal?: Proposal }
  | { ok: false; error: string };

export interface ToolEnv {
  kernel: Kernel;
  principal: Principal;
  relayId: RelayId | null;
  errors?: ErrorRing;
  /** Proposal ids are generated with this. */
  newId(): string;
}

export interface AssistantTool {
  spec: ToolSpec;
  kind: ToolKind;
  /** Source action for generated tools. */
  actionId?: string;
  run(args: unknown, env: ToolEnv): Promise<ToolOutcome>;
}

// ───────────────────────────── schema helpers ─────────────────────────────

const schemaCache = new WeakMap<object, { schema: Record<string, unknown>; wrapped: boolean }>();

/** JSON Schema for a tool's parameters (always an object; non-object inputs are wrapped as `{ input }`). */
export function toolParameters(input: z.ZodType): {
  schema: Record<string, unknown>;
  wrapped: boolean;
} {
  const hit = schemaCache.get(input);
  if (hit) return hit;
  let js: Record<string, unknown>;
  try {
    js = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    js = {};
  }
  const { $schema: _drop, ...rest } = js;
  const out =
    rest.type === 'object'
      ? { schema: rest, wrapped: false }
      : {
          schema: { type: 'object', properties: { input: rest }, required: ['input'] },
          wrapped: true,
        };
  schemaCache.set(input, out);
  return out;
}

export function toolName(prefix: '' | 'propose_', actionId: string): string {
  return `${prefix}${actionId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
}

function actionRelay(def: ActionDef, relayId: RelayId | null): RelayId | null {
  return def.scope === 'relay' ? relayId : null;
}

/** Whether `def` is usable for this principal in this context (scope + permission). */
export function actionAvailable(
  def: ActionDef,
  principal: Principal,
  relayId: RelayId | null,
): boolean {
  if (def.scope === 'relay' && !relayId) return false;
  return can(principal, def.permission, actionRelay(def, relayId));
}

function describeAction(def: ActionDef, kind: ToolKind): string {
  const base = `${def.title}. ${def.description}${def.technical ? ` (technical: ${def.technical})` : ''}`;
  return kind === 'read'
    ? `Look up: ${base}`
    : `Suggest: ${base} This does NOT change anything — it returns a preview of the change, which the admin must approve.`;
}

function actionPath(nodeId: string, def: ActionDef, relayId: RelayId | null): string {
  return def.scope === 'relay' && relayId
    ? `/api/v1/nodes/${nodeId}/relays/${relayId}/actions/${def.id}`
    : `/api/v1/nodes/${nodeId}/actions/${def.id}`;
}

function parseInput(def: ActionDef, args: unknown, wrapped: boolean) {
  const raw = wrapped ? (args as { input?: unknown } | null)?.input : (args ?? {});
  return def.input.safeParse(raw ?? {});
}

function issuesText(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(input)'}: ${i.message}`)
    .join('; ');
}

function ctxFor(env: ToolEnv, def: ActionDef, dryRun: boolean): ActionContext {
  return {
    principal: env.principal,
    relayId: actionRelay(def, env.relayId),
    ports: env.kernel.ports,
    reason: 'assistant',
    dryRun,
  };
}

/** Read tool for a read-only action: validates, checks permission again, runs. */
export function readTool(def: ActionDef): AssistantTool {
  const { schema, wrapped } = toolParameters(def.input);
  return {
    kind: 'read',
    actionId: def.id,
    spec: {
      name: toolName('', def.id),
      description: describeAction(def, 'read'),
      parameters: schema,
    },
    async run(args, env) {
      if (!actionAvailable(def, env.principal, env.relayId))
        return { ok: false, error: 'Not allowed for this admin' };
      const parsed = parseInput(def, args, wrapped);
      if (!parsed.success)
        return { ok: false, error: `Invalid input: ${issuesText(parsed.error)}` };
      const r = await def.run(parsed.data, ctxFor(env, def, false));
      return { ok: true, result: r.output, summary: r.summary };
    },
  };
}

/** Propose tool for a state-changing action: validates and previews; never calls `run`. */
export function proposeTool(def: ActionDef): AssistantTool {
  const { schema, wrapped } = toolParameters(def.input);
  return {
    kind: 'propose',
    actionId: def.id,
    spec: {
      name: toolName('propose_', def.id),
      description: describeAction(def, 'propose'),
      parameters: schema,
    },
    async run(args, env) {
      if (!actionAvailable(def, env.principal, env.relayId))
        return { ok: false, error: 'Not allowed for this admin' };
      const parsed = parseInput(def, args, wrapped);
      if (!parsed.success)
        return { ok: false, error: `Invalid input: ${issuesText(parsed.error)}` };
      const diffLines: DiffLine[] = def.preview
        ? await def.preview(parsed.data, ctxFor(env, def, true))
        : [{ kind: 'info', text: def.title, technical: def.technical }];
      const relayId = actionRelay(def, env.relayId);
      const proposal: Proposal = {
        id: env.newId(),
        kind: 'action',
        actionId: def.id,
        title: def.title,
        input: parsed.data,
        diffLines,
        relayId,
        sensitive: !!def.sensitive,
        undoable: !!def.undo,
        requiresApproval: true,
        approve: {
          method: 'POST',
          path: actionPath(env.kernel.config().node.id, def, relayId),
          body: { input: parsed.data, reason: 'Suggested by the assistant' },
        },
      };
      return {
        ok: true,
        proposal,
        summary: `Prepared a suggestion: ${def.title} (not applied)`,
        result: {
          status: 'NOT APPLIED — shown to the admin as a suggestion to approve or dismiss',
          proposalId: proposal.id,
          diff: diffLines.map((d) => d.text),
        },
      };
    },
  };
}

/** Tools generated from the registry for this principal. */
export function actionTools(
  kernel: Pick<Kernel, 'actions'>,
  principal: Principal,
  relayId: RelayId | null,
  opts: { proposals: boolean },
): AssistantTool[] {
  const out: AssistantTool[] = [];
  for (const def of kernel.actions.list()) {
    if (!actionAvailable(def, principal, relayId)) continue;
    if (def.readOnly) {
      // Sensitive reads (exports, secrets) never go to a model that may be remote.
      if (!def.sensitive) out.push(readTool(def));
    } else if (opts.proposals) out.push(proposeTool(def));
  }
  return out;
}

// ───────────────────────────── built-in tools ─────────────────────────────

interface InsightsLike {
  series?(q: {
    metric: string;
    relayId?: RelayId | null;
    from: number;
    to: number;
    stepSeconds?: number;
    agg?: string;
  }): Promise<Array<{ t: number; v: number }>>;
  live?(relayId?: RelayId): unknown;
}

interface AuditLike {
  list(opts: { limit?: number; relayId?: RelayId | null }): Promise<{
    items: Array<{
      seq: number;
      at: number;
      relayId: RelayId | null;
      actionId: string;
      principalId: string;
      summary: string;
      ok: boolean;
      input?: unknown;
    }>;
  }>;
}

interface ConfigServiceLike {
  propose(
    input: { merge?: unknown; relayId?: RelayId | null; summary?: string },
    principal: Principal,
  ): Promise<{ id: string; diff: DiffLine[]; summary: string; expiresAt: number }>;
}

function builtin(
  name: string,
  description: string,
  parameters: z.ZodType,
  allowed: (p: Principal, relayId: RelayId | null) => boolean,
  run: (args: Record<string, unknown>, env: ToolEnv) => Promise<ToolOutcome>,
  kind: ToolKind = 'read',
): { tool: AssistantTool; allowed: typeof allowed } {
  const { schema } = toolParameters(parameters);
  return {
    allowed,
    tool: {
      kind,
      spec: { name, description, parameters: schema },
      async run(args, env) {
        if (!allowed(env.principal, env.relayId))
          return { ok: false, error: 'Not allowed for this admin' };
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success)
          return { ok: false, error: `Invalid input: ${issuesText(parsed.error)}` };
        return run(parsed.data as Record<string, unknown>, env);
      },
    },
  };
}

const RANK = { ok: 0, warn: 1, critical: 2 } as const;

async function health(kernel: Kernel, relayId: RelayId | null) {
  const checks = await Promise.all(
    kernel.health.map(async (h) => {
      let r: HealthResult;
      try {
        r = await withTimeout(h.run(relayId), 5000);
      } catch (err) {
        r = {
          score: 0,
          status: 'critical',
          message: 'This check could not run',
          technical: String(err),
        };
      }
      return { id: h.id, subsystem: h.subsystem, weight: h.weight, ...r };
    }),
  );
  const w = checks.reduce((a, c) => a + Math.max(0, c.weight), 0);
  const score =
    w > 0 ? Math.round(checks.reduce((a, c) => a + c.score * Math.max(0, c.weight), 0) / w) : 100;
  const status = checks.reduce<HealthResult['status']>(
    (a, c) => (RANK[c.status] > RANK[a] ? c.status : a),
    'ok',
  );
  return { score, status, checks };
}

async function cards(kernel: Kernel, relayId: RelayId | null, p: Principal) {
  const lists = await Promise.all(
    kernel.cards.map(async (s) => {
      try {
        return await withTimeout(s.cards(relayId), 5000);
      } catch {
        return [] as AttentionCard[];
      }
    }),
  );
  return lists
    .flat()
    .filter((c) =>
      relayId ? c.relayId === relayId || c.relayId === null : can(p, 'relay.read', c.relayId),
    )
    .slice(0, 30)
    .map((c) => ({
      title: c.title,
      body: c.body,
      technical: c.technical,
      severity: c.severity,
      relayId: c.relayId,
      suggestedAction: c.primary
        ? { label: c.primary.label, actionId: c.primary.actionId }
        : undefined,
    }));
}

const readRelay = (p: Principal, r: RelayId | null) => can(p, 'relay.read', r);
const readInsights = (p: Principal, r: RelayId | null) => can(p, 'insights.read', r);

/** Built-in tools available to this principal. */
export function builtinTools(
  kernel: Kernel,
  principal: Principal,
  relayId: RelayId | null,
  opts: { proposals: boolean; maxResultChars?: number },
): AssistantTool[] {
  const defs = [
    builtin(
      'get_health',
      'Overall health score (0-100) and the result of every health check.',
      z.object({}),
      readRelay,
      async (_a, env) => {
        const h = await health(env.kernel, env.relayId);
        return { ok: true, result: h, summary: `Health ${h.score}/100 (${h.status})` };
      },
    ),
    builtin(
      'get_cards',
      'Current attention cards (things that need the admin, with a suggested action each).',
      z.object({}),
      readRelay,
      async (_a, env) => {
        const list = await cards(env.kernel, env.relayId, env.principal);
        return { ok: true, result: list, summary: `${list.length} attention cards` };
      },
    ),
    builtin(
      'get_metrics',
      'A metric time series (e.g. "events.accepted", "events.rejected", "connections", "req.latency.p95", "errors"), or "live" for a live snapshot.',
      z.object({
        series: z.string().min(1).max(100).describe('Metric name, or "live"'),
        minutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 30)
          .default(60)
          .describe('How far back'),
        stepSeconds: z.number().int().min(10).max(86_400).optional(),
        agg: z.enum(['sum', 'avg', 'max', 'min', 'last']).default('avg'),
      }),
      readInsights,
      async (a, env) => {
        const insights = env.kernel.use<InsightsLike>('insights');
        if (a.series === 'live') {
          if (!insights?.live) return { ok: false, error: 'Live numbers are not available' };
          return {
            ok: true,
            result: insights.live(env.relayId ?? undefined),
            summary: 'Live snapshot',
          };
        }
        const to = env.kernel.ports.clock.now();
        const minutes = a.minutes as number;
        const from = to - minutes * 60;
        const stepSeconds =
          (a.stepSeconds as number | undefined) ?? Math.max(60, Math.round((minutes * 60) / 60));
        const agg = a.agg as 'sum' | 'avg' | 'max' | 'min' | 'last';
        const metric = a.series as string;
        const points = insights?.series
          ? await insights.series({ metric, relayId: env.relayId, from, to, stepSeconds, agg })
          : await env.kernel.ports.metrics.range({
              metric,
              labels: env.relayId ? { relay: env.relayId } : undefined,
              from,
              to,
              stepSeconds,
              agg,
            });
        return {
          ok: true,
          result: { metric, from, to, stepSeconds, points: points.slice(-120) },
          summary: `${points.length} points of ${metric}`,
        };
      },
    ),
    builtin(
      'get_recent_errors',
      'Recent internal errors (newest first). Network addresses are never included.',
      z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      readInsights,
      async (a, env) => {
        const list = env.errors?.list({ relayId: env.relayId, limit: a.limit as number }) ?? [];
        return { ok: true, result: list, summary: `${list.length} recent errors` };
      },
    ),
    builtin(
      'get_config_section',
      'One settings section, secrets hidden. Relay sections: info, persona, goals, access, tiers, limits, retention, blossom, public. Server sections: node, storage, blobStorage, alerts, ai, backups, privacy, plugins, relays. Dotted paths work (e.g. "access.wot").',
      z.object({ section: z.string().min(1).max(200) }),
      readRelay,
      async (a, env) => {
        const r = configSection(env.kernel.config(), a.section as string, env.relayId);
        return 'error' in r
          ? { ok: false, error: `${r.error}. Known sections: ${r.sections.join(', ')}` }
          : { ok: true, result: r.value, summary: `Read settings: ${a.section}` };
      },
    ),
    builtin(
      'explain_setting',
      'Plain explanation, technical note, default and current value of one setting (dotted path, e.g. "access.mode", "goals.openness", "privacy.ipLogging").',
      z.object({ path: z.string().min(1).max(200) }),
      readRelay,
      async (a, env) => {
        const r = explainSetting(env.kernel.config(), a.path as string, env.relayId);
        return r.found
          ? { ok: true, result: r, summary: `Explained ${r.path}` }
          : { ok: false, error: `No setting called "${r.path}"` };
      },
    ),
    builtin(
      'search_audit',
      'Search the activity history (who changed what, in plain sentences). Newest first.',
      z.object({
        query: z.string().max(200).optional().describe('Words to look for'),
        actionId: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      (p, r) => can(p, 'relay.read', r) && !!kernel.use<AuditLike>('admin.audit'),
      async (a, env) => {
        const audit = env.kernel.use<AuditLike>('admin.audit');
        if (!audit) return { ok: false, error: 'The activity history is not available' };
        const page = await audit.list({ limit: 200, relayId: env.relayId });
        const q = ((a.query as string | undefined) ?? '').toLowerCase();
        const withInputs = can(env.principal, 'compliance.read', null);
        const items = page.items
          .filter(
            (e) =>
              (!a.actionId || e.actionId === a.actionId) &&
              (!q || `${e.summary} ${e.actionId}`.toLowerCase().includes(q)),
          )
          .slice(0, a.limit as number)
          .map((e) => ({
            at: e.at,
            relayId: e.relayId,
            actionId: e.actionId,
            by: e.principalId,
            summary: e.summary,
            ok: e.ok,
            ...(withInputs ? { input: e.input } : {}),
          }));
        return { ok: true, result: items, summary: `${items.length} activity entries` };
      },
    ),
  ];
  if (opts.proposals)
    defs.push(
      builtin(
        'propose_settings_change',
        'Suggest a settings change as a JSON merge patch (relative to the relay in context, or to the whole server when there is none). Does NOT apply anything: returns the plain-language diff for the admin to approve.',
        z.object({
          merge: z
            .record(z.string(), z.unknown())
            .describe('JSON merge patch, e.g. {"goals":{"openness":40}}'),
          summary: z.string().max(200).optional().describe('One plain sentence'),
        }),
        (p, r) => can(p, 'config.write', r) && !!kernel.use<ConfigServiceLike>('admin.config'),
        async (a, env) => {
          const svc = env.kernel.use<ConfigServiceLike>('admin.config');
          if (!svc) return { ok: false, error: 'Settings changes are not available' };
          let proposal: Awaited<ReturnType<ConfigServiceLike['propose']>>;
          try {
            proposal = await svc.propose(
              { merge: a.merge, relayId: env.relayId, summary: a.summary as string | undefined },
              env.principal,
            );
          } catch (err) {
            return {
              ok: false,
              error: `That change is not valid: ${truncate(String((err as Error).message ?? err), 300)}`,
            };
          }
          const nodeId = env.kernel.config().node.id;
          const out: Proposal = {
            id: env.newId(),
            kind: 'settings',
            actionId: 'config.commit',
            title: proposal.summary || 'Change settings',
            input: { proposalId: proposal.id },
            diffLines: proposal.diff,
            relayId: env.relayId,
            sensitive: false,
            undoable: true,
            requiresApproval: true,
            approve: {
              method: 'POST',
              path: env.relayId
                ? `/api/v1/nodes/${nodeId}/relays/${env.relayId}/config/commit`
                : `/api/v1/nodes/${nodeId}/config/commit`,
              body: { proposalId: proposal.id },
            },
          };
          return {
            ok: true,
            proposal: out,
            summary: 'Prepared a settings suggestion (not applied)',
            result: {
              status: 'NOT APPLIED — shown to the admin as a suggestion to approve or dismiss',
              diff: proposal.diff.map((d) => d.text),
            },
          };
        },
        'propose',
      ),
    );
  return defs.filter((d) => d.allowed(principal, relayId)).map((d) => d.tool);
}

/** All tools for one request, deduplicated by name (built-ins win). */
export function toolsFor(
  kernel: Kernel,
  principal: Principal,
  relayId: RelayId | null,
  opts: { proposals: boolean },
): AssistantTool[] {
  const out = new Map<string, AssistantTool>();
  for (const t of builtinTools(kernel, principal, relayId, opts)) out.set(t.spec.name, t);
  for (const t of actionTools(kernel, principal, relayId, opts))
    if (!out.has(t.spec.name)) out.set(t.spec.name, t);
  return [...out.values()];
}
