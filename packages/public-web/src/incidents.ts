// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Status-page incidents (DocStore `public.incidents`), the admin actions that
 * edit them, and auto-opening from critical alerts.
 */
import {
  type ActionContext,
  type ActionDef,
  type Kernel,
  type Notification,
  type Ports,
  type RelayId,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';

export const INCIDENTS = 'public.incidents';
export const UNDO_SECONDS = 300;

export const IncidentState = z.enum(['investigating', 'identified', 'monitoring', 'resolved']);
export type IncidentState = z.infer<typeof IncidentState>;
export const IncidentImpact = z.enum(['minor', 'major', 'outage']);
export type IncidentImpact = z.infer<typeof IncidentImpact>;

export interface IncidentUpdate {
  at: number;
  state: IncidentState;
  message: string;
}

export interface Incident {
  id: string;
  relayId: RelayId;
  title: string;
  impact: IncidentImpact;
  state: IncidentState;
  openedAt: number;
  resolvedAt?: number;
  updates: IncidentUpdate[];
  source: 'admin' | 'alert';
  /** Dedupe key for alert-opened incidents. */
  alertKey?: string;
}

const key = (relayId: RelayId, id: string) => `${relayId}:${id}`;

export class IncidentStore {
  constructor(private readonly ports: Ports) {}

  newId(): string {
    return `${String(this.ports.clock.nowMs()).padStart(14, '0')}-${this.ports.crypto.randomHex(3)}`;
  }

  get(relayId: RelayId, id: string): Promise<Incident | null> {
    return this.ports.docs.get<Incident>(INCIDENTS, key(relayId, id));
  }

  put(inc: Incident): Promise<void> {
    return this.ports.docs.put(INCIDENTS, key(inc.relayId, inc.id), inc);
  }

  delete(relayId: RelayId, id: string): Promise<boolean> {
    return this.ports.docs.delete(INCIDENTS, key(relayId, id));
  }

  /** Newest first. */
  async list(relayId: RelayId, limit = 50): Promise<Incident[]> {
    const { items } = await this.ports.docs.list<Incident>(INCIDENTS, {
      prefix: `${relayId}:`,
      reverse: true,
      limit,
    });
    return items.map((i) => i.value);
  }

  async open(relayId: RelayId): Promise<Incident[]> {
    return (await this.list(relayId)).filter((i) => i.state !== 'resolved');
  }

  async create(input: {
    relayId: RelayId;
    title: string;
    impact: IncidentImpact;
    message: string;
    state?: IncidentState;
    source?: Incident['source'];
    alertKey?: string;
  }): Promise<Incident> {
    const now = this.ports.clock.now();
    const state = input.state ?? 'investigating';
    const inc: Incident = {
      id: this.newId(),
      relayId: input.relayId,
      title: input.title,
      impact: input.impact,
      state,
      openedAt: now,
      updates: [{ at: now, state, message: input.message }],
      source: input.source ?? 'admin',
    };
    if (input.alertKey) inc.alertKey = input.alertKey;
    await this.put(inc);
    return inc;
  }

  /**
   * Open an incident for a critical alert unless one with the same alert key
   * is already open. Returns the incident, or null when not critical.
   */
  fromAlert(n: Notification & { key?: string }, relays: RelayId[]): Promise<Incident[]> {
    if (n.severity !== 'critical') return Promise.resolve([]);
    // Serialize so a burst of the same alert opens one incident.
    const run = this.alertChain.then(() => this.openForAlert(n, relays));
    this.alertChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private alertChain: Promise<void> = Promise.resolve();

  private async openForAlert(
    n: Notification & { key?: string },
    relays: RelayId[],
  ): Promise<Incident[]> {
    const targets = n.relayId ? [n.relayId] : relays;
    const alertKey = n.key ?? n.title;
    const out: Incident[] = [];
    for (const relayId of targets) {
      const existing = (await this.open(relayId)).find((i) => i.alertKey === alertKey);
      if (existing) {
        out.push(existing);
        continue;
      }
      out.push(
        await this.create({
          relayId,
          title: n.title,
          impact: 'major',
          message: n.body,
          source: 'alert',
          alertKey,
        }),
      );
    }
    return out;
  }
}

// ───────────────────────────── actions ─────────────────────────────

function needRelay(ctx: ActionContext, input: { relayId?: string }): RelayId {
  const id = ctx.relayId ?? input.relayId;
  if (!id) throw new Error('choose a relay first');
  return id;
}

async function mustGet(store: IncidentStore, relayId: RelayId, id: string): Promise<Incident> {
  const inc = await store.get(relayId, id);
  if (!inc) throw new Error('incident not found');
  return inc;
}

const STATE_TEXT: Record<IncidentState, string> = {
  investigating: 'Investigating',
  identified: 'Cause found',
  monitoring: 'Fix applied, watching',
  resolved: 'Resolved',
};

export function createIncidentActions(kernel: Kernel, store: IncidentStore): ActionDef[] {
  const undo = (actionId: string, payload: unknown) => ({
    actionId,
    payload,
    expiresAt: kernel.ports.clock.now() + UNDO_SECONDS,
  });
  const restore = async (payload: unknown) => {
    const p = payload as { before: Incident | null; relayId: RelayId; id: string };
    if (p.before) await store.put(p.before);
    else await store.delete(p.relayId, p.id);
  };

  const open = defineAction({
    id: 'status.open-incident',
    title: 'Post an incident',
    description: 'Tell users on the status page that something is wrong.',
    technical: `Creates a ${INCIDENTS} document shown on /status of this relay.`,
    scope: 'relay',
    permission: 'moderation.write',
    keywords: ['status', 'incident', 'outage', 'downtime'],
    input: z.object({
      relayId: z.string().optional(),
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(5000),
      impact: IncidentImpact.default('minor'),
      state: IncidentState.exclude(['resolved']).default('investigating'),
    }),
    async preview(input) {
      return [{ kind: 'add', text: `Status page shows "${input.title}" (${input.impact} impact)` }];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx, input);
      const inc = await store.create({ ...input, relayId });
      return {
        output: inc,
        summary: `Incident posted: ${inc.title}`,
        undo: undo('status.open-incident', { before: null, relayId, id: inc.id }),
      };
    },
    undo: restore,
  });

  const update = defineAction({
    id: 'status.update-incident',
    title: 'Update an incident',
    description: 'Post progress on an incident shown on the status page.',
    technical: `Appends an update to a ${INCIDENTS} document.`,
    scope: 'relay',
    permission: 'moderation.write',
    keywords: ['status', 'incident'],
    input: z.object({
      relayId: z.string().optional(),
      id: z.string().min(1),
      message: z.string().min(1).max(5000),
      state: IncidentState.exclude(['resolved']).optional(),
      impact: IncidentImpact.optional(),
      title: z.string().min(1).max(200).optional(),
    }),
    async preview(input, ctx) {
      const inc = await mustGet(store, needRelay(ctx, input), input.id);
      const lines: Array<{ kind: 'change' | 'add'; text: string }> = [
        { kind: 'add', text: `New update on "${inc.title}": ${input.message}` },
      ];
      if (input.state && input.state !== inc.state)
        lines.push({
          kind: 'change',
          text: `Status: ${STATE_TEXT[inc.state]} → ${STATE_TEXT[input.state]}`,
        });
      if (input.impact && input.impact !== inc.impact)
        lines.push({ kind: 'change', text: `Impact: ${inc.impact} → ${input.impact}` });
      return lines;
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx, input);
      const before = await mustGet(store, relayId, input.id);
      const state = input.state ?? (before.state === 'resolved' ? 'monitoring' : before.state);
      const next: Incident = {
        ...before,
        title: input.title ?? before.title,
        impact: input.impact ?? before.impact,
        state,
        updates: [
          ...before.updates,
          { at: kernel.ports.clock.now(), state, message: input.message },
        ],
      };
      next.resolvedAt = undefined;
      await store.put(next);
      return {
        output: next,
        summary: `Incident updated: ${next.title}`,
        undo: undo('status.update-incident', { before, relayId, id: before.id }),
      };
    },
    undo: restore,
  });

  const resolve = defineAction({
    id: 'status.resolve-incident',
    title: 'Resolve an incident',
    description: 'Mark an incident as fixed on the status page.',
    technical: `Sets state=resolved on a ${INCIDENTS} document.`,
    scope: 'relay',
    permission: 'moderation.write',
    keywords: ['status', 'incident', 'fixed', 'resolved'],
    input: z.object({
      relayId: z.string().optional(),
      id: z.string().min(1),
      message: z.string().min(1).max(5000).default('This incident has been resolved.'),
    }),
    async preview(input, ctx) {
      const inc = await mustGet(store, needRelay(ctx, input), input.id);
      return [{ kind: 'change', text: `"${inc.title}" is shown as resolved` }];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx, input);
      const before = await mustGet(store, relayId, input.id);
      const now = kernel.ports.clock.now();
      const next: Incident = {
        ...before,
        state: 'resolved',
        resolvedAt: now,
        updates: [...before.updates, { at: now, state: 'resolved', message: input.message }],
      };
      await store.put(next);
      return {
        output: next,
        summary: `Incident resolved: ${next.title}`,
        undo: undo('status.resolve-incident', { before, relayId, id: before.id }),
      };
    },
    undo: restore,
  });

  return [open, update, resolve] as unknown as ActionDef[];
}
