// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin actions (§6.13) for NIP-29 groups ("channels" in the team client). */
import {
  type ActionContext,
  type ActionDef,
  type DiffLine,
  type RelayId,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { GROUP_ID_RE, type GroupRecord, type GroupRole, type GroupsService } from './groups.ts';

const UNDO_SECONDS = 300;
const HEX64 = /^[0-9a-f]{64}$/;

const Pubkey = z.string().regex(HEX64, 'expected a 64-character hex public key');
const GroupId = z
  .string()
  .regex(GROUP_ID_RE, 'group ids may only use letters, digits, "-" and "_" (max 64)');
const Role = z.enum(['admin', 'moderator']);

function needRelay(ctx: ActionContext): RelayId {
  if (!ctx.relayId) throw new Error('choose a relay first');
  return ctx.relayId;
}

function short(pk: string): string {
  return `${pk.slice(0, 8)}…`;
}

function roleText(roles: GroupRole[] | undefined): string {
  if (!roles || roles.length === 0) return 'member';
  return roles.join(' + ');
}

async function needGroup(svc: GroupsService, relayId: RelayId, id: string): Promise<GroupRecord> {
  const g = await svc.get(relayId, id);
  if (!g) throw new Error(`there is no group "${id}"`);
  return g;
}

export function createGroupActions(svc: GroupsService): ActionDef[] {
  const undoToken = (ctx: ActionContext, actionId: string, payload: unknown) => ({
    actionId,
    payload,
    expiresAt: ctx.ports.clock.now() + UNDO_SECONDS,
  });

  const list = defineAction({
    id: 'groups.list',
    title: 'Groups',
    description: 'Group chats on this relay and who is in them.',
    technical: 'NIP-29 groups (relay.groups DocStore collection).',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['groups', 'channels'],
    input: z.object({}),
    async run(_input, ctx) {
      const groups = await svc.list(needRelay(ctx));
      return {
        output: groups.map((g) => ({
          id: g.id,
          name: g.name,
          private: g.private,
          closed: g.closed,
          members: Object.keys(g.members).length,
        })),
        summary: `${groups.length} group${groups.length === 1 ? '' : 's'}`,
      };
    },
  });

  const create = defineAction({
    id: 'groups.create',
    title: 'Create group',
    description: 'Start a new group chat on this relay.',
    technical:
      'Creates a NIP-29 group and publishes relay-signed kinds 39000 (metadata), 39001 (admins), 39002 (members), 39003 (roles).',
    scope: 'relay',
    permission: 'config.write',
    keywords: ['group', 'channel', 'new'],
    input: z.object({
      id: GroupId.optional(),
      name: z.string().min(1).max(200),
      about: z.string().max(2000).optional(),
      picture: z.string().url().optional(),
      private: z.boolean().default(false).describe('Only members can read'),
      closed: z.boolean().default(false).describe('Only members can post; joining needs approval'),
      members: z
        .array(z.object({ pubkey: Pubkey, roles: z.array(Role).optional() }))
        .max(10_000)
        .default([]),
    }),
    async preview(input) {
      const lines: DiffLine[] = [
        {
          kind: 'add',
          text: `New group "${input.name}"${input.private ? ', only members can read' : ''}${
            input.closed ? ', only members can post' : ''
          }`,
          technical: `kind 39000 d=${input.id ?? '<random>'} ${input.private ? 'private' : 'public'} ${
            input.closed ? 'closed' : 'open'
          }`,
        },
      ];
      if (input.members.length > 0)
        lines.push({ kind: 'add', text: `${input.members.length} people will be added` });
      return lines;
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const g = await svc.create(relayId, {
        ...(input.id !== undefined ? { id: input.id } : {}),
        name: input.name,
        ...(input.about !== undefined ? { about: input.about } : {}),
        ...(input.picture !== undefined ? { picture: input.picture } : {}),
        private: input.private,
        closed: input.closed,
        members: input.members.map((m) =>
          m.roles ? { pubkey: m.pubkey, roles: m.roles } : { pubkey: m.pubkey },
        ),
      });
      return {
        output: g,
        summary: `Created group "${g.name}"`,
        undo: undoToken(ctx, 'groups.create', { id: g.id }),
      };
    },
    async undo(payload, ctx) {
      await svc.delete(needRelay(ctx), (payload as { id: string }).id);
    },
  });

  const addMember = defineAction({
    id: 'groups.add-member',
    title: 'Add to group',
    description: 'Let people read and post in a group.',
    technical: 'Equivalent of NIP-29 kind 9000 put-user; republishes kinds 39001/39002.',
    scope: 'relay',
    permission: 'users.write',
    bulk: true,
    keywords: ['invite', 'member', 'group'],
    input: z.object({
      group: GroupId,
      pubkeys: z.array(Pubkey).min(1).max(10_000),
      roles: z.array(Role).optional(),
    }),
    async preview(input, ctx) {
      const g = await needGroup(svc, needRelay(ctx), input.group);
      return input.pubkeys.map((pk) =>
        g.members[pk] !== undefined && !input.roles
          ? { kind: 'info' as const, text: `${short(pk)} is already in "${g.name}"` }
          : {
              kind: 'add' as const,
              text: `${short(pk)} will join "${g.name}" as ${roleText(input.roles)}`,
              technical: `kind 39002 p=${pk}`,
            },
      );
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const before = await needGroup(svc, relayId, input.group);
      const prev = input.pubkeys.map((pk) => ({ pubkey: pk, roles: before.members[pk] ?? null }));
      const g = await svc.addMembers(
        relayId,
        input.group,
        input.pubkeys.map((pk) =>
          input.roles ? { pubkey: pk, roles: input.roles } : { pubkey: pk },
        ),
      );
      return {
        output: { group: g.id, members: Object.keys(g.members).length },
        summary: `Added ${input.pubkeys.length} to "${g.name}"`,
        undo: undoToken(ctx, 'groups.add-member', { group: g.id, prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      const p = payload as {
        group: string;
        prev: Array<{ pubkey: string; roles: GroupRole[] | null }>;
      };
      const remove = p.prev.filter((x) => x.roles === null).map((x) => x.pubkey);
      const restore = p.prev
        .filter((x): x is { pubkey: string; roles: GroupRole[] } => x.roles !== null)
        .map((x) => ({ pubkey: x.pubkey, roles: x.roles }));
      if (remove.length > 0) await svc.removeMembers(relayId, p.group, remove);
      if (restore.length > 0) await svc.addMembers(relayId, p.group, restore);
    },
  });

  const removeMember = defineAction({
    id: 'groups.remove-member',
    title: 'Remove from group',
    description: 'Take people out of a group.',
    technical: 'Equivalent of NIP-29 kind 9001 remove-user; republishes kinds 39001/39002.',
    scope: 'relay',
    permission: 'users.write',
    bulk: true,
    keywords: ['kick', 'member', 'group'],
    input: z.object({ group: GroupId, pubkeys: z.array(Pubkey).min(1).max(10_000) }),
    async preview(input, ctx) {
      const g = await needGroup(svc, needRelay(ctx), input.group);
      return input.pubkeys.map((pk) =>
        g.members[pk] === undefined
          ? { kind: 'info' as const, text: `${short(pk)} is not in "${g.name}"` }
          : {
              kind: 'remove' as const,
              text: `${short(pk)} will leave "${g.name}"`,
              technical: `kind 39002 -p=${pk}`,
            },
      );
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const before = await needGroup(svc, relayId, input.group);
      const prev = input.pubkeys
        .filter((pk) => before.members[pk] !== undefined)
        .map((pk) => ({ pubkey: pk, roles: before.members[pk] as GroupRole[] }));
      const g = await svc.removeMembers(relayId, input.group, input.pubkeys);
      return {
        output: { group: g.id, members: Object.keys(g.members).length },
        summary: `Removed ${prev.length} from "${g.name}"`,
        undo: undoToken(ctx, 'groups.remove-member', { group: g.id, prev }),
      };
    },
    async undo(payload, ctx) {
      const p = payload as { group: string; prev: Array<{ pubkey: string; roles: GroupRole[] }> };
      if (p.prev.length > 0) await svc.addMembers(needRelay(ctx), p.group, p.prev);
    },
  });

  const setRole = defineAction({
    id: 'groups.set-role',
    title: 'Change group role',
    description: 'Make someone a group admin or moderator, or a regular member again.',
    technical: 'Sets NIP-29 roles; republishes kind 39001 (admins) and 39002.',
    scope: 'relay',
    permission: 'users.write',
    keywords: ['admin', 'moderator', 'role', 'group'],
    input: z.object({ group: GroupId, pubkey: Pubkey, roles: z.array(Role) }),
    async preview(input, ctx) {
      const g = await needGroup(svc, needRelay(ctx), input.group);
      return [
        {
          kind: 'change',
          text: `${short(input.pubkey)} in "${g.name}": ${
            g.members[input.pubkey] === undefined
              ? 'not a member'
              : roleText(g.members[input.pubkey])
          } → ${roleText(input.roles)}`,
          technical: `kind 39001 p=${input.pubkey} roles=[${input.roles.join(',')}]`,
        },
      ];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const before = await needGroup(svc, relayId, input.group);
      const prev = before.members[input.pubkey] ?? null;
      const g = await svc.setRoles(relayId, input.group, input.pubkey, input.roles);
      return {
        output: { group: g.id, pubkey: input.pubkey, roles: g.members[input.pubkey] ?? [] },
        summary: `${short(input.pubkey)} is now ${roleText(input.roles)} in "${g.name}"`,
        undo: undoToken(ctx, 'groups.set-role', { group: g.id, pubkey: input.pubkey, prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      const p = payload as { group: string; pubkey: string; prev: GroupRole[] | null };
      if (p.prev === null) await svc.removeMembers(relayId, p.group, [p.pubkey]);
      else await svc.setRoles(relayId, p.group, p.pubkey, p.prev);
    },
  });

  const del = defineAction({
    id: 'groups.delete',
    title: 'Delete group',
    description: 'Delete a group and everything posted in it. This cannot be undone.',
    technical:
      'Removes the NIP-29 group state, its relay-signed 39000–39003 events and all events tagged with its h tag.',
    scope: 'relay',
    permission: 'config.write',
    sensitive: true,
    keywords: ['remove', 'group', 'channel'],
    input: z.object({ group: GroupId }),
    async preview(input, ctx) {
      const relayId = needRelay(ctx);
      const g = await needGroup(svc, relayId, input.group);
      const posts = await ctx.ports.events.count(relayId, [{ '#h': [g.id] }]);
      return [
        {
          kind: 'remove',
          text: `Group "${g.name}" with ${Object.keys(g.members).length} members will be deleted`,
          technical: `relay.groups/${relayId}/${g.id}`,
        },
        { kind: 'warning', text: `${posts} posts in this group will be deleted for good` },
      ];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const g = await needGroup(svc, relayId, input.group);
      const { removed } = await svc.delete(relayId, g.id);
      return {
        output: { group: g.id, removed },
        summary: `Deleted group "${g.name}"`,
      };
    },
  });

  return [list, create, addMember, removeMember, setRole, del] as unknown as ActionDef[];
}
