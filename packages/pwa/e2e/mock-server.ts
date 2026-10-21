// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="bun" />
/**
 * Tiny mock of the Beamhop admin API for E2E tests (Hono on Bun). Serves the
 * built app at /admin and the API at /api/v1 with deterministic state. Real
 * zod schemas from @beamhop/core and the real goals engine from
 * @beamhop/policy keep the shapes honest.
 *
 *   POST /__reset {claimed?, ai?}      → fresh state (ai: 'absent' | 'off' | 'on')
 *   GET  /__log                        → actions run so far
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { ConfigSchema, RelaySchema } from '@beamhop/core';
import { applyPersona, explainLimits } from '@beamhop/policy';
import { Hono } from 'hono';
import { z } from 'zod';
import { registerActivityMocks } from './mocks/activity.ts';
import { registerBackupsMocks, withBackupsRoute } from './mocks/backups.ts';
import { enterprise } from './mocks/enterprise.ts';
import { homeActions } from './mocks/home.ts';
import { registerMediaMocks } from './mocks/media.ts';
import { registerPeopleMocks } from './mocks/people.ts';
import { pluginWriterActions } from './mocks/plugins.ts';
import { systemMockActions } from './mocks/system.ts';
import { registerTopTaskMocks } from './mocks/top-tasks.ts';

type Relay = z.infer<typeof RelaySchema>;
type Diff = {
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
  text: string;
  technical?: string;
};

const BUILD = join(import.meta.dir, '../build');
const PORT = Number(process.env.PORT ?? 4173);
const PK = 'a'.repeat(64);
const SPAMMER = 'b'.repeat(64);

interface Action {
  id: string;
  title: string;
  description: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly?: boolean;
  bulk?: boolean;
  keywords?: string[];
  shortcut?: string;
  input: z.ZodType;
  preview?: (input: Record<string, unknown>) => Diff[];
  run: (input: Record<string, unknown>) => { output: unknown; summary: string; undo?: () => void };
}

type AiMode = 'absent' | 'off' | 'on';

interface ResetOptions {
  claimed?: boolean;
  ai?: AiMode;
  /** A plugin that the safety switch turned off. */
  tripped?: boolean;
  /** Home shows one informational card that cannot be approved. */
  infoCard?: boolean;
  /** Public host name of the relay (default: catch-all only). */
  host?: string;
  persona?: Relay['persona'];
  /** Enterprise modules on (company groups, keys, compliance, approvals, network). */
  enterprise?: boolean;
}

interface MockCard {
  key: string;
  relayId: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  technical?: string;
  count: number;
  members: string[];
  sources: string[];
  createdAt: number;
  ageSeconds: number;
  approvable?: boolean;
  primary?: { label: string; actionId: string; inputs: unknown[] };
}

const SPAM_CARDS = (): MockCard[] => [
  {
    key: 'batch:main:spam-wave',
    relayId: 'main',
    severity: 'warning',
    title: 'Spam wave from 3 new accounts',
    body: 'Block them to stop it.',
    technical: 'rate-limit hook · 412 events',
    count: 3,
    members: ['c1', 'c2', 'c3'],
    sources: ['policy'],
    createdAt: now() - 600,
    ageSeconds: 600,
    primary: {
      label: 'Block all 3',
      actionId: 'moderation.ban-pubkey',
      inputs: [{ pubkeys: [SPAMMER] }],
    },
  },
];

const INFO_CARDS = (): MockCard[] => [
  {
    key: 'tip:main:welcome',
    relayId: 'main',
    severity: 'info',
    title: 'Your relay is live',
    body: 'Share its address so people can connect.',
    count: 1,
    members: [],
    sources: ['experience'],
    createdAt: now() - 60,
    ageSeconds: 60,
    approvable: false,
  },
];

interface PluginState {
  enabled: boolean;
  config: Record<string, unknown>;
  tripped?: { reason: string; at: number };
  calls: number;
  rejections: number;
}

function freshState(claimed: boolean, ai: AiMode = 'absent', o: ResetOptions = {}) {
  const relay: Relay = RelaySchema.parse({
    id: 'main',
    hosts: o.host ? [o.host, '*'] : ['*'],
    info: { name: 'Test Relay' },
    ...(o.persona ? { persona: o.persona } : {}),
  });
  const plugins = new Map<string, PluginState>();
  if (o.tripped)
    plugins.set('rate-limit-burst', {
      enabled: false,
      config: {},
      tripped: { reason: 'it failed 5 times in a row', at: now() - 300 },
      calls: 120,
      rejections: 4,
    });
  return {
    claimed,
    relay,
    nodeExtra: ConfigSchema.parse({}),
    revision: 1,
    revisions: [
      {
        revision: 1,
        at: now(),
        author: 'system',
        authorName: 'Beamhop',
        summary: 'First setup',
        source: 'initial',
        changes: 0,
      },
    ],
    proposals: new Map<string, { relay: boolean; next: unknown; diff: Diff[]; summary: string }>(),
    undo: new Map<string, () => void>(),
    log: [] as Array<{ id: string; input: unknown }>,
    cards: (o.infoCard ? INFO_CARDS : SPAM_CARDS)(),
    hiddenCards: new Set<string>(),
    queue: [1, 2, 3].map((i) => ({
      id: `q${i}`,
      relayId: 'main',
      type: 'report',
      status: 'pending',
      createdAt: now() - i * 60,
      updatedAt: now(),
      batchKey: 'reports',
      reason: `Reported for spam (#${i})`,
      pubkey: SPAMMER,
      eventId: String(i).repeat(64).slice(0, 64),
      event: {
        id: String(i).repeat(64).slice(0, 64),
        pubkey: SPAMMER,
        kind: 1,
        content: `Buy cheap followers #${i}`,
        created_at: now(),
        tags: [],
        sig: '',
      },
      reports: [{ reportId: `r${i}`, reporter: PK, type: 'spam', at: now() }],
    })),
    bans: new Set<string>(),
    invites: 0,
    ai,
    assistantRequests: [] as unknown[],
    tests: [] as string[],
    plugins,
    modules: { 'enterprise-identity': false } as Record<string, boolean>,
    idp: null as null | { provider: string; clientId?: string; tenant?: string; domain?: string },
    mappings: [] as Array<Record<string, unknown>>,
  };
}

function now() {
  return Math.floor(Date.now() / 1000);
}

let S = freshState(false);
let seq = 0;
const token = () => (++seq).toString(16).padStart(32, '0');

function nodeConfig() {
  return { ...S.nodeExtra, relays: [S.relay] };
}

const relaySchemaJson = z.toJSONSchema(RelaySchema, { io: 'input', unrepresentable: 'any' });
const nodeSchemaJson = z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' });

type SchemaNode = {
  $ref?: string;
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  [k: string]: unknown;
};

/** Add the help extension keywords (x-enumLabels, x-showWhen, …) the real server publishes. */
function annotate(root: SchemaNode, path: string, extra: Record<string, unknown>): void {
  const resolve = (n: SchemaNode | undefined): SchemaNode | undefined => {
    let cur = n;
    for (let i = 0; cur?.$ref && i < 5; i++) {
      let r: unknown = root;
      for (const p of cur.$ref.slice(2).split('/')) r = (r as Record<string, unknown>)[p];
      cur = r as SchemaNode;
    }
    const alt = cur?.anyOf?.find((a) => a.type !== 'null');
    return cur?.properties ? cur : (resolve(alt) ?? cur);
  };
  let node: SchemaNode | undefined = root;
  for (const seg of path.split('.')) node = resolve(node)?.properties?.[seg];
  if (node) Object.assign(node, extra);
}

annotate(relaySchemaJson as SchemaNode, 'access.mode', {
  'x-enumLabels': {
    open: 'Anyone can post',
    allowlist: 'Only people I approve',
    wot: 'People in my web of trust',
  },
  'x-example': 'Most community relays start with “People in my web of trust”.',
  'x-recommended': { value: 'wot', why: 'Keeps spam out without approving everyone by hand.' },
});
for (const p of ['access.wot.depth', 'access.wot.minFollowers'])
  annotate(relaySchemaJson as SchemaNode, p, {
    'x-showWhen': { path: 'access.mode', equals: ['wot'] },
  });
annotate(relaySchemaJson as SchemaNode, 'access.authRequired.read', { description: undefined });

const GOAL_TEXT: Record<string, string> = {
  openness: 'How open the relay is',
  spamTolerance: 'Spam tolerance',
  storage: 'How much to keep',
  media: 'Media features',
  speedVsCost: 'Speed vs cost',
};

function describeChanges(before: unknown, after: unknown, path: string[] = []): Diff[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after as object)]);
    return [...keys].flatMap((k) =>
      describeChanges(
        (before as Record<string, unknown>)[k],
        (after as Record<string, unknown>)[k],
        [...path, k],
      ),
    );
  }
  const key = path[path.length - 1] ?? '';
  const label = GOAL_TEXT[key] ?? path.join('.');
  return [
    {
      kind: 'change',
      text: `${label}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      technical: path.join('.'),
    },
  ];
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    !base ||
    typeof base !== 'object'
  )
    return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch))
    out[k] = v === null ? undefined : deepMerge(out[k], v);
  return out;
}

function applyPatch(
  doc: unknown,
  ops: Array<{ op: string; path: string; value?: unknown }>,
): unknown {
  const copy = JSON.parse(JSON.stringify(doc));
  for (const o of ops) {
    const parts = o.path
      .split('/')
      .slice(1)
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop() as string;
    let cur = copy;
    for (const p of parts) cur = cur[p];
    if (Array.isArray(cur)) {
      const i = last === '-' ? cur.length : Number(last);
      if (o.op === 'remove') cur.splice(i, 1);
      else if (o.op === 'add') cur.splice(i, 0, o.value);
      else cur[i] = o.value;
    } else if (o.op === 'remove') delete cur[last];
    else cur[last] = o.value;
  }
  return copy;
}

function ban(pubkeys: string[]) {
  const added = pubkeys.filter((p) => !S.bans.has(p));
  for (const p of added) S.bans.add(p);
  return () => {
    for (const p of added) S.bans.delete(p);
  };
}

const ACTIONS: Action[] = [
  {
    id: 'config.apply-persona',
    title: 'Change relay type',
    description: 'Apply a ready-made setup.',
    scope: 'relay',
    permission: 'config.write',
    keywords: ['persona'],
    input: z.object({
      persona: z.enum([
        'public-social',
        'private-team',
        'wot-community',
        'media-host',
        'organization',
      ]),
    }),
    preview: (i) => describeChanges(S.relay, applyPersona(S.relay, i.persona as Relay['persona'])),
    run: (i) => {
      const prev = S.relay;
      S.relay = applyPersona(S.relay, i.persona as Relay['persona']);
      return {
        output: { relayId: 'main' },
        summary: `Relay set up as ${i.persona}`,
        undo: () => {
          S.relay = prev;
        },
      };
    },
  },
  {
    id: 'experience.inbox',
    title: 'Home inbox',
    description: 'Everything that needs a look.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({ relayId: z.string().optional() }),
    run: () => {
      const cards = S.cards.filter((c) => !S.hiddenCards.has(c.key));
      return { output: { cards, allClear: cards.length === 0, message: '' }, summary: '' };
    },
  },
  {
    id: 'experience.approve-card',
    title: 'Approve a suggestion',
    description: 'Do what the suggestion proposes.',
    scope: 'node',
    permission: 'relay.read',
    input: z.object({ key: z.string() }),
    preview: (i) => [
      { kind: 'add', text: `3 accounts will be blocked (${i.key})`, technical: 'policy.bans += 3' },
    ],
    run: (i) => {
      const key = String(i.key);
      S.hiddenCards.add(key);
      const card = S.cards.find((c) => c.key === key);
      const undoBan = ban(
        (card?.primary?.inputs[0] as { pubkeys: string[] } | undefined)?.pubkeys ?? [],
      );
      return {
        output: { key },
        summary: 'Blocked 3 accounts',
        undo: () => {
          S.hiddenCards.delete(key);
          undoBan();
        },
      };
    },
  },
  {
    id: 'experience.snooze-card',
    title: 'Remind me later',
    description: 'Hide this suggestion for a while.',
    scope: 'node',
    permission: 'relay.read',
    input: z.object({ key: z.string(), hours: z.number().int().default(24) }),
    run: (i) => {
      S.hiddenCards.add(String(i.key));
      return { output: {}, summary: 'Snoozed', undo: () => S.hiddenCards.delete(String(i.key)) };
    },
  },
  {
    id: 'experience.dismiss-card',
    title: 'Dismiss a suggestion',
    description: 'Hide this suggestion for you.',
    scope: 'node',
    permission: 'relay.read',
    shortcut: 'e',
    input: z.object({ key: z.string() }),
    run: (i) => {
      S.hiddenCards.add(String(i.key));
      return {
        output: { key: i.key },
        summary: 'Dismissed',
        undo: () => S.hiddenCards.delete(String(i.key)),
      };
    },
  },
  {
    id: 'alerts.test-channel',
    title: 'Send a test alert',
    description: 'Check that a notification channel works.',
    scope: 'node',
    permission: 'config.write',
    readOnly: true,
    input: z.object({ channelId: z.string().min(1) }),
    run: (i) => {
      const id = String(i.channelId);
      if (!S.nodeExtra.alerts.channels.some((c) => c.id === id))
        throw new Error(`No channel called "${id}"`);
      S.tests.push(id);
      return { output: { ok: true }, summary: `Test message sent to ${id}` };
    },
  },
  {
    id: 'ai.moderation-labels',
    title: 'AI hints for items waiting for review',
    description: 'Hints only.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({ ids: z.array(z.string()).optional() }),
    run: () => ({ output: { labels: [] }, summary: '0 AI hints' }),
  },
  {
    id: 'experience.checklist',
    title: 'Setup checklist',
    description: 'Setup steps.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({}),
    run: () => {
      const backups = S.nodeExtra.backups.enabled;
      return {
        output: {
          hidden: false,
          items: [
            {
              id: 'backups',
              title: 'Turn on backups',
              done: false,
              state: backups ? 'in-progress' : 'todo',
              ...(backups ? { detail: 'Backups are on, waiting for the first one to finish' } : {}),
              available: true,
              link: { screen: '/settings/backups' },
            },
            {
              id: 'filters',
              title: 'Review blocked words',
              done: false,
              available: true,
              link: { screen: '/settings/filters' },
            },
            {
              id: 'test-relay',
              title: 'Test your relay from the outside',
              done: false,
              state: 'failed',
              detail: 'The last test could not connect',
              available: true,
              link: { screen: '/', actionId: 'experience.test-relay', input: {} },
            },
            {
              id: 'recovery-codes',
              title: 'Save recovery codes',
              done: true,
              state: 'done',
              available: true,
              link: { screen: '/people/admins' },
            },
          ],
        },
        summary: '1 of 4',
      };
    },
  },
  {
    id: 'experience.ping',
    title: 'Ping',
    description: 'Presence.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({}),
    run: () => ({ output: { ok: true }, summary: 'ok' }),
  },
  {
    id: 'moderation.queue',
    title: 'Review queue',
    description: 'Posts, reports and files waiting for a decision.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({ status: z.string().default('pending'), limit: z.number().default(50) }),
    run: () => {
      const items = S.queue.filter((q) => q.status === 'pending');
      return { output: { items, total: items.length }, summary: `${items.length} pending` };
    },
  },
  ...(['keep', 'remove'] as const).map(
    (kind): Action => ({
      id: `moderation.${kind}`,
      title: kind === 'keep' ? 'Keep' : 'Remove',
      description: kind === 'keep' ? 'Mark items as fine.' : 'Hide posts or files.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      shortcut: kind === 'keep' ? 'e' : 'x',
      input: z.object({ itemIds: z.array(z.string()).default([]) }),
      preview: (i) => [
        {
          kind: kind === 'keep' ? 'change' : 'remove',
          text: `${(i.itemIds as string[]).length} items`,
        },
      ],
      run: (i) => {
        const items = S.queue.filter((q) => (i.itemIds as string[]).includes(q.id));
        for (const q of items) q.status = kind === 'keep' ? 'kept' : 'removed';
        return {
          output: {},
          summary: kind === 'keep' ? 'Kept 1 item' : 'Removed 1 item',
          undo: () => {
            for (const q of items) q.status = 'pending';
          },
        };
      },
    }),
  ),
  {
    id: 'moderation.ban-pubkey',
    title: 'Block account',
    description: 'Stop these accounts from posting.',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    shortcut: '#',
    keywords: ['ban'],
    input: z.object({
      pubkeys: z.array(z.string()).min(1),
      reason: z.string().optional(),
      removeRecent: z.boolean().default(false),
    }),
    preview: (i) => [
      { kind: 'add', text: `${(i.pubkeys as string[]).length} accounts will be blocked` },
    ],
    run: (i) => ({ output: {}, summary: 'Blocked 1 account', undo: ban(i.pubkeys as string[]) }),
  },
  {
    id: 'moderation.recycle-bin',
    title: 'Recycle bin',
    description: 'Removed posts.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({}),
    run: () => ({ output: { items: [] }, summary: '0 items' }),
  },
  {
    id: 'admins.list',
    title: 'Show the team',
    description: 'Everyone who can manage this relay and their roles.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['team', 'admins'],
    input: z.object({}),
    run: () => ({
      output: {
        admins: [
          { id: PK, pubkey: PK, displayName: 'Owner', roles: { '*': 'owner' }, createdAt: now() },
        ],
      },
      summary: 'Listed 1 team member',
    }),
  },
  {
    id: 'access.create-invite',
    title: 'Create invite',
    description: 'A code people can use to join as members.',
    scope: 'relay',
    permission: 'users.write',
    keywords: ['invite', 'join'],
    input: z.object({
      expiresInHours: z.number().int().positive().max(8760).default(168),
      maxUses: z.number().int().positive().max(10000).default(1),
      note: z.string().max(200).optional(),
    }),
    preview: (i) => [
      {
        kind: 'add',
        text: `A new invite for ${i.maxUses} people, valid for ${i.expiresInHours} hours`,
      },
    ],
    run: () => {
      S.invites++;
      return {
        output: { code: `INVITE${S.invites}`, expiresAt: now() + 3600, maxUses: 1 },
        summary: 'Invite created',
        undo: () => S.invites--,
      };
    },
  },
  {
    id: 'policy.explain-limits',
    title: 'Why these limits?',
    description: 'Shows every limit.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({
      tier: z.string().optional(),
      goals: z.record(z.string(), z.number()).optional(),
    }),
    run: (i) => {
      const goals = i.goals as Record<string, number> | undefined;
      if (!goals) return { output: { lines: explainLimits(S.relay) }, summary: 'explained' };
      const hypo = { ...S.relay, goals: { ...S.relay.goals, ...goals } } as Relay;
      const smaller =
        (goals.storage ?? S.relay.goals.storage) < S.relay.goals.storage ||
        (goals.media ?? S.relay.goals.media) < S.relay.goals.media;
      return {
        output: {
          lines: explainLimits(hypo),
          quotaImpact: { nearQuota: smaller ? 1 : 0, overQuota: smaller ? 3 : 0 },
        },
        summary: 'what-if',
      };
    },
  },
  {
    id: 'media.list-blobs',
    title: 'List media files',
    description: 'See files uploaded to this relay.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({ limit: z.number().default(100), cursor: z.string().optional() }),
    run: () => ({
      output: {
        items: [
          {
            relayId: 'main',
            sha256: 'f'.repeat(64),
            pubkey: PK,
            size: 2048,
            type: 'application/pdf',
            uploadedAt: now() - 100,
          },
        ],
      },
      summary: '1 file',
    }),
  },
  {
    id: 'notes.list',
    title: 'Show internal notes',
    description: 'Notes the admin team left.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({ subject: z.unknown().optional(), limit: z.number().default(100) }),
    run: () => ({ output: { notes: [] }, summary: '0 notes' }),
  },
];

const GB = 1024 ** 3;
const PLUGIN_CATALOG = [
  {
    id: 'keyword-filter',
    name: 'Block words and phrases',
    version: '1.0.0',
    package: 'builtin:keyword-filter',
    description: 'Turn away, quietly hide, or hold for review any post containing words you list.',
    permissions: [] as string[],
    configSchema: z.toJSONSchema(
      z.object({
        keywords: z.array(z.string()).default([]).describe('Words or phrases to block'),
        action: z
          .enum(['reject', 'shadow', 'hold'])
          .default('reject')
          .describe('What to do with a match')
          .meta({
            'x-enumLabels': {
              reject: 'Turn the post away',
              shadow: 'Hide it quietly',
              hold: 'Hold it for review',
            },
          }),
      }),
      { io: 'input' },
    ),
  },
  {
    id: 'wot-strict',
    name: 'Only people in your web of trust',
    version: '1.0.0',
    package: 'builtin:wot-strict',
    description: 'Accept posts only from people you follow and the people they follow.',
    permissions: ['read-events'],
  },
  {
    id: 'rate-limit-burst',
    name: 'Stop bursts of posts',
    version: '1.0.0',
    package: 'builtin:rate-limit-burst',
    description: 'Let people post a short burst quickly, then slow them down.',
    permissions: [] as string[],
  },
];
const PERMISSION_TEXT: Record<string, string> = {
  'read-events': 'Read posts and profiles stored on this relay',
  network: 'Connect to other websites and servers on the internet',
};

function pluginRow(id: string) {
  const e = PLUGIN_CATALOG.find((p) => p.id === id);
  const st = S.plugins.get(id);
  return {
    id,
    name: e?.name ?? id,
    version: e?.version ?? '?',
    enabled: !!st?.enabled,
    status: st?.tripped ? 'tripped' : st?.enabled ? 'running' : 'disabled',
    permissions: e?.permissions ?? [],
    ...(st?.tripped ? { tripped: st.tripped } : {}),
    config: st?.config ?? {},
    ...(e && 'configSchema' in e ? { configSchema: e.configSchema } : {}),
    stats: {
      calls: st?.calls ?? 0,
      rejections: st?.rejections ?? 0,
      errors: st?.tripped ? 5 : 0,
      timeouts: 0,
      p95Ms: 1.8,
      avgMs: 0.4,
    },
  };
}

function setPlugin(id: string, patch: Partial<PluginState>) {
  const prev = S.plugins.get(id);
  const next: PluginState = {
    enabled: false,
    config: {},
    calls: 0,
    rejections: 0,
    ...prev,
    ...patch,
  };
  const { tripped, ...rest } = next;
  S.plugins.set(id, tripped ? next : rest);
  return () => {
    if (prev) S.plugins.set(id, prev);
    else S.plugins.delete(id);
  };
}

const MOCK_USERS = [
  { pubkey: 'c'.repeat(64), usedBytes: 2.1 * GB, quotaBytes: 5 * GB },
  { pubkey: 'd'.repeat(64), usedBytes: 6 * GB, quotaBytes: 5 * GB },
  { pubkey: 'e'.repeat(64), usedBytes: 1024 * 1024, quotaBytes: undefined },
];

function moreActions(): Action[] {
  const pid = z.object({ id: z.string().min(1) });
  return [
    {
      id: 'experience.test-relay',
      title: 'Test my relay',
      description: 'Checks your relay from the outside the way people will use it.',
      scope: 'relay',
      permission: 'config.write',
      readOnly: true,
      keywords: ['test', 'check'],
      input: z.object({ skipUpload: z.boolean().default(false), baseUrl: z.string().optional() }),
      run: (i) => {
        S.log.push({ id: 'experience.test-relay', input: i });
        const host = S.relay.hosts.find((h) => h !== '*');
        if (!host)
          return {
            output: {
              ok: false,
              needsDomain: true,
              summary: 'Your relay has no public address yet, so it cannot be tested from outside.',
            },
            summary: 'Needs a domain',
          };
        return {
          output: {
            relayId: 'main',
            ok: false,
            summary: '1 of 3 checks failed: upload a file.',
            urls: {},
            at: now(),
            steps: [
              {
                id: 'connect',
                title: 'Connect',
                status: 'pass',
                message: 'People can connect to your relay',
                technical: `wss://${host} → 101`,
                ms: 12,
              },
              {
                id: 'publish',
                title: 'Post',
                status: 'pass',
                message: 'A test post was accepted',
                technical: 'OK true',
                ms: 30,
              },
              {
                id: 'upload',
                title: 'Upload a file',
                status: 'fail',
                message: 'Uploading a file did not work',
                technical: 'PUT /upload → 413',
                ms: 40,
              },
            ],
          },
          summary: '1 of 3 checks failed',
        };
      },
    },
    {
      id: 'users.list',
      title: 'People',
      description: 'Everyone seen here recently.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ limit: z.number().default(50) }),
      run: () => ({
        output: {
          users: MOCK_USERS.map((u) => ({
            pubkey: u.pubkey,
            tier: 'member',
            tierExplicit: false,
            storageBytes: u.usedBytes,
            usedBytes: u.usedBytes,
            files: 2,
            banned: false,
            muted: false,
            allowlisted: false,
            lastSeen: now() - 3600,
            ...(u.quotaBytes
              ? {
                  quotaBytes: u.quotaBytes,
                  remainingBytes: Math.max(0, u.quotaBytes - u.usedBytes),
                  overQuota: u.usedBytes > u.quotaBytes,
                }
              : {}),
          })),
          total: MOCK_USERS.length,
        },
        summary: '3 people',
      }),
    },
    {
      id: 'media.usage-summary',
      title: 'Storage use',
      description: 'How much space media takes.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          totalUsedBytes: MOCK_USERS.reduce((a, u) => a + u.usedBytes, 0),
          people: MOCK_USERS.length,
          nearQuota: 1,
          overQuota: 1,
          largest: MOCK_USERS.map((u) => ({
            pubkey: u.pubkey,
            usedBytes: u.usedBytes,
            ...(u.quotaBytes ? { quotaBytes: u.quotaBytes } : {}),
            files: 2,
          })),
        },
        summary: 'usage',
      }),
    },
    {
      id: 'plugins.catalog',
      title: 'Browse plugins',
      description: 'See plugins you can add to your relay.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      keywords: ['plugins'],
      input: z.object({ refresh: z.boolean().default(false) }),
      run: () => ({
        output: {
          items: PLUGIN_CATALOG.map((e) => ({
            ...e,
            builtin: true,
            installed: S.plugins.has(e.id),
            enabled: !!S.plugins.get(e.id)?.enabled,
            compatible: true,
            minBeamhop: '0.0.0',
            permissionText: e.permissions.map((p) => PERMISSION_TEXT[p] ?? p),
          })),
        },
        summary: `${PLUGIN_CATALOG.length} plugins available`,
      }),
    },
    {
      id: 'plugins.status',
      title: 'Plugin health',
      description: 'How each plugin is doing.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({ output: { plugins: [...S.plugins.keys()].map(pluginRow) }, summary: '' }),
    },
    {
      id: 'plugins.install',
      title: 'Add a plugin',
      description: 'Add a plugin from the catalog.',
      scope: 'node',
      permission: 'plugins.write',
      input: z.object({
        id: z.string().min(1),
        enable: z.boolean().default(true),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
      preview: (i) => {
        const e = PLUGIN_CATALOG.find((p) => p.id === i.id);
        const perms = e?.permissions ?? [];
        const lines: Diff[] = [
          { kind: 'add', text: `Add “${e?.name ?? i.id}” (version ${e?.version ?? '?'})` },
        ];
        if (perms.length)
          for (const p of perms)
            lines.push({
              kind: 'info',
              text: `It will be able to: ${(PERMISSION_TEXT[p] ?? p).toLowerCase()}`,
              technical: p,
            });
        else
          lines.push({
            kind: 'info',
            text: 'It cannot read your data, save anything, or connect to the internet',
          });
        if (i.enable)
          lines.push({ kind: 'change', text: 'It will start checking new activity right away' });
        return lines;
      },
      run: (i) => {
        const id = String(i.id);
        const undo = setPlugin(id, {
          enabled: !!i.enable,
          config: (i.config as Record<string, unknown>) ?? {},
        });
        const name = PLUGIN_CATALOG.find((p) => p.id === id)?.name ?? id;
        return { output: pluginRow(id), summary: `Added “${name}”`, undo };
      },
    },
    ...([true, false] as const).map(
      (on): Action => ({
        id: on ? 'plugins.enable' : 'plugins.disable',
        title: on ? 'Turn a plugin on' : 'Turn a plugin off',
        description: on ? 'Start using a plugin.' : 'Stop using a plugin.',
        scope: 'node',
        permission: 'plugins.write',
        input: pid,
        preview: (i) => [
          {
            kind: 'change',
            text: on
              ? `“${i.id}” will start checking new activity`
              : `“${i.id}” will stop checking new activity`,
          },
        ],
        run: (i) => {
          const id = String(i.id);
          const undo = setPlugin(
            id,
            on ? { enabled: true, tripped: undefined } : { enabled: false },
          );
          return {
            output: pluginRow(id),
            summary: on ? `Turned on “${id}”` : `Turned off “${id}”`,
            undo,
          };
        },
      }),
    ),
    {
      id: 'plugins.configure',
      title: 'Change plugin settings',
      description: 'Adjust how a plugin behaves.',
      scope: 'node',
      permission: 'plugins.write',
      input: z.object({
        id: z.string().min(1),
        config: z.record(z.string(), z.unknown()).optional(),
        replace: z.boolean().default(false),
      }),
      preview: (i) =>
        Object.entries((i.config as Record<string, unknown>) ?? {}).map(([k, v]) => ({
          kind: 'change' as const,
          text: `${k}: ${JSON.stringify(v)}`,
        })),
      run: (i) => {
        const id = String(i.id);
        const prev = S.plugins.get(id);
        const undo = setPlugin(id, {
          config: { ...(prev?.config ?? {}), ...((i.config as object) ?? {}) },
        });
        return { output: pluginRow(id), summary: `Updated “${id}”`, undo };
      },
    },
    {
      id: 'plugins.uninstall',
      title: 'Remove a plugin',
      description: 'Turn a plugin off and delete it.',
      scope: 'node',
      permission: 'plugins.write',
      input: pid,
      preview: (i) => [{ kind: 'remove', text: `“${i.id}” will be turned off and removed` }],
      run: (i) => {
        const id = String(i.id);
        const prev = S.plugins.get(id);
        S.plugins.delete(id);
        return {
          output: { id, removed: true },
          summary: `Removed “${id}”`,
          undo: () => {
            if (prev) S.plugins.set(id, prev);
          },
        };
      },
    },
    {
      id: 'modules.list',
      title: 'Features',
      description: 'Optional features you can turn on.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          modules: [
            {
              id: 'enterprise-identity',
              title: 'Company sign-in',
              description: 'Sign in with Google Workspace, Microsoft Entra or another provider.',
              enabled: !!S.modules['enterprise-identity'],
            },
          ],
        },
        summary: '1 feature',
      }),
    },
    ...([true, false] as const).map(
      (on): Action => ({
        id: on ? 'modules.enable' : 'modules.disable',
        title: on ? 'Turn on a feature' : 'Turn off a feature',
        description: on ? 'Turn on an optional feature.' : 'Turn off an optional feature.',
        scope: 'node',
        permission: 'node.manage',
        input: pid,
        preview: (i) => [
          {
            kind: on ? 'add' : 'remove',
            text: on
              ? `Company sign-in will be turned on (${i.id})`
              : `Company sign-in will be turned off (${i.id})`,
          },
        ],
        run: (i) => {
          const id = String(i.id);
          const prev = !!S.modules[id];
          S.modules[id] = on;
          return {
            output: { id, enabled: on },
            summary: on ? 'Company sign-in is on' : 'Company sign-in is off',
            undo: () => {
              S.modules[id] = prev;
            },
          };
        },
      }),
    ),
    {
      id: 'enterprise.connect-idp',
      title: 'Connect your company directory',
      description: 'Step-by-step setup for Google, Microsoft or another sign-in provider.',
      scope: 'node',
      permission: 'config.write',
      input: z.object({
        provider: z.enum(['google', 'microsoft', 'oidc']),
        id: z.string().optional(),
        label: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        tenant: z.string().optional(),
        domain: z.string().optional(),
        issuer: z.string().url().optional(),
        baseUrl: z.string().url().optional(),
        scimToken: z.boolean().optional(),
      }),
      preview: (i) => [
        { kind: 'info', text: `Shows the setup steps for ${i.provider}` },
        ...(i.clientId
          ? [
              {
                kind: 'add' as const,
                text: `Adds ${i.provider} sign-in`,
                technical: String(i.clientId),
              },
            ]
          : []),
      ],
      run: (i) => {
        const base = String(i.baseUrl ?? 'http://localhost');
        const id = String(i.id ?? (i.provider === 'microsoft' ? 'entra' : i.provider));
        const prev = S.idp;
        if (i.clientId) {
          S.idp = {
            provider: String(i.provider),
            clientId: String(i.clientId),
            ...(i.tenant ? { tenant: String(i.tenant) } : {}),
            ...(i.domain ? { domain: String(i.domain) } : {}),
          };
          S.log.push({ id: 'enterprise.connect-idp', input: { ...i, clientSecret: '***' } });
        }
        const redirectUri = `${base}/api/v1/sso/${id}/callback`;
        const scim = i.provider !== 'google';
        const out = {
          output: {
            idp: id,
            steps: [
              {
                title: 'Create an app',
                body: 'In your admin console, create a new web app for sign-in.',
                copy: { 'Redirect address': redirectUri },
              },
              { title: 'Paste the client id and secret', body: 'Copy them back into Beamhop.' },
            ],
            values: {
              redirectUri,
              signInUrl: `${base}/api/v1/sso/${id}/start`,
              ...(scim ? { scimUrl: `${base}/scim/v2`, scimToken: 'scim-token-123' } : {}),
            },
            config: { id, type: i.provider, clientId: i.clientId ?? 'PASTE-CLIENT-ID' },
            applied: !!i.clientId,
          },
          summary: i.clientId ? `Connected ${i.provider}` : `Setup steps for ${i.provider}`,
        };
        return i.clientId
          ? {
              ...out,
              undo: () => {
                S.idp = prev;
              },
            }
          : out;
      },
    },
    {
      id: 'enterprise.test-connection',
      title: 'Test the company directory connection',
      description: 'Checks that sign-in and directory sync can reach your provider.',
      scope: 'node',
      permission: 'config.write',
      readOnly: true,
      input: z.object({ idp: z.string() }),
      run: (i) => {
        const checks = S.idp
          ? [
              {
                name: 'sign-in',
                ok: true,
                message: 'Sign-in provider answered',
                technical: `idp ${i.idp}`,
              },
            ]
          : [{ name: 'provider', ok: false, message: `“${i.idp}” is not set up yet` }];
        const ok = checks.every((c) => c.ok);
        return { output: { ok, checks }, summary: ok ? 'Connection works' : 'Connection problems' };
      },
    },
    {
      id: 'enterprise.list-mappings',
      title: 'Show directory group rules',
      description: 'What each company directory group can do here.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: { mappings: S.mappings },
        summary: `${S.mappings.length} group rules`,
      }),
    },
    {
      id: 'enterprise.map-group',
      title: 'Set what a directory group can do',
      description: 'Choose relays, tier, admin role and key type for a company group.',
      scope: 'node',
      permission: 'admins.manage',
      input: z.object({
        idp: z.string().default('*').describe('Sign-in provider id, or * for any'),
        group: z.string().min(1).describe('Directory group name, email or id'),
        relays: z
          .array(
            z.object({ relayId: z.string(), access: z.enum(['read', 'write']).default('write') }),
          )
          .default([])
          .describe('Relays this group can use'),
        tier: z.string().optional().describe('Limits and quotas for this group'),
        adminRole: z.enum(['owner', 'admin', 'moderator', 'viewer']).optional(),
        keyModel: z
          .enum(['managed', 'own'])
          .optional()
          .meta({ 'x-enumLabels': { managed: 'Company-held keys', own: 'Their own keys' } }),
        channel: z.boolean().default(true),
      }),
      preview: (i) => [{ kind: 'add', text: `“${i.group}” gets access` }],
      run: (i) => {
        const prev = S.mappings;
        S.mappings = [...S.mappings.filter((x) => x.group !== i.group), { ...i }];
        return {
          output: { mapping: i },
          summary: `Mapped ${i.group}`,
          undo: () => {
            S.mappings = prev;
          },
        };
      },
    },
  ];
}

ACTIONS.push(...moreActions());
registerPeopleMocks(ACTIONS, () => S);
ACTIONS.push(...pluginWriterActions({ setPlugin }));
registerMediaMocks(ACTIONS, () => S);
ACTIONS.push(
  ...enterprise.actions({
    mappings: () => S.mappings,
    setMappings: (m) => {
      S.mappings = m;
    },
  }),
);
enterprise.annotate(nodeSchemaJson);
ACTIONS.push(...homeActions(() => S).filter((a) => !ACTIONS.some((x) => x.id === a.id)));
ACTIONS.push(...(systemMockActions(() => S) as Action[]));
registerBackupsMocks(ACTIONS, () => S);

const catalog = (scope: 'node' | 'relay' | null) =>
  ACTIONS.filter((a) => scope !== 'relay' || a.scope === 'relay')
    .filter((a) => S.ai !== 'absent' || !a.id.startsWith('ai.'))
    .filter((a) => S.modules['enterprise-identity'] || !a.id.startsWith('enterprise.'))
    .filter((a) => enterprise.visible(a.id))
    .map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      scope: a.scope,
      permission: a.permission,
      readOnly: !!a.readOnly,
      sensitive: false,
      bulk: !!a.bulk,
      undoable: !a.readOnly,
      hasPreview: !!a.preview,
      keywords: a.keywords ?? [],
      shortcut: a.shortcut,
      cli: `beamhop ${a.id.split('.').join(' ')}`,
      inputSchema: z.toJSONSchema(a.input, { io: 'input', unrepresentable: 'any' }),
      allowed: true,
    }));

const PERMS = [
  'relay.read',
  'config.write',
  'moderation.write',
  'users.write',
  'media.write',
  'admins.manage',
  'insights.read',
  'node.manage',
  'plugins.write',
];
const principal = {
  id: PK,
  pubkey: PK,
  displayName: 'Owner',
  roles: { '*': 'owner' },
  via: 'nip07',
  permissions: { '*': PERMS, main: PERMS },
};

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

const app = new Hono();
registerActivityMocks({ app, actions: ACTIONS as never, state: () => S as never, token });
registerTopTaskMocks({ app, actions: ACTIONS as never, state: () => S as never, token });

app.post('/__reset', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ResetOptions;
  S = freshState(!!body.claimed, body.ai ?? 'absent', body);
  enterprise.reset(!!body.enterprise);
  if (body.enterprise) Object.assign(S, enterprise.seed(S.modules));
  return c.json({ ok: true });
});
app.get('/__log', (c) =>
  c.json({
    log: S.log,
    bans: [...S.bans],
    relay: S.relay,
    channels: S.nodeExtra.alerts.channels,
    tests: S.tests,
    assistant: S.assistantRequests,
    plugins: Object.fromEntries(S.plugins),
    modules: S.modules,
    idp: S.idp,
    mappings: S.mappings,
  }),
);

app.get('/healthz', (c) => c.json({ status: 'ok', connections: 7 }));
app.get('/.well-known/beamhop/self-check', (c) =>
  c.json({
    ok: true,
    nodeId: 'local',
    tls: 'off',
    trustProxy: false,
    seen: { host: 'localhost', proto: 'http', forwardedFor: false },
    relay: { id: 'main', publicUrl: 'http://localhost' },
    problems: [],
  }),
);

app.all('/api/v1/*', async (c) => {
  const url = new URL(c.req.url);
  const method = c.req.method;
  let path = url.pathname.slice('/api/v1'.length);
  if (path === '/nodes')
    return c.json({
      nodes: [
        {
          id: 'local',
          runtime: 'bun',
          relays: [
            { id: 'main', name: S.relay.info.name, hosts: S.relay.hosts, persona: S.relay.persona },
          ],
        },
      ],
    });
  if (path.startsWith('/sso/')) return fail(404, 'not_found', 'Not found');
  const m = path.match(/^\/nodes\/(self|local)(\/relays\/([a-z0-9-]+))?(\/.*)$/);
  if (!m) return fail(404, 'not_found', 'Not found');
  const relayScoped = !!m[3];
  path = m[4] as string;
  const body =
    method === 'POST' ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const authed = (c.req.header('authorization') ?? '').startsWith('Bearer ');

  if (path === '/auth/status')
    return c.json({ node: 'local', claimed: S.claimed, providers: [], passkeys: true });
  if (path === '/auth/nostr' && method === 'POST') {
    const h = c.req.header('authorization') ?? '';
    if (!h.startsWith('Nostr '))
      return fail(401, 'bad_signature', 'Sign-in failed. Please try again.');
    const ev = JSON.parse(atob(h.slice(6))) as { kind: number; tags: string[][] };
    if (ev.kind !== 27235 || !ev.tags.some((t) => t[0] === 'u' && t[1]?.endsWith('/auth/nostr')))
      return fail(401, 'bad_signature', 'Sign-in failed. Please try again.');
    let recoveryCodes: string[] | undefined;
    if (!S.claimed) {
      if (body.claimCode !== 'TEST-CODE-1234')
        return fail(403, 'bad_code', 'That claim code is not valid');
      S.claimed = true;
      recoveryCodes = ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'];
    }
    return c.json({
      token: 'session-token',
      expiresAt: now() + 3600,
      principal,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    });
  }
  if (!authed) return fail(401, 'unauthenticated', 'Please sign in');

  if (path === '/auth/me') return c.json(principal);
  if (path === '/auth/recovery-codes') return c.json({ remaining: 10, owner: true });
  if (path === '/ui')
    return c.json(
      withBackupsRoute({
        routes: S.modules['enterprise-identity']
          ? [
              {
                path: '/settings/company',
                title: 'Company sign-in',
                placement: 'settings-section',
                chunk: 'enterprise-identity',
              },
              ...enterprise.routes(),
            ]
          : [],
      }),
    );
  if (path === '/playbooks') return c.json({ playbooks: [] });
  if (path === '/health')
    return c.json({
      score: 92,
      status: 'ok',
      message: 'Everything looks healthy',
      subsystems: [
        { subsystem: 'relay', score: 100, status: 'ok', message: 'ok' },
        { subsystem: 'storage', score: 80, status: 'warn', message: 'Disk 82%' },
      ],
      checks: [],
    });
  if (path === '/cards') return c.json({ cards: [] });
  if (path === '/activity') return c.json({ items: [] });
  if (path === '/live') {
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(': connected\n\nevent: ready\ndata: {}\n\n'));
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (path === '/actions') return c.json({ actions: catalog(relayScoped ? 'relay' : null) });
  if (path === '/assistant' && method === 'POST') return assistant(body);

  // POST /actions/{id}/bulk: run a bulk-capable action per input, one undo for all.
  const bulkAct = path.match(/^\/actions\/([^/]+)\/bulk$/);
  if (bulkAct && method === 'POST') {
    const def = ACTIONS.find((a) => a.id === bulkAct[1]);
    if (!def) return fail(404, 'unknown_action', 'That action does not exist');
    if (!def.bulk) return fail(400, 'not_bulk', 'This action cannot be run for many items at once');
    const undos: Array<() => void> = [];
    const results = ((body.inputs as unknown[]) ?? []).map((raw) => {
      const p = def.input.safeParse(raw);
      if (!p.success) return { ok: false, error: { code: 'invalid_input', message: 'Not valid' } };
      try {
        const r = def.run(p.data as Record<string, unknown>);
        S.log.push({ id: def.id, input: p.data });
        if (r.undo) undos.push(r.undo);
        return { ok: true, output: r.output, summary: r.summary };
      } catch (err) {
        return { ok: false, error: { code: 'action_failed', message: (err as Error).message } };
      }
    });
    const done = results.filter((r) => r.ok).length;
    const out: Record<string, unknown> = { results, summary: `${def.title}: ${done} done` };
    if (undos.length) {
      const t = token();
      S.undo.set(t, () => {
        for (const u of undos.reverse()) u();
      });
      out.undo = { token: t, expiresAt: now() + 300 };
    }
    return c.json(out);
  }

  const act = path.match(/^\/actions\/([^/]+)(\/preview)?$/);
  if (act && method === 'POST') {
    const def = ACTIONS.find((a) => a.id === act[1]);
    if (!def) return fail(404, 'unknown_action', 'That action does not exist');
    const parsed = def.input.safeParse(body.input ?? {});
    if (!parsed.success)
      return Response.json(
        {
          error: {
            code: 'invalid_input',
            message: 'Some fields are not valid',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
        { status: 422 },
      );
    const input = parsed.data as Record<string, unknown>;
    if (act[2])
      return c.json({
        action: def.id,
        diff: def.readOnly ? [] : (def.preview?.(input) ?? [{ kind: 'info', text: def.title }]),
      });
    let r: ReturnType<Action['run']>;
    try {
      r = def.run(input);
    } catch (err) {
      return fail(422, 'action_failed', (err as Error).message);
    }
    if (!def.readOnly) S.log.push({ id: def.id, input });
    const out: Record<string, unknown> = { output: r.output, summary: r.summary };
    if (r.undo) {
      const t = token();
      S.undo.set(t, r.undo);
      out.undo = { token: t, expiresAt: now() + 300 };
    }
    return c.json(out);
  }
  const und = path.match(/^\/undo\/([0-9a-f]+)$/);
  if (und) {
    const fn = S.undo.get(und[1] as string);
    if (!fn) return fail(410, 'undo_expired', 'This can no longer be undone');
    S.undo.delete(und[1] as string);
    fn();
    S.log.push({ id: 'undo', input: und[1] });
    return c.json({ ok: true, undone: 'the change' });
  }

  if (path === '/config')
    return relayScoped
      ? c.json({ revision: S.revision, relay: S.relay })
      : c.json({ revision: S.revision, config: nodeConfig(), knownGoodRevision: null });
  if (path === '/config/schema') return c.json(relayScoped ? relaySchemaJson : nodeSchemaJson);
  if (path === '/config/propose') {
    const before = relayScoped ? S.relay : nodeConfig();
    let next: unknown = before;
    if (body.merge !== undefined) next = deepMerge(before, body.merge);
    if (body.patch) next = applyPatch(before, body.patch as never);
    try {
      next = relayScoped ? RelaySchema.parse(next) : ConfigSchema.parse(next);
    } catch (err) {
      return Response.json(
        {
          error: {
            code: 'invalid_config',
            message: 'That change is not valid',
            technical: String(err),
          },
        },
        { status: 422 },
      );
    }
    const diff = describeChanges(before, next);
    const id = token();
    S.proposals.set(id, {
      relay: relayScoped,
      next,
      diff,
      summary: String(body.summary ?? 'Changed settings'),
    });
    return c.json({
      id,
      baseRevision: S.revision,
      scope: relayScoped ? 'main' : null,
      expiresAt: now() + 600,
      summary: body.summary ?? '',
      changed: diff.length > 0,
      diff,
      patch: [],
    });
  }
  if (path === '/config/commit') {
    const p = S.proposals.get(String(body.proposalId));
    if (!p) return fail(404, 'not_found', 'This change expired');
    const prevRelay = S.relay;
    const prevNode = S.nodeExtra;
    if (p.relay) S.relay = p.next as Relay;
    else {
      const { relays, ...rest } = p.next as ReturnType<typeof nodeConfig>;
      S.nodeExtra = rest as typeof S.nodeExtra;
      S.relay = relays[0] as Relay;
    }
    S.revision++;
    const rev = {
      revision: S.revision,
      at: now(),
      author: PK,
      authorName: 'Owner',
      summary: p.summary,
      source: 'ui',
      changes: p.diff.length,
    };
    S.revisions.unshift(rev);
    S.log.push({ id: 'config.commit', input: p.diff });
    const t = token();
    S.undo.set(t, () => {
      S.relay = prevRelay;
      S.nodeExtra = prevNode;
    });
    return c.json({ revision: rev, undo: { token: t, expiresAt: now() + 300 } });
  }
  if (path === '/config/revisions') return c.json({ items: S.revisions });
  return fail(404, 'not_found', `No mock for ${method} ${path}`);
});

/** `POST /assistant`: canned SSE answer in the ai package's event format. */
function assistant(body: Record<string, unknown>): Response {
  if (S.ai === 'absent') return fail(404, 'not_found', 'Not found');
  if (S.ai === 'off')
    return fail(503, 'ai_disabled', 'The assistant is turned off. Turn it on in Settings → AI.');
  S.assistantRequests.push(body);
  const relay = (body.context as { relayId?: string } | undefined)?.relayId ?? 'main';
  const input = { pubkeys: [SPAMMER] };
  const events = [
    {
      type: 'meta',
      sessionId: 'sess1',
      tools: ['read_health', 'propose_moderation_ban_pubkey'],
      proposalsAllowed: true,
    },
    { type: 'tool-call', id: 'c1', name: 'read_health', kind: 'read', args: {} },
    {
      type: 'tool-result',
      id: 'c1',
      name: 'read_health',
      ok: true,
      summary: 'Checked the relay health',
    },
    { type: 'text', delta: 'Your relay is healthy. ' },
    { type: 'text', delta: 'One account is sending spam; I suggest blocking it.' },
    {
      type: 'proposal',
      proposal: {
        id: 'prop1',
        kind: 'action',
        actionId: 'moderation.ban-pubkey',
        title: 'Block account',
        input,
        diffLines: [
          { kind: 'add', text: '1 account will be blocked', technical: 'policy.bans += 1' },
        ],
        relayId: relay,
        sensitive: false,
        undoable: true,
        requiresApproval: true,
        approve: {
          method: 'POST',
          path: `/api/v1/nodes/local/relays/${relay}/actions/moderation.ban-pubkey`,
          body: { input, reason: 'Suggested by the assistant' },
        },
      },
    },
    {
      type: 'done',
      result: {
        sessionId: 'sess1',
        text: '',
        proposals: [],
        toolCalls: [],
        usage: { tokens: 10, limit: 1000, rounds: 2 },
      },
    },
  ];
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      for (const [i, e] of events.entries()) {
        ctrl.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\nid: ${i}\n\n`));
        await new Promise((r) => setTimeout(r, 15));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

// Static app with SPA fallback (like runtime-bun's asset server).
app.get('/admin/*', (c) => serve(c.req.path));
app.get('/admin', (c) => serve('/admin/'));
app.get('/', (c) => c.redirect('/admin/'));

function serve(pathname: string): Response {
  let rel = pathname.slice('/admin'.length) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  const p = normalize(join(BUILD, rel));
  const file =
    p.startsWith(BUILD) && existsSync(p) && statSync(p).isFile() ? p : join(BUILD, 'index.html');
  return new Response(Bun.file(file));
}

Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: app.fetch, idleTimeout: 0 });
console.log(`mock admin API on http://127.0.0.1:${PORT}/admin/`);
