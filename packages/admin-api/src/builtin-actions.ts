// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Actions owned by the admin API: team management (§6.12), API tokens,
 * owner recovery codes and internal notes. Like every admin operation they
 * live in the action registry, so routes/CLI/palette are generated.
 */
import {
  type ActionContext,
  type ActionDef,
  type Kernel,
  type Permission,
  ROLE_PERMISSIONS,
  type Role,
  defineAction,
  permissionsFor,
} from '@beamhop/core';
import { z } from 'zod';
import {
  type AdminRecord,
  type Directory,
  displayNameOf,
  isOwner,
  parsePubkey,
} from './auth/directory.ts';
import type { TokenRecord, TokenService } from './auth/tokens.ts';
import { COL } from './settings.ts';
import { HttpError, seqKey } from './util.ts';

const ROLES = ['owner', 'admin', 'moderator', 'viewer'] as const;
const PERMISSIONS = ROLE_PERMISSIONS.owner as unknown as [Permission, ...Permission[]];
const INVITE_TTL = 7 * 86400;

const ROLE_LABEL: Record<Role, string> = {
  owner: 'an owner',
  admin: 'an admin',
  moderator: 'a moderator',
  viewer: 'a viewer',
};

export interface Note {
  id: string;
  relayId: string;
  subject: { type: 'user' | 'event' | 'blob'; id: string };
  text: string;
  author: string;
  authorName: string;
  at: number;
}

function where(kernel: Kernel, relayId: string | undefined): string {
  if (!relayId) return 'on all relays';
  const r = kernel.relay(relayId);
  return `on relay “${r?.info.name && r.info.name !== 'Beamhop Relay' ? r.info.name : relayId}”`;
}

function assertRelay(kernel: Kernel, relayId: string | undefined): void {
  if (relayId && !kernel.relay(relayId))
    throw new HttpError(404, 'not_found', `There is no relay called “${relayId}”`);
}

export function builtinActions(kernel: Kernel, dir: Directory, tokens: TokenService): ActionDef[] {
  const undoAt = () =>
    kernel.ports.clock.now() +
    (kernel.moduleConfig<{ undoWindowSeconds: number }>('admin-api')?.undoWindowSeconds ?? 300);
  const nameOf = async (id: string) => displayNameOf(await dir.get(id), id);

  const assertNotLastOwner = async (rec: AdminRecord, nextRoles: AdminRecord['roles'] | null) => {
    if (!isOwner(rec)) return;
    if (nextRoles && nextRoles['*'] === 'owner') return;
    if ((await dir.ownerCount()) <= 1)
      throw new HttpError(
        409,
        'last_owner',
        'This is the only owner. Add another owner first so the relay is never left without one.',
      );
  };

  const invite = defineAction({
    id: 'admins.invite',
    title: 'Invite an admin',
    description:
      'Give someone access to manage this relay, with a role that limits what they can do.',
    technical:
      'Adds an admin principal (by Nostr pubkey) or creates a one-time invite code (7 days) redeemable via NIP-98 or passkey login.',
    scope: 'node',
    permission: 'admins.manage',
    keywords: ['team', 'add admin', 'moderator', 'invite'],
    input: z.object({
      pubkey: z
        .string()
        .optional()
        .describe('Their Nostr public key (npub…). Leave empty to get an invite code.'),
      role: z.enum(ROLES).describe('What they may do'),
      relayId: z.string().optional().describe('Limit access to one relay (empty = all relays)'),
      displayName: z.string().max(80).optional().describe('Name shown to the team'),
    }),
    async preview(input) {
      const who =
        input.displayName ??
        (input.pubkey ? input.pubkey.slice(0, 16) : 'The person with the invite code');
      return [
        {
          kind: 'add',
          text: `${who} will become ${ROLE_LABEL[input.role]} ${where(kernel, input.relayId)}`,
          technical: `roles[${input.relayId ?? '*'}] = ${input.role}`,
        },
      ];
    },
    async run(input, ctx) {
      assertRelay(kernel, input.relayId);
      if (input.role === 'owner' && input.relayId)
        throw new HttpError(400, 'bad_request', 'Owners always manage all relays');
      const roles = { [input.relayId ?? '*']: input.role } as AdminRecord['roles'];
      if (input.pubkey) {
        const pk = parsePubkey(input.pubkey);
        if (!pk)
          throw new HttpError(400, 'bad_request', 'That does not look like a Nostr public key');
        if (await dir.get(pk))
          throw new HttpError(409, 'exists', 'This person is already on the team');
        const rec: AdminRecord = {
          id: pk,
          pubkey: pk,
          roles,
          createdAt: kernel.ports.clock.now(),
          createdBy: ctx.principal.id,
        };
        if (input.displayName) rec.displayName = input.displayName;
        await dir.put(rec);
        const name = displayNameOf(rec, pk);
        return {
          output: { adminId: pk } as Record<string, unknown>,
          summary: `Invited ${name} as ${ROLE_LABEL[input.role]} ${where(kernel, input.relayId)}`,
          undo: { actionId: 'admins.invite', payload: { adminId: pk }, expiresAt: undoAt() },
        };
      }
      const inv: Parameters<Directory['createInvite']>[0] = { roles, createdBy: ctx.principal.id };
      if (input.displayName) inv.displayName = input.displayName;
      const { code, invite: rec } = await dir.createInvite(inv, INVITE_TTL);
      return {
        output: { code, inviteId: rec.id, expiresAt: rec.expiresAt } as Record<string, unknown>,
        summary: `Created an invite code for ${ROLE_LABEL[input.role]} ${where(kernel, input.relayId)}`,
        undo: { actionId: 'admins.invite', payload: { inviteId: rec.id }, expiresAt: undoAt() },
      };
    },
    async undo(payload) {
      const p = payload as { adminId?: string; inviteId?: string };
      if (p.adminId) await dir.remove(p.adminId);
      if (p.inviteId) await dir.deleteInvite(p.inviteId);
    },
  });

  const setRole = defineAction({
    id: 'admins.set-role',
    title: 'Change an admin’s role',
    description: 'Change what a team member may do, for all relays or for one relay.',
    technical: 'Sets principal.roles[relayId|*]; role "none" removes that scope.',
    scope: 'node',
    permission: 'admins.manage',
    keywords: ['role', 'promote', 'demote', 'permissions'],
    input: z.object({
      id: z.string().describe('The team member'),
      role: z.enum([...ROLES, 'none']).describe('New role ("none" removes access for that scope)'),
      relayId: z.string().optional().describe('Only for this relay (empty = all relays)'),
    }),
    async preview(input) {
      const rec = await dir.get(input.id);
      const name = displayNameOf(rec, input.id);
      const before = rec?.roles[input.relayId ?? '*'] ?? 'none';
      return [
        {
          kind: 'change',
          text: `${name}: ${before} → ${input.role} ${where(kernel, input.relayId)}`,
          technical: `roles[${input.relayId ?? '*'}]: ${before} → ${input.role}`,
        },
      ];
    },
    async run(input) {
      assertRelay(kernel, input.relayId);
      const rec = await dir.get(input.id);
      if (!rec) throw new HttpError(404, 'not_found', 'That person is not on the team');
      if (input.role === 'owner' && input.relayId)
        throw new HttpError(400, 'bad_request', 'Owners always manage all relays');
      const scope = input.relayId ?? '*';
      const roles = { ...rec.roles };
      if (input.role === 'none') delete roles[scope];
      else roles[scope] = input.role;
      await assertNotLastOwner(rec, roles);
      if (Object.keys(roles).length === 0)
        throw new HttpError(400, 'bad_request', 'Use “Remove admin” to take away all access');
      await dir.put({ ...rec, roles });
      const name = displayNameOf(rec, rec.id);
      return {
        output: { id: rec.id, roles },
        summary:
          input.role === 'none'
            ? `Removed ${name}’s access ${where(kernel, input.relayId)}`
            : `Made ${name} ${ROLE_LABEL[input.role]} ${where(kernel, input.relayId)}`,
        undo: {
          actionId: 'admins.set-role',
          payload: { id: rec.id, roles: rec.roles },
          expiresAt: undoAt(),
        },
      };
    },
    async undo(payload) {
      const p = payload as { id: string; roles: AdminRecord['roles'] };
      const rec = await dir.get(p.id);
      if (rec) await dir.put({ ...rec, roles: p.roles });
    },
  });

  const remove = defineAction({
    id: 'admins.remove',
    title: 'Remove an admin',
    description: 'Take away all of someone’s admin access. Their API tokens stop working too.',
    technical:
      'Deletes the admin principal; sessions, tokens and passkeys bound to it no longer authenticate.',
    scope: 'node',
    permission: 'admins.manage',
    keywords: ['team', 'remove', 'revoke access'],
    input: z.object({ id: z.string().describe('The team member') }),
    async preview(input) {
      const rec = await dir.get(input.id);
      return [
        {
          kind: 'remove',
          text: `${displayNameOf(rec, input.id)} will no longer be able to manage the relay`,
          technical: `delete admin ${input.id}`,
        },
      ];
    },
    async run(input) {
      const rec = await dir.get(input.id);
      if (!rec) throw new HttpError(404, 'not_found', 'That person is not on the team');
      await assertNotLastOwner(rec, null);
      await dir.remove(rec.id);
      return {
        output: { id: rec.id },
        summary: `Removed ${displayNameOf(rec, rec.id)} from the team`,
        undo: { actionId: 'admins.remove', payload: { record: rec }, expiresAt: undoAt() },
      };
    },
    async undo(payload) {
      await dir.put((payload as { record: AdminRecord }).record);
    },
  });

  const list = defineAction({
    id: 'admins.list',
    title: 'Show the team',
    description: 'Everyone who can manage this relay and their roles.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['team', 'admins', 'roles'],
    input: z.object({}),
    async run() {
      const admins = (await dir.list()).map((a) => ({
        id: a.id,
        pubkey: a.pubkey,
        displayName: displayNameOf(a, a.id),
        roles: a.roles,
        createdAt: a.createdAt,
      }));
      return { output: { admins }, summary: `Listed ${admins.length} team members` };
    },
  });

  const recoveryCodes = defineAction({
    id: 'admins.recovery-codes',
    title: 'Create new owner recovery codes',
    description:
      'Get a fresh set of one-time codes that let an owner back in if they lose their key. Old codes stop working.',
    technical:
      'Replaces the hashed recovery code set; a code redeemed at login grants the owner role to that principal.',
    scope: 'node',
    permission: 'admins.manage',
    sensitive: true,
    keywords: ['recovery', 'lost key', 'backup codes'],
    input: z.object({}),
    async preview() {
      return [
        { kind: 'warning', text: 'Your current recovery codes will stop working' },
        { kind: 'add', text: '10 new recovery codes will be created — store them somewhere safe' },
      ];
    },
    async run(_input, ctx) {
      const me = await dir.get(ctx.principal.id);
      if (!isOwner(me))
        throw new HttpError(403, 'forbidden', 'Only owners can create recovery codes');
      const codes = await dir.regenerateRecoveryCodes();
      return { output: { codes }, summary: 'Created new owner recovery codes' };
    },
  });

  const tokenCreate = defineAction({
    id: 'tokens.create',
    title: 'Create an API token',
    description: 'A key for scripts and automation. It can only do what you allow, and it expires.',
    technical:
      'Bearer token bh_<id>_<secret>; secret stored as SHA-256; scopes intersect with the creator’s current roles.',
    scope: 'node',
    permission: 'relay.read',
    keywords: ['api', 'token', 'automation', 'key'],
    input: z.object({
      name: z.string().min(1).max(80).describe('What it is for'),
      scopes: z
        .array(z.enum(PERMISSIONS))
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
    async preview(input) {
      return [
        {
          kind: 'add',
          text: `New API token “${input.name}” that expires in ${input.expiresInDays ?? 90} days`,
          technical: `scopes: ${(input.scopes ?? ['(all of yours)']).join(', ')}`,
        },
      ];
    },
    async run(input, ctx) {
      if (ctx.principal.via === 'token')
        throw new HttpError(403, 'forbidden', 'API tokens cannot create other tokens');
      const rec = await dir.get(ctx.principal.id);
      if (!rec) throw new HttpError(403, 'forbidden', 'Only team members can create tokens');
      const maxDays =
        kernel.moduleConfig<{ tokens: { maxDays: number } }>('admin-api')?.tokens.maxDays ?? 365;
      if (input.expiresInDays > maxDays)
        throw new HttpError(400, 'bad_request', `Tokens can last at most ${maxDays} days`);
      const mine = new Set<Permission>();
      for (const scope of Object.keys(rec.roles))
        for (const p of permissionsFor(ctx.principal, scope === '*' ? null : scope)) mine.add(p);
      const scopes = input.scopes ?? [...mine];
      const extra = scopes.filter((s) => !mine.has(s));
      if (extra.length)
        throw new HttpError(
          403,
          'forbidden',
          'A token cannot do more than you can',
          `not permitted: ${extra.join(', ')}`,
        );
      const { token, record } = await tokens.create({
        adminId: rec.id,
        name: input.name,
        scopes,
        expiresAt: kernel.ports.clock.now() + input.expiresInDays * 86400,
      });
      return {
        output: { token, ...record },
        summary: `Created API token “${input.name}”`,
        undo: { actionId: 'tokens.create', payload: { id: record.id }, expiresAt: undoAt() },
      };
    },
    async undo(payload) {
      await tokens.revoke((payload as { id: string }).id);
    },
  });

  const canManageToken = async (ctx: ActionContext, rec: TokenRecord) =>
    rec.adminId === ctx.principal.id || permissionsFor(ctx.principal, null).has('admins.manage');

  const tokenRevoke = defineAction({
    id: 'tokens.revoke',
    title: 'Revoke an API token',
    description: 'The token stops working immediately.',
    scope: 'node',
    permission: 'relay.read',
    keywords: ['api', 'token', 'revoke'],
    input: z.object({ id: z.string().describe('Token id') }),
    async preview(input) {
      const t = await tokens.get(input.id);
      return [{ kind: 'remove', text: `API token “${t?.name ?? input.id}” will stop working` }];
    },
    async run(input, ctx) {
      const t = await tokens.get(input.id);
      if (!t || !(await canManageToken(ctx, t)))
        throw new HttpError(404, 'not_found', 'That token does not exist');
      await tokens.revoke(t.id);
      return {
        output: { id: t.id },
        summary: `Revoked API token “${t.name}”`,
        undo: { actionId: 'tokens.revoke', payload: { record: t }, expiresAt: undoAt() },
      };
    },
    async undo(payload) {
      await tokens.put((payload as { record: TokenRecord }).record);
    },
  });

  const tokenList = defineAction({
    id: 'tokens.list',
    title: 'Show API tokens',
    description: 'Your API tokens (owners see everyone’s).',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({}),
    async run(_input, ctx) {
      const all = permissionsFor(ctx.principal, null).has('admins.manage');
      const owner = ctx.principal.via === 'token' ? undefined : ctx.principal.id;
      const items = await tokens.list(all ? undefined : (owner ?? '\u0000'));
      return { output: { tokens: items }, summary: `Listed ${items.length} API tokens` };
    },
  });

  const subject = z.object({
    type: z.enum(['user', 'event', 'blob']).describe('What the note is about'),
    id: z.string().min(1).max(200).describe('Pubkey, event id or file hash'),
  });

  const SUBJECT_LABEL = { user: 'user', event: 'post', blob: 'file' } as const;

  const notesAdd = defineAction({
    id: 'notes.add',
    title: 'Add an internal note',
    description:
      'Leave a note for the admin team about a user, post or file. Only admins can see it.',
    scope: 'relay',
    permission: 'moderation.write',
    keywords: ['note', 'comment', 'team'],
    input: z.object({ subject, text: z.string().min(1).max(4000).describe('The note') }),
    async preview(input) {
      return [
        {
          kind: 'add',
          text: `Note on ${SUBJECT_LABEL[input.subject.type]} ${input.subject.id.slice(0, 12)}…`,
        },
      ];
    },
    async run(input, ctx) {
      const at = kernel.ports.clock.now();
      const note: Note = {
        id: `${seqKey(at)}-${kernel.ports.crypto.randomHex(4)}`,
        relayId: ctx.relayId!,
        subject: input.subject,
        text: input.text,
        author: ctx.principal.id,
        authorName: ctx.principal.displayName ?? (await nameOf(ctx.principal.id)),
        at,
      };
      const key = `${note.relayId}|${note.subject.type}|${note.subject.id}|${note.id}`;
      await kernel.ports.docs.put(COL.notes, key, note);
      return {
        output: { note },
        summary: `Added a note on ${SUBJECT_LABEL[input.subject.type]} ${input.subject.id.slice(0, 12)}…`,
        undo: { actionId: 'notes.add', payload: { key }, expiresAt: undoAt() },
      };
    },
    async undo(payload) {
      await kernel.ports.docs.delete(COL.notes, (payload as { key: string }).key);
    },
  });

  const notesList = defineAction({
    id: 'notes.list',
    title: 'Show internal notes',
    description: 'Notes the admin team left about a user, post or file.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({
      subject: subject.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    async run(input, ctx) {
      const prefix = input.subject
        ? `${ctx.relayId}|${input.subject.type}|${input.subject.id}|`
        : `${ctx.relayId}|`;
      const page = await kernel.ports.docs.list<Note>(COL.notes, { prefix, limit: input.limit });
      const notes = page.items.map((i) => i.value).sort((a, b) => b.at - a.at);
      return { output: { notes }, summary: `Listed ${notes.length} notes` };
    },
  });

  return [
    invite,
    setRole,
    remove,
    list,
    recoveryCodes,
    tokenCreate,
    tokenRevoke,
    tokenList,
    notesAdd,
    notesList,
  ] as unknown as ActionDef[];
}
