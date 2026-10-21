// SPDX-License-Identifier: AGPL-3.0-or-later
/** Alert actions (§6.13): list, mute/snooze/unmute, channels, push, on-call, digest, tips. */
import { type ActionContext, type ActionDef, type DiffLine, defineAction } from '@beamhop/core';
import { z } from 'zod';
import { TIPS, TIPS_COLLECTION } from './digest.ts';
import { MUTES_COLLECTION, type MuteRecord, muteKey } from './engine.ts';
import { PUSH_COLLECTION, type PushSubscriptionRecord, pushKey, vapidKeys } from './notifiers.ts';
import { ONCALL_COLLECTION, type OnCallSchedule, onDuty } from './router.ts';
import type { AlertsRuntime } from './runtime.ts';

const UNDO_SECONDS = 300;

const Target = z.object({
  rule: z.string().min(1).describe('Kind of alert, e.g. spam-wave'),
  relayId: z
    .string()
    .nullable()
    .optional()
    .describe('Relay (omit for the current one, null for server-wide alerts)'),
  allRelays: z.boolean().default(false).describe('Apply to every relay'),
});

function target(input: z.infer<typeof Target>, ctx: ActionContext) {
  const relayId: string | null | '*all' = input.allRelays
    ? '*all'
    : input.relayId === undefined
      ? ctx.relayId
      : input.relayId;
  return { rule: input.rule, relayId, key: muteKey(input.rule, relayId) };
}

export function createActions(rt: AlertsRuntime): ActionDef[] {
  const docs = rt.kernel.ports.docs;
  const now = () => rt.kernel.ports.clock.now();
  const ruleName = (id: string) => rt.engine.rules.find((r) => r.id === id)?.name ?? id;
  const undo = (actionId: string, payload: unknown) => ({
    actionId,
    payload,
    expiresAt: now() + UNDO_SECONDS,
  });
  const restoreMute = async (payload: unknown) => {
    const p = payload as { key: string; prev: MuteRecord | null };
    if (p.prev) await docs.put(MUTES_COLLECTION, p.key, p.prev);
    else await docs.delete(MUTES_COLLECTION, p.key);
  };

  const list = defineAction({
    id: 'alerts.list',
    title: 'Alerts',
    description: 'Open problems, recent ones that cleared, and what is muted.',
    technical: 'alerts.active, alerts.history (last 7 days), alerts.mutes',
    scope: 'relay',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['alerts', 'problems', 'incidents', 'muted'],
    input: z.object({}),
    async run(_input, ctx) {
      const active = (await rt.engine.active()).filter(
        (a) => !ctx.relayId || !a.relayId || a.relayId === ctx.relayId,
      );
      const recent = await rt.engine.history(now() - 7 * 86400);
      const mutes = await rt.engine.listMutes(now());
      return {
        output: {
          active,
          recent,
          mutes,
          rules: rt.engine.rules.map((r) => ({ id: r.id, name: r.name })),
        },
        summary: active.length
          ? `${active.length} open alert${active.length === 1 ? '' : 's'}`
          : 'No open alerts',
      };
    },
  });

  const mute = defineAction({
    id: 'alerts.mute',
    title: 'Stop these alerts',
    description: 'No more notifications or cards for this kind of alert until you turn it back on.',
    technical: 'Writes alerts.mutes/<rule>:<relay> with until=null.',
    scope: 'relay',
    permission: 'config.write',
    keywords: ['mute', 'silence', 'quiet'],
    input: Target,
    async preview(input, ctx) {
      const t = target(input, ctx);
      return [
        {
          kind: 'change',
          text: `You won't hear about "${ruleName(t.rule)}" until you turn it back on`,
          technical: `alerts.mutes/${t.key} until=null`,
        },
        { kind: 'info', text: 'Your filters and limits keep working as before.' },
      ] satisfies DiffLine[];
    },
    async run(input, ctx) {
      const t = target(input, ctx);
      const prev = await docs.get<MuteRecord>(MUTES_COLLECTION, t.key);
      await docs.put<MuteRecord>(MUTES_COLLECTION, t.key, {
        rule: t.rule,
        relayId: t.relayId,
        until: null,
        by: ctx.principal.id,
        at: now(),
      });
      return {
        output: { key: t.key },
        summary: `Muted "${ruleName(t.rule)}"`,
        undo: undo('alerts.mute', { key: t.key, prev }),
      };
    },
    undo: restoreMute,
  });

  const snooze = defineAction({
    id: 'alerts.snooze',
    title: 'Snooze',
    description: 'Pause this alert for a while. It comes back if the problem is still there.',
    technical: 'Writes alerts.mutes/<rule>:<relay> with until=now+minutes.',
    scope: 'relay',
    permission: 'moderation.write',
    keywords: ['snooze', 'later', 'pause'],
    input: Target.extend({
      minutes: z
        .number()
        .int()
        .min(5)
        .max(30 * 24 * 60)
        .default(60),
    }),
    async preview(input, ctx) {
      const t = target(input, ctx);
      const hours = input.minutes / 60;
      const span =
        hours < 1
          ? `${input.minutes} minutes`
          : hours < 48
            ? `${Math.round(hours)} hours`
            : `${Math.round(hours / 24)} days`;
      return [
        {
          kind: 'change',
          text: `"${ruleName(t.rule)}" is paused for ${span}`,
          technical: `alerts.mutes/${t.key} until=now+${input.minutes * 60}s`,
        },
      ] satisfies DiffLine[];
    },
    async run(input, ctx) {
      const t = target(input, ctx);
      const prev = await docs.get<MuteRecord>(MUTES_COLLECTION, t.key);
      const until = now() + input.minutes * 60;
      await docs.put<MuteRecord>(MUTES_COLLECTION, t.key, {
        rule: t.rule,
        relayId: t.relayId,
        until,
        by: ctx.principal.id,
        at: now(),
      });
      return {
        output: { key: t.key, until },
        summary: `Snoozed "${ruleName(t.rule)}"`,
        undo: undo('alerts.snooze', { key: t.key, prev }),
      };
    },
    undo: restoreMute,
  });

  const unmute = defineAction({
    id: 'alerts.unmute',
    title: 'Turn alerts back on',
    description: 'Get notified about this kind of alert again.',
    technical: 'Deletes alerts.mutes/<rule>:<relay>.',
    scope: 'relay',
    permission: 'config.write',
    keywords: ['unmute', 'unsnooze'],
    input: Target,
    async preview(input, ctx) {
      const t = target(input, ctx);
      return [
        {
          kind: 'change',
          text: `Alerts about "${ruleName(t.rule)}" are back on`,
          technical: `delete alerts.mutes/${t.key}`,
        },
      ] satisfies DiffLine[];
    },
    async run(input, ctx) {
      const t = target(input, ctx);
      const prev = await docs.get<MuteRecord>(MUTES_COLLECTION, t.key);
      await docs.delete(MUTES_COLLECTION, t.key);
      return {
        output: { key: t.key },
        summary: `Unmuted "${ruleName(t.rule)}"`,
        undo: undo('alerts.unmute', { key: t.key, prev }),
      };
    },
    undo: restoreMute,
  });

  const testChannel = defineAction({
    id: 'alerts.test-channel',
    title: 'Send a test alert',
    description: 'Check that a notification channel works.',
    technical:
      'Delivers a severity=info test Notification directly to one channel, bypassing routing.',
    scope: 'node',
    permission: 'config.write',
    keywords: ['test', 'channel', 'notification', 'telegram', 'discord', 'slack', 'email', 'push'],
    input: z.object({ channelId: z.string().min(1) }),
    async preview(input) {
      return [
        { kind: 'info', text: `Sends a test message to "${input.channelId}"` },
      ] satisfies DiffLine[];
    },
    async run(input, ctx) {
      const channel = rt.kernel.config().alerts.channels.find((c) => c.id === input.channelId);
      if (!channel) throw new Error(`No channel called "${input.channelId}"`);
      const recipient = rt.router.recipientFor(
        channel,
        channel.type === 'webpush' ? ctx.principal.id : null,
      );
      const [res] = await rt.router.deliver(
        {
          severity: 'info',
          title: 'Test alert from Beamhop',
          body: 'If you can read this, alerts on this channel work.',
          category: 'ops',
        },
        [{ channel, recipient }],
      );
      if (!res?.ok)
        throw new Error(`The test message could not be sent: ${res?.error ?? 'unknown error'}`);
      return { output: res, summary: `Test message sent to ${input.channelId}` };
    },
  });

  const pushKeyAction = defineAction({
    id: 'alerts.push-key',
    title: 'Phone alerts key',
    description: 'The public key this server uses to send phone/browser alerts.',
    technical: 'VAPID application server key (RFC 8292), base64url uncompressed P-256 point.',
    scope: 'node',
    permission: 'insights.read',
    readOnly: true,
    input: z.object({}),
    async run() {
      const keys = await vapidKeys(docs);
      return { output: { publicKey: keys.publicKey }, summary: 'Push key ready' };
    },
  });

  const subscribePush = defineAction({
    id: 'alerts.subscribe-push',
    title: 'Get alerts on this device',
    description: 'Send urgent alerts to this phone or browser.',
    technical:
      'Stores a PushSubscription (endpoint + p256dh/auth) for the current principal; delivered with RFC 8291 aes128gcm + VAPID.',
    scope: 'node',
    permission: 'insights.read',
    keywords: ['push', 'phone', 'notifications', 'device'],
    input: z.object({
      endpoint: z
        .string()
        .url()
        .refine((u) => u.startsWith('https://'), 'push endpoint must be https'),
      keys: z.object({ p256dh: z.string().min(80), auth: z.string().min(16) }),
    }),
    async preview() {
      return [{ kind: 'add', text: 'This device will receive urgent alerts' }] satisfies DiffLine[];
    },
    async run(input, ctx) {
      const key = await pushKey(rt.kernel.ports.crypto, ctx.principal.id, input.endpoint);
      const rec: PushSubscriptionRecord = {
        principalId: ctx.principal.id,
        endpoint: input.endpoint,
        keys: input.keys,
        createdAt: now(),
      };
      await docs.put(PUSH_COLLECTION, key, rec);
      const hasChannel = rt.kernel.config().alerts.channels.some((c) => c.type === 'webpush');
      const keys = await vapidKeys(docs);
      return {
        output: { key, publicKey: keys.publicKey, channelConfigured: hasChannel },
        summary: hasChannel
          ? 'This device will get alerts'
          : 'Device saved — add a "webpush" alert channel to start receiving alerts',
        undo: undo('alerts.subscribe-push', { key }),
      };
    },
    async undo(payload) {
      await docs.delete(PUSH_COLLECTION, (payload as { key: string }).key);
    },
  });

  const setOncall = defineAction({
    id: 'alerts.set-oncall',
    title: 'On-call schedule',
    description: 'Take turns: alerts go only to whoever is on duty.',
    technical:
      'alerts.oncall/schedule: rotation of principal ids → channel ids; slot = floor((now-startAt)/periodDays) mod n.',
    scope: 'node',
    permission: 'admins.manage',
    keywords: ['on-call', 'rotation', 'duty', 'schedule'],
    input: z.object({
      rotation: z
        .array(z.object({ principalId: z.string().min(1), channels: z.array(z.string()).min(1) }))
        .max(50),
      periodDays: z.number().int().min(1).max(90).default(7),
      startAt: z.number().int().optional(),
    }),
    async preview(input) {
      const prev = await docs.get<OnCallSchedule>(ONCALL_COLLECTION, 'schedule');
      const lines: DiffLine[] = [];
      if (input.rotation.length === 0)
        lines.push({ kind: 'remove', text: 'No rotation: every alert goes to every channel' });
      else
        lines.push({
          kind: prev ? 'change' : 'add',
          text: `${input.rotation.length} people take turns every ${input.periodDays} days`,
          technical: input.rotation
            .map((r) => `${r.principalId} → ${r.channels.join(',')}`)
            .join('; '),
        });
      const known = new Set(rt.kernel.config().alerts.channels.map((c) => c.id));
      for (const r of input.rotation)
        for (const c of r.channels)
          if (!known.has(c))
            lines.push({ kind: 'warning', text: `There is no channel called "${c}"` });
      return lines;
    },
    async run(input) {
      const prev = await docs.get<OnCallSchedule>(ONCALL_COLLECTION, 'schedule');
      if (input.rotation.length === 0) await docs.delete(ONCALL_COLLECTION, 'schedule');
      else
        await docs.put<OnCallSchedule>(ONCALL_COLLECTION, 'schedule', {
          rotation: input.rotation,
          periodDays: input.periodDays,
          startAt: input.startAt ?? prev?.startAt ?? now(),
        });
      const cur = onDuty(await docs.get<OnCallSchedule>(ONCALL_COLLECTION, 'schedule'), now());
      return {
        output: { onDuty: cur },
        summary: cur ? `${cur.principalId} is on duty now` : 'On-call rotation turned off',
        undo: undo('alerts.set-oncall', { prev }),
      };
    },
    async undo(payload) {
      const { prev } = payload as { prev: OnCallSchedule | null };
      if (prev) await docs.put(ONCALL_COLLECTION, 'schedule', prev);
      else await docs.delete(ONCALL_COLLECTION, 'schedule');
    },
  });

  const sendDigest = defineAction({
    id: 'alerts.send-digest',
    title: 'Send the digest now',
    description: 'Send the summary of how your relay is doing right away.',
    technical:
      'Builds the daily/weekly digest and delivers it to the routed channels (bypasses minSeverity).',
    scope: 'node',
    permission: 'config.write',
    input: z.object({ period: z.enum(['daily', 'weekly']).optional() }),
    async preview() {
      return [
        { kind: 'info', text: 'Sends the digest to your alert channels' },
      ] satisfies DiffLine[];
    },
    async run(input) {
      const digest = await rt.sendDigest(input.period, true);
      return { output: digest, summary: digest.title };
    },
  });

  const dismissTip = defineAction({
    id: 'alerts.dismiss-tip',
    title: 'Hide this tip',
    description: "Don't show this tip again.",
    scope: 'node',
    permission: 'insights.read',
    input: z.object({ tipId: z.enum(TIPS.map((t) => t.id) as [string, ...string[]]) }),
    async run(input) {
      const prev = (await docs.get<string[]>(TIPS_COLLECTION, 'dismissed')) ?? [];
      if (!prev.includes(input.tipId))
        await docs.put(TIPS_COLLECTION, 'dismissed', [...prev, input.tipId]);
      return {
        output: { dismissed: input.tipId },
        summary: 'Tip hidden',
        undo: undo('alerts.dismiss-tip', { prev }),
      };
    },
    async undo(payload) {
      await docs.put(TIPS_COLLECTION, 'dismissed', (payload as { prev: string[] }).prev);
    },
  });

  return [
    list,
    mute,
    snooze,
    unmute,
    testChannel,
    pushKeyAction,
    subscribePush,
    setOncall,
    sendDigest,
    dismissTip,
  ] as unknown as ActionDef[];
}
