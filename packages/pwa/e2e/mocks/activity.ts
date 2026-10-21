// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="bun" />
/**
 * Mock actions for the Activity tab (AI hints, bulk actions, refused posts,
 * alerts mute/snooze/on-call/digest/tips, internal notes, logs) and the
 * generic `POST /actions/{id}/bulk` route. Registered from mock-server.ts.
 *
 * Extra `/__reset` options:
 *   activityLive: true   → the live stream sends two held posts
 *   twoPerson: true      → moderation.bulk-delete answers "approval required"
 *   alertChannel: true   → one alert channel is configured (on-call needs it)
 */
import type { Hono } from 'hono';
import { z } from 'zod';

type Diff = {
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
  text: string;
  technical?: string;
};

interface MockAction {
  id: string;
  title: string;
  description: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly?: boolean;
  bulk?: boolean;
  keywords?: string[];
  input: z.ZodType;
  preview?: (input: Record<string, unknown>) => Diff[];
  run: (input: Record<string, unknown>) => { output: unknown; summary: string; undo?: () => void };
}

interface QueueLike {
  id: string;
  status: string;
  eventId?: string;
}

/** The parts of the mock server state this file touches. */
export interface ActivityHost {
  app: Hono;
  actions: MockAction[];
  state: () => {
    queue: QueueLike[];
    bans: Set<string>;
    log: Array<{ id: string; input: unknown }>;
    undo: Map<string, () => void>;
    nodeExtra: { alerts: { channels: Array<Record<string, unknown>> } };
  };
  token: () => string;
}

const now = () => Math.floor(Date.now() / 1000);
const HEX64 = /^[0-9a-f]{64}$/;
const SPAMMER = 'b'.repeat(64);
const OWNER = 'a'.repeat(64);
const REFUSED = 'c'.repeat(64);

interface Mute {
  rule: string;
  relayId: string | null | '*all';
  until: number | null;
  by: string;
  at: number;
}
interface Note {
  id: string;
  relayId: string;
  subject: { type: string; id: string };
  text: string;
  author: string;
  authorName: string;
  at: number;
}
interface Schedule {
  startAt: number;
  periodDays: number;
  rotation: Array<{ principalId: string; channels: string[] }>;
}

const TIPS = [
  { id: 'backups', text: 'Backups are your safety net. Check that one finished recently.' },
  { id: 'snooze', text: 'Alerts you already know about can be snoozed for a day with one tap.' },
];

function fresh(o: { activityLive?: boolean; twoPerson?: boolean } = {}) {
  return {
    live: !!o.activityLive,
    twoPerson: !!o.twoPerson,
    mutes: [] as Mute[],
    notes: [] as Note[],
    schedule: null as Schedule | null,
    dismissed: [] as string[],
    digests: 0,
    removed: [] as string[],
  };
}

let A = fresh();

function logs() {
  const t = Date.now();
  return [
    {
      at: t - 5_000,
      level: 'error',
      source: 'blossom',
      message: 'Upload failed: disk full',
      fields: { sha256: 'f'.repeat(64), ip: 'ip:3fa1c2', size: 1048576 },
    },
    {
      at: t - 20_000,
      level: 'warn',
      source: 'relay',
      message: 'Slow query (900 ms)',
      fields: { ms: 900, filters: 3 },
    },
    {
      at: t - 40_000,
      level: 'info',
      source: 'admin-api',
      message: 'Config revision 2 applied',
      fields: { revision: 2, token: '•••' },
    },
    {
      at: t - 60_000,
      level: 'debug',
      source: 'relay',
      message: 'Subscription closed',
      fields: { connId: 'c1' },
    },
  ];
}

const target = z.object({
  rule: z.string().min(1),
  relayId: z.string().nullable().optional(),
  allRelays: z.boolean().default(false),
});
const muteKey = (i: Record<string, unknown>) => ({
  rule: String(i.rule),
  relayId: i.allRelays
    ? ('*all' as const)
    : i.relayId === undefined
      ? 'main'
      : (i.relayId as string | null),
});

function setMute(i: Record<string, unknown>, until: number | null) {
  const k = muteKey(i);
  const prev = A.mutes.find((m) => m.rule === k.rule && m.relayId === k.relayId);
  A.mutes = [...A.mutes.filter((m) => m !== prev), { ...k, until, by: OWNER, at: now() }];
  return () => {
    A.mutes = A.mutes.filter((m) => !(m.rule === k.rule && m.relayId === k.relayId));
    if (prev) A.mutes.push(prev);
  };
}

function actions(host: ActivityHost): MockAction[] {
  const S = host.state;
  return [
    {
      id: 'ai.moderation-labels',
      title: 'AI hints for items waiting for review',
      description: 'Hints only.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ ids: z.array(z.string()).optional() }),
      run: (i) => {
        const all = [
          {
            itemId: 'q1',
            relayId: 'main',
            status: 'labeled',
            label: 'spam',
            reason: 'repeated link to a follower shop',
            model: 'llama3',
            at: now() - 30,
            attempts: 1,
          },
          {
            itemId: 'q2',
            relayId: 'main',
            status: 'labeled',
            label: 'ok',
            reason: 'ordinary post',
            model: 'llama3',
            at: now() - 30,
            attempts: 1,
          },
          { itemId: 'q3', relayId: 'main', status: 'failed', at: now() - 30, attempts: 3 },
        ];
        const ids = i.ids as string[] | undefined;
        const labels = ids ? all.filter((l) => ids.includes(l.itemId)) : all;
        return { output: { labels }, summary: `${labels.length} AI hints` };
      },
    },
    {
      id: 'moderation.bulk-delete',
      title: 'Remove many posts',
      description: 'Hide up to 500 posts at once.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      input: z.object({
        eventIds: z.array(z.string().regex(HEX64)).min(1).max(500),
        reason: z.string().max(200).optional(),
      }),
      preview: (i) => [
        {
          kind: 'remove',
          text: `Move ${(i.eventIds as string[]).length} posts to the recycle bin (restorable for 30 days)`,
        },
        ...(A.twoPerson
          ? [
              {
                kind: 'warning' as const,
                text: 'Another admin must approve this before it happens',
              },
            ]
          : []),
      ],
      run: (i) => {
        if (A.twoPerson)
          return {
            output: { status: 'approval-required', requestId: 'r1', expiresAt: now() + 86400 },
            summary: 'Asked another admin to approve: remove many posts',
          };
        const ids = i.eventIds as string[];
        const items = S().queue.filter(
          (q) => q.eventId && ids.includes(q.eventId) && q.status === 'pending',
        );
        for (const q of items) q.status = 'removed';
        A.removed.push(...ids);
        return {
          output: { removed: ids.length, notFound: 0 },
          summary: `Moved ${ids.length} posts to the recycle bin (restorable for 30 days)`,
          undo: () => {
            for (const q of items) q.status = 'pending';
            A.removed = A.removed.filter((x) => !ids.includes(x));
          },
        };
      },
    },
    {
      id: 'experience.recent-rejections',
      title: 'Recently refused posts',
      description: 'The latest posts your relay refused or held.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ limit: z.number().default(50) }),
      run: () => ({
        output: {
          items: [
            {
              relayId: 'main',
              eventId: REFUSED,
              pubkey: SPAMMER,
              kind: 1,
              reason: 'blocked word: "free followers"',
              by: 'keyword-filter',
              at: now() - 120,
              decision: 'reject',
            },
            {
              relayId: 'main',
              eventId: 'd'.repeat(64),
              pubkey: SPAMMER,
              kind: 1,
              reason: 'too many links',
              at: now() - 300,
              decision: 'hold',
            },
          ],
        },
        summary: '2 refused posts',
      }),
    },
    {
      id: 'moderation.list-banned-pubkeys',
      title: 'Blocked accounts',
      description: 'Accounts that cannot post here.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          pubkeys: [...S().bans].map((pubkey) => ({
            pubkey,
            reason: 'spam',
            at: now() - 60,
            by: OWNER,
          })),
        },
        summary: 'blocked',
      }),
    },
    {
      id: 'alerts.list',
      title: 'Alerts',
      description: 'Open problems and recent ones.',
      scope: 'relay',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          active: [
            {
              id: 'al1',
              key: 'spam-wave:main',
              rule: 'spam-wave',
              relayId: 'main',
              title: 'Spam wave being blocked',
              body: '412 posts refused in 10 minutes',
              severity: 'warning',
              technical: 'rejectedPerMin z=6.1',
              lastAt: now() - 120,
              firstAt: now() - 900,
              count: 3,
            },
          ],
          recent: [
            {
              id: 'al2',
              key: 'disk:*',
              rule: 'disk-fill',
              relayId: null,
              title: 'Disk almost full',
              body: 'It cleared after old files were removed',
              severity: 'critical',
              technical: 'disk 92%',
              lastAt: now() - 7200,
              resolvedAt: now() - 3600,
              firstAt: now() - 9000,
              count: 1,
            },
          ],
          mutes: A.mutes.filter((m) => m.until === null || m.until > now()),
          rules: [
            { id: 'spam-wave', name: 'Spam wave' },
            { id: 'disk-fill', name: 'Disk filling up' },
          ],
        },
        summary: '1 open alert',
      }),
    },
    {
      id: 'alerts.mute',
      title: 'Stop these alerts',
      description: 'No more notifications for this kind of alert.',
      scope: 'relay',
      permission: 'config.write',
      input: target,
      preview: (i) => [
        { kind: 'change', text: `You won't hear about "${i.rule}" until you turn it back on` },
      ],
      run: (i) => ({ output: {}, summary: `Muted "${i.rule}"`, undo: setMute(i, null) }),
    },
    {
      id: 'alerts.snooze',
      title: 'Snooze',
      description: 'Pause this alert for a while.',
      scope: 'relay',
      permission: 'moderation.write',
      input: target.extend({ minutes: z.number().int().min(5).default(60) }),
      preview: (i) => [{ kind: 'change', text: `"${i.rule}" is paused` }],
      run: (i) => ({
        output: {},
        summary: `Snoozed "${i.rule}"`,
        undo: setMute(i, now() + Number(i.minutes) * 60),
      }),
    },
    {
      id: 'alerts.unmute',
      title: 'Turn alerts back on',
      description: 'Get notified about this kind of alert again.',
      scope: 'relay',
      permission: 'config.write',
      input: target,
      preview: (i) => [{ kind: 'change', text: `Alerts about "${i.rule}" are back on` }],
      run: (i) => {
        const k = muteKey(i);
        const prev = A.mutes.filter((m) => m.rule === k.rule && m.relayId === k.relayId);
        A.mutes = A.mutes.filter((m) => !prev.includes(m));
        return { output: {}, summary: `Unmuted "${i.rule}"`, undo: () => A.mutes.push(...prev) };
      },
    },
    {
      id: 'alerts.oncall',
      title: "Who's on call",
      description: 'The on-call rotation.',
      scope: 'node',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = A.schedule;
        const t = now();
        if (!s)
          return {
            output: { schedule: null, onDuty: null, until: null, now: t },
            summary: 'No on-call rotation',
          };
        const period = s.periodDays * 86400;
        const p = Math.floor((t - s.startAt) / period);
        const n = s.rotation.length;
        return {
          output: {
            schedule: s,
            onDuty: s.rotation[((p % n) + n) % n],
            until: s.startAt + (p + 1) * period,
            now: t,
          },
          summary: 'rotation',
        };
      },
    },
    {
      id: 'alerts.set-oncall',
      title: 'On-call schedule',
      description: 'Take turns: alerts go only to whoever is on duty.',
      scope: 'node',
      permission: 'admins.manage',
      input: z.object({
        rotation: z
          .array(z.object({ principalId: z.string().min(1), channels: z.array(z.string()).min(1) }))
          .max(50),
        periodDays: z.number().int().min(1).max(90).default(7),
        startAt: z.number().int().optional(),
      }),
      preview: (i) => [
        {
          kind: A.schedule ? 'change' : 'add',
          text: `${(i.rotation as unknown[]).length} people take turns every ${i.periodDays} days`,
        },
      ],
      run: (i) => {
        const prev = A.schedule;
        A.schedule = (i.rotation as unknown[]).length
          ? {
              rotation: i.rotation as Schedule['rotation'],
              periodDays: Number(i.periodDays),
              startAt: Number(i.startAt ?? now()),
            }
          : null;
        return {
          output: {},
          summary: 'On-call schedule saved',
          undo: () => {
            A.schedule = prev;
          },
        };
      },
    },
    {
      id: 'alerts.tips',
      title: 'Tips',
      description: 'Tips you have not hidden yet.',
      scope: 'node',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: { tips: TIPS.filter((t) => !A.dismissed.includes(t.id)) },
        summary: 'tips',
      }),
    },
    {
      id: 'alerts.dismiss-tip',
      title: 'Hide this tip',
      description: "Don't show this tip again.",
      scope: 'node',
      permission: 'insights.read',
      input: z.object({ tipId: z.string() }),
      run: (i) => {
        A.dismissed.push(String(i.tipId));
        return {
          output: {},
          summary: 'Tip hidden',
          undo: () => {
            A.dismissed = A.dismissed.filter((x) => x !== i.tipId);
          },
        };
      },
    },
    {
      id: 'alerts.send-digest',
      title: 'Send the digest now',
      description: 'Send the summary right away.',
      scope: 'node',
      permission: 'config.write',
      input: z.object({ period: z.enum(['daily', 'weekly']).optional() }),
      preview: () => [{ kind: 'info', text: 'Sends the digest to your alert channels' }],
      run: () => {
        A.digests++;
        return { output: { title: 'Daily summary' }, summary: 'Daily summary sent' };
      },
    },
    {
      id: 'notes.list',
      title: 'Show internal notes',
      description: 'Notes the admin team left.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({
        subject: z.object({ type: z.string(), id: z.string() }).optional(),
        limit: z.number().default(100),
      }),
      run: (i) => {
        const s = i.subject as { type: string; id: string } | undefined;
        const notes = A.notes
          .filter((n) => !s || (n.subject.type === s.type && n.subject.id === s.id))
          .sort((a, b) => b.at - a.at);
        return { output: { notes }, summary: `Listed ${notes.length} notes` };
      },
    },
    {
      id: 'notes.add',
      title: 'Add an internal note',
      description: 'Leave a note for the admin team.',
      scope: 'relay',
      permission: 'moderation.write',
      input: z.object({
        subject: z.object({ type: z.enum(['user', 'event', 'blob']), id: z.string().min(1) }),
        text: z.string().min(1).max(4000),
      }),
      run: (i) => {
        const note: Note = {
          id: `n${A.notes.length + 1}`,
          relayId: 'main',
          subject: i.subject as Note['subject'],
          text: String(i.text),
          author: OWNER,
          authorName: 'Owner',
          at: now(),
        };
        A.notes.push(note);
        return {
          output: { note },
          summary: 'Added a note',
          undo: () => {
            A.notes = A.notes.filter((n) => n !== note);
          },
        };
      },
    },
    {
      id: 'logs.query',
      title: 'Recent logs',
      description: 'What the server wrote to its log recently.',
      scope: 'node',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({
        level: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
        source: z.string().optional(),
        text: z.string().optional(),
        since: z.number().optional(),
        until: z.number().optional(),
        limit: z.number().max(500).default(200),
      }),
      run: (i) => {
        const lv = i.level as string[] | undefined;
        const text = (i.text as string | undefined)?.toLowerCase();
        const records = logs()
          .filter((r) => !lv || lv.includes(r.level))
          .filter((r) => !i.source || r.source === i.source)
          .filter((r) => !text || r.message.toLowerCase().includes(text))
          .filter((r) => i.since === undefined || r.at >= Number(i.since));
        return {
          output: { records, dropped: 0, sources: ['admin-api', 'blossom', 'relay'] },
          summary: `${records.length} log lines`,
        };
      },
    },
  ];
}

/** Register the Activity mocks: actions (replacing stubs with the same id) and routes. */
export function registerActivityMocks(host: ActivityHost): void {
  const mine = actions(host);
  const ids = new Set(mine.map((a) => a.id));
  for (let i = host.actions.length - 1; i >= 0; i--)
    if (ids.has((host.actions[i] as MockAction).id)) host.actions.splice(i, 1);
  host.actions.push(...mine);

  host.app.use('/__reset', async (c, next) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      activityLive?: boolean;
      twoPerson?: boolean;
      alertChannel?: boolean;
    };
    A = fresh(body);
    await next();
    if (body.alertChannel)
      host.state().nodeExtra.alerts.channels.push({
        type: 'discord',
        id: 'ops',
        webhookUrl: 'https://discord.example/hook',
      });
  });
  host.app.get('/__activity', (c) => c.json({ ...A, mutes: A.mutes }));

  host.app.get('/api/v1/nodes/:node/live', async (c, next) => {
    if (!A.live) return next();
    const sse = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const held = [1, 2].map((i) =>
      sse('event.held', {
        relayId: 'main',
        event: {
          id: String(i).repeat(64),
          pubkey: SPAMMER,
          kind: 1,
          content: `Buy cheap followers #${i}`,
          created_at: now(),
          tags: [],
          sig: '',
        },
        reason: 'too many links',
      }),
    );
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(`: connected\n\n${sse('ready', {})}${held.join('')}`),
        );
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  });

  const bulk = async (c: import('hono').Context) => {
    const id = c.req.param('id') as string;
    const def = host.actions.find((a) => a.id === id);
    if (!def)
      return c.json(
        { error: { code: 'unknown_action', message: 'That action does not exist' } },
        404,
      );
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: unknown[] };
    const undos: Array<() => void> = [];
    const results = (body.inputs ?? []).map((raw) => {
      const parsed = def.input.safeParse(raw ?? {});
      if (!parsed.success)
        return {
          ok: false,
          error: { code: 'invalid_input', message: 'Some fields are not valid' },
        };
      try {
        const input = parsed.data as Record<string, unknown>;
        const r = def.run(input);
        if (!def.readOnly) host.state().log.push({ id: def.id, input });
        if (r.undo) undos.push(r.undo);
        return { ok: true, output: r.output, summary: r.summary };
      } catch (err) {
        return { ok: false, error: { code: 'action_failed', message: (err as Error).message } };
      }
    });
    const ok = results.filter((r) => r.ok).length;
    const out: Record<string, unknown> = {
      results,
      summary: `${def.title}: ${ok} of ${results.length} done`,
    };
    if (undos.length) {
      const t = host.token();
      host.state().undo.set(t, () => {
        for (const u of undos.reverse()) u();
      });
      out.undo = { token: t, expiresAt: now() + 300 };
    }
    return c.json(out);
  };
  host.app.post('/api/v1/nodes/:node/relays/:relay/actions/:id/bulk', bulk);
  host.app.post('/api/v1/nodes/:node/actions/:id/bulk', bulk);
}
