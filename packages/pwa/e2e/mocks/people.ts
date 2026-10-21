// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mock actions for People and Settings → Security: bulk-capable mute and
 * member removal, plans, the team (second owner), recovery status, API
 * tokens and internal notes. State lives per mock-server state object, so
 * `POST /__reset` starts it fresh.
 */
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

/** The bits of the mock server's state this module reads. */
interface HostState {
  bans: Set<string>;
}

const OWNER = 'a'.repeat(64);
const GB = 1024 ** 3;
/** Same people as the mock server's `users.list` (quota numbers kept identical). */
const PEOPLE = [
  { pubkey: 'c'.repeat(64), usedBytes: 2.1 * GB, quotaBytes: (5 * GB) as number | undefined },
  { pubkey: 'd'.repeat(64), usedBytes: 6 * GB, quotaBytes: (5 * GB) as number | undefined },
  { pubkey: 'e'.repeat(64), usedBytes: 1024 * 1024, quotaBytes: undefined as number | undefined },
];

const now = () => Math.floor(Date.now() / 1000);
const short = (pk: string) => `${pk.slice(0, 8)}…`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Admin {
  id: string;
  pubkey: string;
  displayName: string;
  roles: Record<string, string>;
  createdAt: number;
}

interface Token {
  id: string;
  adminId: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
}

interface PeopleState {
  mutes: Set<string>;
  tiers: Map<string, string | null>;
  allow: Set<string>;
  admins: Admin[];
  tokens: Token[];
  notes: Array<{
    id: string;
    key: string;
    text: string;
    author: string;
    authorName: string;
    at: number;
  }>;
  codesLeft: number;
  seq: number;
}

const states = new WeakMap<object, PeopleState>();

function fresh(): PeopleState {
  const t = now();
  return {
    mutes: new Set(),
    tiers: new Map(),
    allow: new Set(PEOPLE.map((p) => p.pubkey)),
    admins: [
      { id: OWNER, pubkey: OWNER, displayName: 'Owner', roles: { '*': 'owner' }, createdAt: t },
    ],
    tokens: [
      {
        id: '0123456789abcdef',
        adminId: OWNER,
        name: 'Backup script',
        scopes: ['relay.read', 'moderation.write'],
        createdAt: t - 10 * 86400,
        expiresAt: t + 80 * 86400,
        lastUsedAt: t - 3600,
      },
    ],
    notes: [],
    codesLeft: 10,
    seq: 0,
  };
}

const Pubkeys = z.array(z.string()).min(1);

/** Replace or add the People/Security mock actions in the server's action list. */
export function registerPeopleMocks(actions: MockAction[], host: () => HostState): void {
  const st = (): PeopleState => {
    const h = host();
    let s = states.get(h);
    if (!s) {
      s = fresh();
      states.set(h, s);
    }
    return s;
  };
  const nameOf = (id: string) => st().admins.find((a) => a.id === id)?.displayName ?? short(id);
  const owners = () => st().admins.filter((a) => a.roles['*'] === 'owner');

  const mine: MockAction[] = [
    {
      id: 'users.list',
      title: 'People',
      description: 'Everyone seen here recently.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ limit: z.number().default(50) }),
      run: () => {
        const s = st();
        const bans = host().bans;
        const users = PEOPLE.map((u) => ({
          pubkey: u.pubkey,
          tier: s.tiers.get(u.pubkey) ?? 'default',
          tierExplicit: s.tiers.has(u.pubkey) && s.tiers.get(u.pubkey) !== null,
          storageBytes: u.usedBytes,
          usedBytes: u.usedBytes,
          files: 2,
          banned: bans.has(u.pubkey),
          muted: s.mutes.has(u.pubkey),
          allowlisted: s.allow.has(u.pubkey),
          lastSeen: now() - 3600,
          ...(u.quotaBytes
            ? {
                quotaBytes: u.quotaBytes,
                remainingBytes: Math.max(0, u.quotaBytes - u.usedBytes),
                overQuota: u.usedBytes > u.quotaBytes,
              }
            : {}),
        }));
        return { output: { users, total: users.length }, summary: `${users.length} people` };
      },
    },
    {
      id: 'moderation.mute-pubkey',
      title: 'Mute account',
      description: 'Their posts look sent to them but nobody else sees them.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      keywords: ['mute'],
      input: z.object({ pubkeys: Pubkeys, hours: z.number().int().positive().optional() }),
      preview: (i) => [
        { kind: 'add', text: `${plural((i.pubkeys as string[]).length, 'account')} will be muted` },
      ],
      run: (i) => {
        const s = st();
        const added = (i.pubkeys as string[]).filter((p) => !s.mutes.has(p));
        for (const p of added) s.mutes.add(p);
        return {
          output: { muted: added.length },
          summary: `Muted ${plural(added.length, 'account')}`,
          undo: () => {
            for (const p of added) s.mutes.delete(p);
          },
        };
      },
    },
    {
      id: 'users.set-tier',
      title: 'Change plan',
      description: 'Move a person to another tier (limits bundle).',
      scope: 'relay',
      permission: 'users.write',
      keywords: ['tier', 'plan'],
      input: z.object({ pubkey: z.string(), tier: z.string().nullable() }),
      preview: (i) => [
        {
          kind: 'change',
          text:
            i.tier === null
              ? `${short(i.pubkey as string)} goes back to the automatic plan`
              : `${short(i.pubkey as string)} moves to ${i.tier}`,
          technical: `policy.tiers[${i.pubkey}] → ${i.tier ?? '(rules/default)'}`,
        },
      ],
      run: (i) => {
        const s = st();
        const pk = i.pubkey as string;
        const had = s.tiers.has(pk);
        const prev = s.tiers.get(pk);
        s.tiers.set(pk, i.tier as string | null);
        return {
          output: { pubkey: pk, tier: i.tier },
          summary: 'Changed plan',
          undo: () => {
            if (had) s.tiers.set(pk, prev ?? null);
            else s.tiers.delete(pk);
          },
        };
      },
    },
    {
      id: 'access.remove-allowlist',
      title: 'Remove members',
      description: 'These people can no longer post (unless the relay is open).',
      scope: 'relay',
      permission: 'users.write',
      bulk: true,
      keywords: ['allowlist'],
      input: z.object({ pubkeys: Pubkeys }),
      preview: (i) => {
        const n = (i.pubkeys as string[]).filter((p) => st().allow.has(p)).length;
        return [
          { kind: 'remove', text: `${plural(n, 'person', 'people')} will no longer be members` },
        ];
      },
      run: (i) => {
        const s = st();
        const gone = (i.pubkeys as string[]).filter((p) => s.allow.delete(p));
        return {
          output: { removed: gone.length },
          summary: `Removed ${plural(gone.length, 'member')}`,
          undo: () => {
            for (const p of gone) s.allow.add(p);
          },
        };
      },
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
        output: { admins: st().admins.map((a) => ({ ...a })) },
        summary: `Listed ${plural(st().admins.length, 'team member')}`,
      }),
    },
    {
      id: 'admins.invite',
      title: 'Invite an admin',
      description: 'Give someone access to manage this relay.',
      scope: 'node',
      permission: 'admins.manage',
      keywords: ['team', 'invite', 'owner'],
      input: z.object({
        pubkey: z.string().optional().describe('Their Nostr public key (npub…)'),
        role: z.enum(['owner', 'admin', 'moderator', 'viewer']).describe('What they may do'),
        relayId: z.string().optional(),
        displayName: z.string().max(80).optional().describe('Name shown to the team'),
      }),
      preview: (i) => {
        const who = (i.displayName as string) ?? 'The person with the invite code';
        const lines: Diff[] = [
          {
            kind: 'add',
            text: `${who} will become ${i.role === 'owner' ? 'an owner' : `a ${i.role}`} on all relays`,
          },
        ];
        if (i.role === 'owner')
          lines.push({
            kind: 'warning',
            text: 'They will be able to do everything you can, including removing you',
          });
        return lines;
      },
      run: (i) => {
        const s = st();
        if (!i.pubkey)
          return {
            output: { code: 'TEAM-INVITE-1', expiresAt: now() + 7 * 86400 },
            summary: 'Created an invite code',
          };
        const pk = i.pubkey as string;
        const rec: Admin = {
          id: pk,
          pubkey: pk,
          displayName: (i.displayName as string) ?? short(pk),
          roles: { [(i.relayId as string) ?? '*']: i.role as string },
          createdAt: now(),
        };
        s.admins.push(rec);
        return {
          output: { adminId: pk },
          summary: `Invited ${rec.displayName}`,
          undo: () => {
            s.admins = s.admins.filter((a) => a.id !== pk);
          },
        };
      },
    },
    {
      id: 'admins.recovery-status',
      title: 'Check how you would get back in',
      description: 'Recovery codes, a second owner and passkeys.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          owner: true,
          owners: owners().map((a) => ({ id: a.id, pubkey: a.pubkey, displayName: a.displayName })),
          recoveryCodesLeft: st().codesLeft,
          passkeys: 0,
        },
        summary: `${owners().length} owners`,
      }),
    },
    {
      id: 'admins.recovery-codes',
      title: 'Create new owner recovery codes',
      description: 'Get a fresh set of one-time codes.',
      scope: 'node',
      permission: 'admins.manage',
      input: z.object({}),
      preview: () => [
        { kind: 'warning', text: 'Your current recovery codes will stop working' },
        { kind: 'add', text: '10 new recovery codes will be created — store them somewhere safe' },
      ],
      run: () => {
        st().codesLeft = 10;
        return {
          output: { codes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'] },
          summary: 'Created new owner recovery codes',
        };
      },
    },
    {
      id: 'tokens.list',
      title: 'Show API tokens',
      description: 'Your API tokens (owners see everyone’s).',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: { tokens: st().tokens.map((t) => ({ ...t, adminName: nameOf(t.adminId) })) },
        summary: `Listed ${plural(st().tokens.length, 'API token')}`,
      }),
    },
    {
      id: 'tokens.create',
      title: 'Create an API token',
      description:
        'A key for scripts and automation. It can only do what you allow, and it expires.',
      scope: 'node',
      permission: 'relay.read',
      keywords: ['api', 'token'],
      input: z.object({
        name: z.string().min(1).max(80).describe('What it is for'),
        scopes: z
          .array(z.enum(['relay.read', 'moderation.write', 'config.write']))
          .min(1)
          .optional()
          .describe('What it may do (default: everything you can do)'),
        expiresInDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(90)
          .describe('Days until it stops working'),
      }),
      preview: (i) => [
        { kind: 'add', text: `New API token “${i.name}” that expires in ${i.expiresInDays} days` },
      ],
      run: (i) => {
        const s = st();
        const id = (++s.seq).toString(16).padStart(16, '0');
        const rec: Token = {
          id,
          adminId: OWNER,
          name: i.name as string,
          scopes: (i.scopes as string[]) ?? ['relay.read', 'moderation.write', 'config.write'],
          createdAt: now(),
          expiresAt: now() + (i.expiresInDays as number) * 86400,
        };
        s.tokens.push(rec);
        return {
          output: { token: `bh_${id}_${'f'.repeat(48)}`, ...rec },
          summary: `Created API token “${rec.name}”`,
          undo: () => {
            s.tokens = s.tokens.filter((t) => t.id !== id);
          },
        };
      },
    },
    {
      id: 'tokens.revoke',
      title: 'Revoke an API token',
      description: 'The token stops working immediately.',
      scope: 'node',
      permission: 'relay.read',
      input: z.object({ id: z.string() }),
      preview: (i) => [{ kind: 'remove', text: `API token “${i.id}” will stop working` }],
      run: (i) => {
        const s = st();
        const t = s.tokens.find((x) => x.id === i.id);
        if (!t) throw new Error('That token does not exist');
        s.tokens = s.tokens.filter((x) => x.id !== t.id);
        return {
          output: { id: t.id },
          summary: `Revoked API token “${t.name}”`,
          undo: () => {
            s.tokens.push(t);
          },
        };
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
        const subj = i.subject as { type: string; id: string } | undefined;
        const key = subj ? `${subj.type}|${subj.id}` : null;
        const notes = st()
          .notes.filter((n) => !key || n.key === key)
          .sort((a, b) => b.at - a.at);
        return { output: { notes }, summary: `${plural(notes.length, 'note')}` };
      },
    },
    {
      id: 'notes.add',
      title: 'Add an internal note',
      description: 'Leave a note for the admin team. Only admins can see it.',
      scope: 'relay',
      permission: 'moderation.write',
      input: z.object({
        subject: z.object({ type: z.enum(['user', 'event', 'blob']), id: z.string().min(1) }),
        text: z.string().min(1).max(4000),
      }),
      preview: () => [{ kind: 'add', text: 'A note for the team' }],
      run: (i) => {
        const s = st();
        const subj = i.subject as { type: string; id: string };
        const id = `n${++s.seq}`;
        s.notes.push({
          id,
          key: `${subj.type}|${subj.id}`,
          text: i.text as string,
          author: OWNER,
          authorName: 'Owner',
          at: now(),
        });
        return {
          output: { note: { id } },
          summary: 'Added a note',
          undo: () => {
            s.notes = s.notes.filter((n) => n.id !== id);
          },
        };
      },
    },
  ];

  for (const a of mine) {
    const i = actions.findIndex((x) => x.id === a.id);
    if (i >= 0) actions.splice(i, 1, a);
    else actions.push(a);
  }
}
