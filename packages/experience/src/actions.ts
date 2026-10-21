// SPDX-License-Identifier: AGPL-3.0-or-later
/** Every experience operation is an action (generated into REST, CLI, palette and AI tools). */
import {
  type ActionContext,
  type ActionDef,
  type DiffLine,
  type Kernel,
  type RelayConfig,
  type RelayId,
  can,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import type { AdminTimeTracker } from './admin-time.ts';
import { buildChecklist } from './checklist.ts';
import type { CardStateEntry, InboxCard, SuggestionsEngine } from './inbox.ts';
import {
  type OutsideDialer,
  type TestRelayReport,
  buildLaunchKit,
  testRelay,
} from './launch-kit.ts';
import { simulateChange } from './simulate.ts';
import { COL, ExperienceError, childContext, plural } from './util.ts';
import { type RejectionRing, explainWhy } from './why.ts';

export interface ActionDeps {
  kernel: Kernel;
  engine: SuggestionsEngine;
  ring: RejectionRing;
  time: AdminTimeTracker;
  dialer: () => OutsideDialer;
  testTimeoutMs: number;
}

const DEFAULT_UNDO_SECONDS = 300;

function undoWindow(kernel: Kernel): number {
  const cfg = kernel.moduleConfig<{ undoWindowSeconds?: number }>('admin-api');
  return cfg?.undoWindowSeconds ?? DEFAULT_UNDO_SECONDS;
}

function relayOf(kernel: Kernel, ctx: ActionContext): RelayConfig {
  const relay = ctx.relayId ? kernel.relay(ctx.relayId) : undefined;
  if (!relay) throw new ExperienceError(404, 'not_found', 'That relay does not exist');
  return relay;
}

async function findCard(deps: ActionDeps, key: string, ctx: ActionContext): Promise<InboxCard> {
  const card = await deps.engine.find(key);
  if (!card || !can(ctx.principal, 'relay.read', card.relayId))
    throw new ExperienceError(
      404,
      'card_gone',
      'This suggestion is gone — the problem may have resolved itself.',
    );
  return card;
}

interface ApprovePayload {
  principalId: string;
  key: string;
  prev?: CardStateEntry;
  items: Array<{ actionId: string; relayId: RelayId | null; payload: unknown }>;
}

interface CardStatePayload {
  principalId: string;
  key: string;
  prev?: CardStateEntry;
}

export function createActions(deps: ActionDeps): ActionDef[] {
  const { kernel, engine } = deps;
  const now = () => kernel.ports.clock.now();

  /** Resolve the action behind a card and check the admin may run it there. */
  const resolvePrimary = (card: InboxCard, ctx: ActionContext) => {
    if (!card.primary)
      throw new ExperienceError(400, 'no_action', 'This suggestion has nothing to approve.');
    const def = kernel.actions.get(card.primary.actionId);
    if (!def)
      throw new ExperienceError(
        404,
        'unknown_action',
        'The action behind this suggestion is not available.',
        card.primary.actionId,
      );
    const relayId = def.scope === 'relay' ? card.relayId : null;
    if (def.scope === 'relay' && !relayId)
      throw new ExperienceError(400, 'wrong_scope', 'This suggestion is missing its relay.');
    if (!can(ctx.principal, def.permission, relayId))
      throw new ExperienceError(
        403,
        'forbidden',
        `You don't have permission to “${def.title}”`,
        `requires ${def.permission}`,
      );
    return { def, relayId, inputs: card.primary.inputs.map((i) => def.input.parse(i ?? {})) };
  };

  const inbox = defineAction({
    id: 'experience.inbox',
    title: 'Home inbox',
    description:
      'Everything that needs a look, most urgent first. Similar items are grouped. Nothing here changes on its own.',
    technical:
      'Aggregates kernel.cards (CardSource), dedupes by card id, batches by relay+batchKey, ranks by severity then age; per-admin dismiss/snooze from experience.card-state.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    // Filtered per principal: open to admins of any relay (admin-api `mayRun`).
    anyRelay: true,
    keywords: ['home', 'cards', 'suggestions', 'attention', 'inbox'],
    input: z.object({ relayId: z.string().optional().describe('Only this relay') }),
    async run(input, ctx) {
      const out = await engine.inbox(ctx.principal, input.relayId ?? null);
      return { output: out, summary: out.message };
    },
  });

  const approve = defineAction({
    id: 'experience.approve-card',
    title: 'Approve a suggestion',
    description:
      'Do what the suggestion proposes. It runs like any other change: recorded in the activity log and undoable.',
    technical:
      'Runs the card primary action (one run per batched member) via the action registry with the admin’s own permissions; emits admin.action per run; undo reverts every run.',
    scope: 'node',
    permission: 'relay.read',
    keywords: ['approve', 'accept', 'suggestion', 'card'],
    input: z.object({ key: z.string().min(1).describe('Card key from the inbox') }),
    async preview(input, ctx) {
      const card = await findCard(deps, input.key, ctx);
      const { def, relayId, inputs } = resolvePrimary(card, ctx);
      const lines: DiffLine[] = [];
      if (def.preview) {
        for (const i of inputs.slice(0, 3))
          lines.push(...(await def.preview(i, { ...childContext(ctx, relayId), dryRun: true })));
        if (inputs.length > 3)
          lines.push({ kind: 'info', text: `…and ${plural(inputs.length - 3, 'more change')}` });
      } else {
        lines.push({
          kind: 'info',
          text: `${def.title}${inputs.length > 1 ? ` (${inputs.length} times)` : ''}`,
          technical: def.id,
        });
      }
      if (!def.undo && !def.readOnly)
        lines.push({ kind: 'warning', text: 'This one cannot be undone afterwards.' });
      return lines;
    },
    async run(input, ctx) {
      const card = await findCard(deps, input.key, ctx);
      const { def, relayId, inputs } = resolvePrimary(card, ctx);
      const childCtx = childContext(ctx, relayId);
      const done: Array<{ payload: unknown; expiresAt: number } | null> = [];
      const outputs: unknown[] = [];
      const summaries: string[] = [];
      for (const i of inputs) {
        try {
          const r = await def.run(i, childCtx);
          outputs.push(r.output);
          summaries.push(r.summary);
          done.push(r.undo ? { payload: r.undo.payload, expiresAt: r.undo.expiresAt } : null);
          if (!def.readOnly)
            kernel.bus.emit('admin.action', {
              relayId,
              actionId: def.id,
              principalId: ctx.principal.id,
              input: i,
              summary: `${r.summary} (approved suggestion)`,
              ok: true,
            });
        } catch (err) {
          // Roll back what already ran so a half-applied batch never lingers.
          if (def.undo)
            for (const d of done.reverse())
              if (d) await def.undo(d.payload, childCtx).catch(() => {});
          kernel.bus.emit('admin.action', {
            relayId,
            actionId: def.id,
            principalId: ctx.principal.id,
            input: i,
            summary: `Tried to approve “${card.title}”, but it failed`,
            ok: false,
          });
          throw err;
        }
      }
      const prev = await engine.state.update(ctx.principal.id, card.key, {
        state: 'approved',
        at: now(),
        members: card.members,
      });
      const summary =
        summaries.length === 1
          ? (summaries[0] as string)
          : `${card.primary!.label}: ${plural(summaries.length, 'change')} done`;
      const undoable = !!def.undo && done.length > 0 && done.every((d) => d !== null);
      const payload: ApprovePayload = {
        principalId: ctx.principal.id,
        key: card.key,
        items: done.map((d) => ({ actionId: def.id, relayId, payload: d?.payload })),
      };
      if (prev) payload.prev = prev;
      return {
        output: { key: card.key, actionId: def.id, runs: outputs.length, outputs },
        summary,
        ...(undoable
          ? {
              undo: {
                actionId: 'experience.approve-card',
                payload,
                expiresAt: Math.min(...done.map((d) => d!.expiresAt)),
              },
            }
          : {}),
      };
    },
    async undo(raw, ctx) {
      const p = raw as ApprovePayload;
      for (const item of [...p.items].reverse()) {
        const def = kernel.actions.get(item.actionId);
        if (!def?.undo) continue;
        if (!can(ctx.principal, def.permission, item.relayId))
          throw new ExperienceError(403, 'forbidden', `You don't have permission to undo this`);
        await def.undo(item.payload, childContext(ctx, item.relayId));
      }
      await engine.state.update(p.principalId, p.key, p.prev ?? null);
    },
  });

  const setState = async (
    ctx: ActionContext,
    key: string,
    entry: (card: InboxCard) => CardStateEntry,
  ) => {
    const card = await findCard(deps, key, ctx);
    const prev = await engine.state.update(ctx.principal.id, card.key, entry(card));
    const payload: CardStatePayload = { principalId: ctx.principal.id, key: card.key };
    if (prev) payload.prev = prev;
    return { card, payload };
  };
  const undoState = async (raw: unknown) => {
    const p = raw as CardStatePayload;
    await engine.state.update(p.principalId, p.key, p.prev ?? null);
  };

  const dismiss = defineAction({
    id: 'experience.dismiss-card',
    title: 'Dismiss a suggestion',
    description:
      'Hide this suggestion for you. It comes back only if something new is added to it.',
    technical:
      'Per-principal state in experience.card-state; hidden until the batch gains a new member id.',
    scope: 'node',
    permission: 'relay.read',
    keywords: ['dismiss', 'hide', 'ignore'],
    shortcut: 'e',
    input: z.object({ key: z.string().min(1) }),
    async preview(input, ctx) {
      const card = await findCard(deps, input.key, ctx);
      return [
        { kind: 'remove', text: `“${card.title}” will be hidden for you`, technical: card.key },
      ];
    },
    async run(input, ctx) {
      const { card, payload } = await setState(ctx, input.key, (c) => ({
        state: 'dismissed',
        at: now(),
        members: c.members,
      }));
      return {
        output: { key: card.key },
        summary: `Dismissed “${card.title}”`,
        undo: {
          actionId: 'experience.dismiss-card',
          payload,
          expiresAt: now() + undoWindow(kernel),
        },
      };
    },
    undo: undoState,
  });

  const snooze = defineAction({
    id: 'experience.snooze-card',
    title: 'Remind me later',
    description: 'Hide this suggestion for a while. It comes back by itself.',
    technical: 'Per-principal snooze in experience.card-state with an `until` timestamp.',
    scope: 'node',
    permission: 'relay.read',
    keywords: ['snooze', 'later', 'remind'],
    input: z.object({
      key: z.string().min(1),
      hours: z
        .number()
        .int()
        .min(1)
        .max(24 * 14)
        .default(24)
        .describe('For how many hours'),
    }),
    async preview(input, ctx) {
      const card = await findCard(deps, input.key, ctx);
      return [
        {
          kind: 'change',
          text: `“${card.title}” will come back in ${plural(input.hours, 'hour')}`,
          technical: `${card.key} until=${now() + input.hours * 3600}`,
        },
      ];
    },
    async run(input, ctx) {
      const until = now() + input.hours * 3600;
      const { card, payload } = await setState(ctx, input.key, (c) => ({
        state: 'snoozed',
        at: now(),
        until,
        members: c.members,
      }));
      return {
        output: { key: card.key, until },
        summary: `Snoozed “${card.title}” for ${plural(input.hours, 'hour')}`,
        undo: {
          actionId: 'experience.snooze-card',
          payload,
          expiresAt: now() + undoWindow(kernel),
        },
      };
    },
    undo: undoState,
  });

  const checklist = defineAction({
    id: 'experience.checklist',
    title: 'Setup checklist',
    description:
      'The few things that make a new relay safe and easy to run. Hides itself when done.',
    technical:
      'Derived from admin.directory (recovery codes, admin count), config.backups / lifecycle.lastBackup, config.alerts.channels, relays[].info, experience.test-runs.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    // Filtered per principal: open to admins of any relay (admin-api `mayRun`).
    anyRelay: true,
    keywords: ['setup', 'checklist', 'onboarding', 'first week'],
    input: z.object({}),
    async run() {
      const out = await buildChecklist(kernel);
      return {
        output: out,
        summary: out.complete
          ? 'Setup is complete'
          : `${out.done} of ${out.total} setup steps done`,
      };
    },
  });

  const launchKit = defineAction({
    id: 'experience.launch-kit',
    title: 'Launch kit',
    description:
      'Everything to share your relay: addresses, a QR code, a draft announcement and tips to polish your relay’s profile.',
    technical:
      'URLs from relay.hosts + node.tls; QR via @beamhop/public-web; unsigned kind 1 draft (never published); NIP-11 field suggestions.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['share', 'qr', 'announce', 'launch', 'nip-11'],
    input: z.object({}),
    async run(_input, ctx) {
      const relay = relayOf(kernel, ctx);
      const kit = buildLaunchKit(kernel.config(), relay, now(), ctx.principal.pubkey);
      return {
        output: kit,
        summary: kit.polish.length
          ? `Launch kit ready — ${plural(kit.polish.length, 'polish tip')}`
          : 'Launch kit ready',
      };
    },
  });

  const test = defineAction({
    id: 'experience.test-relay',
    title: 'Test my relay',
    description:
      'Checks your relay from the outside the way people will use it: connect, post, read back and upload.',
    technical:
      'NIP-11 GET, WebSocket EVENT (kind 30078, throwaway key, NIP-40 expiry) → OK, REQ ids → EVENT/EOSE, BUD-02 PUT /upload + GET; cleans up with kind 5 and DELETE.',
    scope: 'relay',
    permission: 'config.write',
    readOnly: true,
    keywords: ['test', 'check', 'reachable', 'diagnose'],
    input: z.object({ skipUpload: z.boolean().default(false) }),
    async run(input, ctx) {
      const relay = relayOf(kernel, ctx);
      const report = await testRelay(kernel.config(), relay, {
        dialer: deps.dialer(),
        timeoutMs: deps.testTimeoutMs,
        now,
        nowMs: () => kernel.ports.clock.nowMs(),
        sha256Hex: (d) => kernel.ports.crypto.sha256Hex(d),
        skipUpload: input.skipUpload,
      });
      await kernel.ports.docs.put<TestRelayReport>(COL.testRuns, relay.id, report);
      return { output: report, summary: report.summary };
    },
  });

  const simulate = defineAction({
    id: 'experience.simulate-change',
    title: 'Try a change first',
    description:
      'See what a settings change would have done to recent posts — what would have been let in, refused or held — before you apply it. Nothing is changed.',
    technical:
      'Replays recent stored events (EventStore, capped) through a shadow policy pipeline (ctx.dryRun) for the current and proposed config; read-through ports with in-memory write overlay.',
    scope: 'relay',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['sandbox', 'simulate', 'dry run', 'what if', 'preview'],
    input: z
      .object({
        patch: z
          .array(
            z.union([
              z.object({
                op: z.enum(['add', 'replace', 'test']),
                path: z.string(),
                value: z.unknown(),
              }),
              z.object({ op: z.literal('remove'), path: z.string() }),
              z.object({ op: z.enum(['move', 'copy']), from: z.string(), path: z.string() }),
            ]),
          )
          .optional()
          .describe('RFC 6902 operations (same as a settings proposal)'),
        merge: z
          .unknown()
          .optional()
          .describe('RFC 7396 merge patch (same as a settings proposal)'),
        target: z.enum(['relay', 'node']).default('relay'),
        hours: z.number().int().min(1).max(168).default(24).describe('How far back to replay'),
        limit: z.number().int().min(1).max(20_000).default(5000),
      })
      .refine((v) => v.patch !== undefined || v.merge !== undefined, {
        message: 'Give a patch or a merge',
      }),
    async run(input, ctx) {
      const relay = relayOf(kernel, ctx);
      let res: Awaited<ReturnType<typeof simulateChange>>;
      try {
        res = await simulateChange(kernel, relay.id, input as Parameters<typeof simulateChange>[2]);
      } catch (err) {
        if (err instanceof ExperienceError) throw err;
        throw new ExperienceError(422, 'invalid_change', 'That change is not valid', String(err));
      }
      return { output: res, summary: res.summary };
    },
  });

  const why = defineAction({
    id: 'experience.why',
    title: 'Why?',
    description:
      'Explains a refused post, a limit, a health score or a suggestion in plain words, with what you can do about it.',
    technical:
      'rejected-event: in-memory ring of event.rejected/event.held; limit: policy.explainLimits; health: kernel.health; card: inbox.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['why', 'explain', 'reason', 'help'],
    input: z.discriminatedUnion('subject', [
      z.object({ subject: z.literal('rejected-event'), eventId: z.string() }),
      z.object({ subject: z.literal('limit'), field: z.string(), tier: z.string().optional() }),
      z.object({
        subject: z.literal('health'),
        subsystem: z
          .enum(['relay', 'blossom', 'storage', 'network', 'moderation', 'backups', 'security'])
          .optional(),
        checkId: z.string().optional(),
      }),
      z.object({ subject: z.literal('card'), cardId: z.string() }),
    ]),
    async run(input, ctx) {
      const ans = await explainWhy(
        kernel,
        ctx.relayId,
        input,
        { ring: deps.ring, engine },
        {
          principal: ctx.principal,
        },
      );
      return { output: ans, summary: ans.cause };
    },
  });

  const recentRejections = defineAction({
    id: 'experience.recent-rejections',
    title: 'Recently refused posts',
    description: 'The latest posts your relay refused or held, so you can ask “why?”.',
    technical: 'In-memory ring buffer of event.rejected / event.held (since restart).',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
    async run(input, ctx) {
      const items = deps.ring.recent(input.limit, ctx.relayId);
      return { output: { items }, summary: plural(items.length, 'refused post') };
    },
  });

  const ping = defineAction({
    id: 'experience.ping',
    title: 'I’m here',
    description: 'Lets Beamhop count how long you spend managing your relay. Stays on this server.',
    technical:
      'Called by the PWA while visible; updates experience.admin-time locally. Not audited.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    // Filtered per principal: open to admins of any relay (admin-api `mayRun`).
    anyRelay: true,
    input: z.object({}),
    async run(_input, ctx) {
      await deps.time.record(ctx.principal.id, 'ping');
      return { output: { ok: true }, summary: 'ok' };
    },
  });

  const myStats = defineAction({
    id: 'experience.my-stats',
    title: 'My time this week',
    description:
      'How many minutes you spent managing your relay this week. Only you can see this, and it never leaves your server.',
    technical: 'Sessions from admin.action + experience.ping (10-minute gap), per ISO week.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    // Filtered per principal: open to admins of any relay (admin-api `mayRun`).
    anyRelay: true,
    keywords: ['stats', 'time', 'minutes'],
    input: z.object({}),
    async run(_input, ctx) {
      const s = await deps.time.stats(ctx.principal.id);
      return { output: s, summary: s.message };
    },
  });

  return [
    inbox,
    approve,
    dismiss,
    snooze,
    checklist,
    launchKit,
    test,
    simulate,
    why,
    recentRejections,
    ping,
    myStats,
  ] as unknown as ActionDef[];
}
