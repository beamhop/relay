// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Activity feed + audit log, live SSE channel, and aggregates of the
 * kernel's health checks, attention cards, UI manifest and playbooks.
 */
import {
  type AppEventName,
  type AppEvents,
  type AttentionCard,
  type HealthResult,
  type Permission,
  type Principal,
  type RelayId,
  type Subsystem,
  can,
} from '@beamhop/core';
import type { AuditEntry } from '../audit.ts';
import { displayNameOf } from '../auth/directory.ts';
import { HttpError, lowerFirst, redact } from '../util.ts';
import { type Api, type Deps, op, requirePrincipal } from './api.ts';

// ───────────────────────────── activity ─────────────────────────────

export async function activityItems(deps: Deps, entries: AuditEntry[]) {
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    let n = names.get(id);
    if (!n) {
      if (id.startsWith('token:')) n = 'An API token';
      else if (id.startsWith('file:')) n = id.slice(5);
      else if (id === 'system') n = 'Beamhop';
      else n = displayNameOf(await deps.dir.get(id), id);
      names.set(id, n);
    }
    return n;
  };
  return Promise.all(
    entries.map(async (e) => {
      const actor = await nameOf(e.principalId);
      return {
        seq: e.seq,
        at: e.at,
        relayId: e.relayId,
        actionId: e.actionId,
        actor,
        ok: e.ok,
        text: `${actor} ${lowerFirst(e.summary)}`,
      };
    }),
  );
}

// ───────────────────────────── live channel ─────────────────────────────

/** Permission needed to see each bus event; absent → never streamed. */
export const EVENT_PERMISSIONS: Record<AppEventName, Permission> = {
  'conn.open': 'insights.read',
  'conn.close': 'insights.read',
  'event.accepted': 'relay.read',
  'event.rejected': 'relay.read',
  'event.held': 'moderation.write',
  'event.deleted': 'relay.read',
  'req.served': 'insights.read',
  'auth.success': 'insights.read',
  'report.received': 'moderation.write',
  'blob.uploaded': 'relay.read',
  'blob.deleted': 'relay.read',
  'blob.quarantined': 'media.write',
  'admin.action': 'relay.read',
  'config.changed': 'relay.read',
  error: 'insights.read',
};

/** High-volume events are only streamed when explicitly requested with `?events=`. */
const DEFAULT_EXCLUDED = new Set<AppEventName>([
  'event.accepted',
  'req.served',
  'conn.open',
  'conn.close',
]);

export function liveAllowed(
  p: Principal,
  name: AppEventName,
  payload: unknown,
  scopeRelay: RelayId | null,
): boolean {
  const perm = EVENT_PERMISSIONS[name];
  if (!perm) return false;
  const rid = (payload as { relayId?: RelayId | null }).relayId ?? null;
  if (scopeRelay && rid !== scopeRelay) return false;
  // Node-wide events (no relay) need node-level permission; relay events need it on that relay.
  return can(p, perm, rid);
}

/** SSE event carrying insights live snapshots (`kernel.use('insights').onLive`) for sparklines. */
export const INSIGHTS_TICK = 'insights.tick';

interface LiveSnapshotLike {
  at: number;
  relays: Array<{ relayId: RelayId } & Record<string, unknown>>;
  storage?: unknown;
  disk?: unknown;
}

interface InsightsLiveLike {
  onLive?(fn: (s: LiveSnapshotLike) => void): () => void;
}

/**
 * The part of a live snapshot this principal may see: relays they hold
 * `insights.read` on (only `scopeRelay` on a relay route); node-wide storage
 * and disk only with node-level `insights.read`. Null when nothing is visible.
 */
export function tickFor(
  p: Principal,
  snap: LiveSnapshotLike,
  scopeRelay: RelayId | null,
): LiveSnapshotLike | null {
  const relays = (snap.relays ?? []).filter(
    (r) => (!scopeRelay || r.relayId === scopeRelay) && can(p, 'insights.read', r.relayId),
  );
  const node = !scopeRelay && can(p, 'insights.read', null);
  if (relays.length === 0 && !node) return null;
  return {
    at: snap.at,
    relays,
    storage: node ? (snap.storage ?? null) : null,
    disk: node ? (snap.disk ?? null) : null,
  };
}

// ───────────────────────────── health / cards ─────────────────────────────

const RANK = { ok: 0, warn: 1, critical: 2 } as const;
const SEV = { info: 0, warning: 1, critical: 2 } as const;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function aggregateHealth(deps: Deps, relayId: RelayId | null) {
  const checks = await Promise.all(
    deps.kernel.health.map(async (h) => {
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
      const score = Math.max(0, Math.min(100, r.score));
      return { id: h.id, subsystem: h.subsystem, weight: h.weight, ...r, score };
    }),
  );
  const weighted = (xs: typeof checks) => {
    const w = xs.reduce((a, x) => a + Math.max(0, x.weight), 0);
    return w > 0
      ? Math.round(xs.reduce((a, x) => a + x.score * Math.max(0, x.weight), 0) / w)
      : 100;
  };
  const worst = (xs: typeof checks): HealthResult['status'] =>
    xs.reduce<HealthResult['status']>((a, x) => (RANK[x.status] > RANK[a] ? x.status : a), 'ok');
  const bySub = new Map<Subsystem, typeof checks>();
  for (const c of checks) bySub.set(c.subsystem, [...(bySub.get(c.subsystem) ?? []), c]);
  const subsystems = [...bySub.entries()].map(([subsystem, xs]) => ({
    subsystem,
    score: weighted(xs),
    status: worst(xs),
    message: xs.find((x) => x.status === worst(xs))?.message ?? 'All good',
  }));
  const status = worst(checks);
  const score = weighted(checks);
  const message =
    status === 'ok'
      ? 'Everything looks healthy'
      : (checks.filter((c) => c.status === status).map((c) => c.message)[0] ?? 'Needs attention');
  return { score, status, message, subsystems, checks };
}

export type MergedCard = AttentionCard & { count: number; items?: AttentionCard[] };

export async function aggregateCards(deps: Deps, relayId: RelayId | null, p: Principal) {
  const lists = await Promise.all(
    deps.kernel.cards.map(async (s) => {
      try {
        return await withTimeout(s.cards(relayId), 5000);
      } catch (err) {
        deps.kernel.ports.logger.log('warn', 'card source failed', {
          source: s.id,
          error: String(err),
        });
        return [];
      }
    }),
  );
  const visible = lists
    .flat()
    .filter((c) =>
      relayId ? c.relayId === relayId || c.relayId === null : can(p, 'relay.read', c.relayId),
    );
  const merged: MergedCard[] = [];
  const batches = new Map<string, MergedCard>();
  for (const c of visible) {
    if (!c.batchKey) {
      merged.push({ ...c, count: 1 });
      continue;
    }
    const b = batches.get(c.batchKey);
    if (!b) {
      const m: MergedCard = { ...c, id: `batch:${c.batchKey}`, count: 1, items: [c] };
      batches.set(c.batchKey, m);
      merged.push(m);
    } else {
      b.items!.push(c);
      b.count++;
      if (SEV[c.severity] > SEV[b.severity]) b.severity = c.severity;
      b.createdAt = Math.max(b.createdAt, c.createdAt);
    }
  }
  for (const b of batches.values()) if (b.count === 1) b.items = undefined;
  const withAllowed = merged.map((m) => ({
    ...m,
    primaryAllowed: m.primary ? actionAllowed(deps, p, m.primary.actionId, m.relayId) : undefined,
  }));
  return withAllowed.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.createdAt - a.createdAt);
}

function actionAllowed(
  deps: Deps,
  p: Principal,
  actionId: string,
  relayId: RelayId | null,
): boolean {
  const def = deps.kernel.actions.get(actionId);
  return !!def && can(p, def.permission, relayId);
}

// ───────────────────────────── routes ─────────────────────────────

export function liveRoutes(api: Api, deps: Deps): void {
  const { kernel, audit } = deps;

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/activity',
      scope: 'both',
      guard: 'relay.read',
      tags: ['Activity'],
      summary: 'Who did what, in plain sentences',
      query: { limit: 'Max items', cursor: 'Paging cursor' },
    },
    async (c, { relayId }) => {
      const opts: Parameters<typeof audit.list>[0] = { relayId };
      const limit = c.req.query('limit');
      const cursor = c.req.query('cursor');
      if (limit) opts.limit = Number(limit);
      if (cursor) opts.cursor = cursor;
      const page = await audit.list(opts);
      return c.json({ items: await activityItems(deps, page.items), cursor: page.cursor });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/audit',
      scope: 'node',
      guard: 'compliance.read',
      tags: ['Activity'],
      summary: 'Raw audit log entries (hash-chained)',
      query: { limit: 'Max items', cursor: 'Paging cursor', relay: 'Only this relay' },
    },
    async (c) => {
      const opts: Parameters<typeof audit.list>[0] = {};
      const limit = c.req.query('limit');
      const cursor = c.req.query('cursor');
      const relay = c.req.query('relay');
      if (limit) opts.limit = Number(limit);
      if (cursor) opts.cursor = cursor;
      if (relay) opts.relayId = relay;
      return c.json(await audit.list(opts));
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/audit/verify',
      scope: 'node',
      guard: 'compliance.read',
      tags: ['Activity'],
      summary: 'Check that the audit log has not been tampered with',
    },
    async (c) => c.json(await audit.verify()),
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/live',
      scope: 'both',
      guard: 'relay.read',
      tags: ['Live'],
      summary: 'Live updates (Server-Sent Events), filtered by your permissions',
      produces: 'text/event-stream',
      query: {
        events: `Comma-separated event names (default: all low-volume events plus ${INSIGHTS_TICK})`,
      },
    },
    (c, { relayId }) => {
      const p = requirePrincipal(c);
      const requested = c.req.query('events');
      const all = Object.keys(EVENT_PERMISSIONS) as AppEventName[];
      const asked = requested ? requested.split(',').map((s) => s.trim()) : null;
      const names = asked
        ? (asked as AppEventName[]).filter((n) => n in EVENT_PERMISSIONS)
        : all.filter((n) => !DEFAULT_EXCLUDED.has(n));
      const insights = kernel.use<InsightsLiveLike>('insights');
      const ticks =
        typeof insights?.onLive === 'function' && (!asked || asked.includes(INSIGHTS_TICK));
      if (names.length === 0 && !ticks)
        throw new HttpError(400, 'bad_request', 'No known events requested');
      const enc = new TextEncoder();
      const offs: Array<() => void> = [];
      let timer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        for (const off of offs) off();
        if (timer) clearInterval(timer);
      };
      let seq = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (chunk: string) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(chunk));
            } catch {
              cleanup();
            }
          };
          const streamed = ticks ? [...names, INSIGHTS_TICK] : names;
          send(
            `: connected\nretry: 3000\n\nevent: ready\ndata: ${JSON.stringify({ events: streamed, relayId })}\n\n`,
          );
          if (ticks && insights?.onLive) {
            offs.push(
              insights.onLive((snap) => {
                const visible = tickFor(p, snap, relayId);
                if (!visible) return;
                send(`id: ${++seq}\nevent: ${INSIGHTS_TICK}\ndata: ${JSON.stringify(visible)}\n\n`);
              }),
            );
          }
          for (const name of names) {
            offs.push(
              kernel.bus.on(name, (payload: AppEvents[typeof name]) => {
                if (!liveAllowed(p, name, payload, relayId)) return;
                send(`id: ${++seq}\nevent: ${name}\ndata: ${JSON.stringify(redact(payload))}\n\n`);
              }),
            );
          }
          timer = setInterval(
            () => send(': ping\n\n'),
            deps.settings().live.heartbeatSeconds * 1000,
          );
          c.req.raw.signal?.addEventListener('abort', () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/health',
      scope: 'both',
      guard: 'relay.read',
      tags: ['Home'],
      summary: 'Health score (0–100) with subsystems',
    },
    async (c, { relayId }) => c.json(await aggregateHealth(deps, relayId)),
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/cards',
      scope: 'both',
      guard: 'relay.read',
      tags: ['Home'],
      summary: 'Attention cards (similar ones batched together)',
    },
    async (c, { relayId }) =>
      c.json({ cards: await aggregateCards(deps, relayId, requirePrincipal(c)) }),
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/ui',
      scope: 'node',
      guard: 'authenticated',
      tags: ['Home'],
      summary: 'Screens contributed by enabled modules',
    },
    (c) => c.json({ routes: kernel.ui }),
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/playbooks',
      scope: 'node',
      guard: 'authenticated',
      tags: ['Help'],
      summary: 'Guided playbooks',
    },
    (c) =>
      c.json({
        playbooks: kernel.playbooks.map((p) => ({
          id: p.id,
          title: p.title,
          steps: p.steps.length,
        })),
      }),
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/playbooks/{id}',
      scope: 'node',
      guard: 'authenticated',
      tags: ['Help'],
      summary: 'One playbook with its steps',
    },
    (c) => {
      const pb = kernel.playbooks.find((p) => p.id === c.req.param('id'));
      if (!pb) throw new HttpError(404, 'not_found', 'That playbook does not exist');
      return c.json(pb);
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/nodes',
      scope: 'root',
      guard: 'authenticated',
      tags: ['Fleet'],
      summary: 'Servers this API can manage (v1: this one)',
    },
    (c) => {
      const p = requirePrincipal(c);
      const cfg = kernel.config();
      return c.json({
        nodes: [
          {
            id: cfg.node.id,
            runtime: kernel.runtime,
            relays: cfg.relays
              .filter((r) => can(p, 'relay.read', r.id))
              .map((r) => ({ id: r.id, name: r.info.name, hosts: r.hosts, persona: r.persona })),
          },
        ],
      });
    },
  );
}
