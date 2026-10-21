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

function freshState(claimed: boolean, ai: AiMode = 'absent') {
  const relay: Relay = RelaySchema.parse({
    id: 'main',
    hosts: ['*'],
    info: { name: 'Test Relay' },
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
    cards: [
      {
        key: 'batch:main:spam-wave',
        relayId: 'main',
        severity: 'warning' as const,
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
    ],
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
      const undoBan = ban((card?.primary.inputs[0] as { pubkeys: string[] }).pubkeys);
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
    run: () => ({
      output: {
        hidden: false,
        items: [
          {
            id: 'backups',
            title: 'Turn on backups',
            done: false,
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
            id: 'recovery-codes',
            title: 'Save recovery codes',
            done: true,
            available: true,
            link: { screen: '/people/admins' },
          },
        ],
      },
      summary: '1 of 2',
    }),
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
    input: z.object({ tier: z.string().optional() }),
    run: () => ({ output: { lines: explainLimits(S.relay) }, summary: 'explained' }),
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

const catalog = (scope: 'node' | 'relay' | null) =>
  ACTIONS.filter((a) => scope !== 'relay' || a.scope === 'relay')
    .filter((a) => S.ai !== 'absent' || !a.id.startsWith('ai.'))
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

app.post('/__reset', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { claimed?: boolean; ai?: AiMode };
  S = freshState(!!body.claimed, body.ai ?? 'absent');
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
  if (path === '/ui') return c.json({ routes: [] });
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
