// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defineAction, defineModule } from '@beamhop/core';
import { z } from 'zod';
import { NODE, RELAY, addMember, bootClaimed, call, makeKey } from './helpers.ts';

describe('RBAC', () => {
  test('unauthenticated, wrong role, wrong relay and token scopes are denied', async () => {
    const env = await bootClaimed();
    const viewer = await addMember(env, 'viewer');
    const teamMod = await addMember(env, 'moderator', 'team');
    const pk = makeKey().pk;

    expect((await call(env.kernel, 'GET', `${NODE}/actions`)).status).toBe(401);
    expect((await call(env.kernel, 'GET', `${NODE}/health`)).status).toBe(401);

    // Viewer can read but not moderate or manage admins.
    expect(
      (await call(env.kernel, 'GET', `${RELAY('main')}/health`, { token: viewer.token })).status,
    ).toBe(200);
    const ban = await call(env.kernel, 'POST', `${RELAY('main')}/actions/moderation.ban-pubkey`, {
      token: viewer.token,
      body: { input: { pubkey: pk } },
    });
    expect(ban.status).toBe(403);
    expect(ban.json.error.message).toContain('Ban a user');
    expect(ban.json.error.technical).toBe('requires moderation.write');
    const inv = await call(env.kernel, 'POST', `${NODE}/actions/admins.invite`, {
      token: viewer.token,
      body: { input: { pubkey: makeKey().pk, role: 'admin' } },
    });
    expect(inv.status).toBe(403);
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/config/propose`, {
          token: viewer.token,
          body: { merge: {} },
        })
      ).status,
    ).toBe(403);

    // Relay-scoped moderator: allowed on team, denied on main and node-level.
    const onTeam = await call(
      env.kernel,
      'POST',
      `${RELAY('team')}/actions/moderation.ban-pubkey`,
      {
        token: teamMod.token,
        body: { input: { pubkey: pk } },
      },
    );
    expect(onTeam.status).toBe(200);
    const onMain = await call(
      env.kernel,
      'POST',
      `${RELAY('main')}/actions/moderation.ban-pubkey`,
      {
        token: teamMod.token,
        body: { input: { pubkey: pk } },
      },
    );
    expect(onMain.status).toBe(403);
    expect((await call(env.kernel, 'GET', `${NODE}/health`, { token: teamMod.token })).status).toBe(
      403,
    );
    expect(env.banned.get('team')?.has(pk)).toBe(true);
    expect(env.banned.get('main')?.has(pk)).toBeFalsy();

    // Catalog marks what the caller may do.
    const cat = await call(env.kernel, 'GET', `${RELAY('team')}/actions`, { token: teamMod.token });
    const ban2 = cat.json.actions.find((a: { id: string }) => a.id === 'moderation.ban-pubkey');
    expect(ban2.allowed).toBe(true);
    const catMain = await call(env.kernel, 'GET', `${RELAY('main')}/actions`, {
      token: teamMod.token,
    });
    expect(
      catMain.json.actions.find((a: { id: string }) => a.id === 'moderation.ban-pubkey').allowed,
    ).toBe(false);
  });

  test('node-scoped anyRelay read actions are open to relay-scoped admins', async () => {
    const nodeReads = defineModule({
      id: 'node-reads',
      register(k) {
        const mk = (id: string, anyRelay: boolean) =>
          defineAction({
            id,
            title: `Read ${id}`,
            description: 'test',
            technical: 'test action',
            scope: 'node',
            permission: 'relay.read',
            readOnly: true,
            ...(anyRelay ? { anyRelay } : {}),
            input: z.object({}),
            async run(_i, ctx) {
              return { output: { who: ctx.principal.id }, summary: 'ok' };
            },
          });
        k.actions.register(mk('test.filtered-read', true));
        k.actions.register(mk('test.node-read', false));
      },
    });
    const env = await bootClaimed([nodeReads]);
    const teamMod = await addMember(env, 'moderator', 'team');
    const run = (id: string) =>
      call(env.kernel, 'POST', `${NODE}/actions/${id}`, { token: teamMod.token, body: {} });
    expect((await run('test.filtered-read')).status).toBe(200);
    expect((await run('test.node-read')).status).toBe(403);
    const cat = await call(env.kernel, 'GET', `${NODE}/actions`, { token: teamMod.token });
    const allowed = (id: string) =>
      cat.json.actions.find((a: { id: string }) => a.id === id)?.allowed;
    expect(allowed('test.filtered-read')).toBe(true);
    expect(allowed('test.node-read')).toBe(false);
  });

  test('admins.set-role / admins.remove with undo and last-owner protection', async () => {
    const env = await bootClaimed();
    const admin = await addMember(env, 'admin', undefined, 'Bob');
    const run = (id: string, input: unknown, token = env.ownerToken) =>
      call(env.kernel, 'POST', `${NODE}/actions/${id}`, { token, body: { input } });

    const pv = await call(env.kernel, 'POST', `${NODE}/actions/admins.set-role/preview`, {
      token: env.ownerToken,
      body: { input: { id: admin.key.pk, role: 'viewer' } },
    });
    expect(pv.json.diff[0].text).toBe('Bob: admin → viewer on all relays');

    const demote = await run('admins.set-role', { id: admin.key.pk, role: 'viewer' });
    expect(demote.status).toBe(200);
    expect(demote.json.summary).toBe('Made Bob a viewer on all relays');
    // Role changes apply to existing sessions immediately.
    const me = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: admin.token });
    expect(me.json.roles).toEqual({ '*': 'viewer' });
    // Undo restores.
    const u = await call(env.kernel, 'POST', `${NODE}/undo/${demote.json.undo.token}`, {
      token: env.ownerToken,
    });
    expect(u.status).toBe(200);
    expect(
      (await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: admin.token })).json.roles,
    ).toEqual({ '*': 'admin' });
    // Undo tokens are one-time.
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/undo/${demote.json.undo.token}`, {
          token: env.ownerToken,
        })
      ).status,
    ).toBe(410);

    // Last owner cannot be demoted or removed.
    const self = await run('admins.set-role', { id: env.owner.pk, role: 'admin' });
    expect(self.status).toBe(409);
    expect(self.json.error.code).toBe('last_owner');
    expect((await run('admins.remove', { id: env.owner.pk })).status).toBe(409);

    // Remove kills the session; undo brings it back.
    const rm = await run('admins.remove', { id: admin.key.pk });
    expect(rm.status).toBe(200);
    expect((await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: admin.token })).status).toBe(
      401,
    );
    await call(env.kernel, 'POST', `${NODE}/undo/${rm.json.undo.token}`, { token: env.ownerToken });
    expect((await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: admin.token })).status).toBe(
      200,
    );

    const list = await run('admins.list', {});
    expect(list.json.output.admins).toHaveLength(2);
    // Owners must be node-wide.
    expect(
      (await run('admins.invite', { pubkey: makeKey().pk, role: 'owner', relayId: 'main' })).status,
    ).toBe(400);
    expect((await run('admins.invite', { pubkey: 'not-a-key', role: 'admin' })).status).toBe(400);
  });
});

describe('generated action endpoints', () => {
  test('catalog has titles, technical text and JSON Schema', async () => {
    const env = await bootClaimed();
    const r = await call(env.kernel, 'GET', `${NODE}/actions`, { token: env.ownerToken });
    expect(r.status).toBe(200);
    const ban = r.json.actions.find((a: { id: string }) => a.id === 'moderation.ban-pubkey');
    expect(ban).toMatchObject({
      title: 'Ban a user',
      technical: 'NIP-86 banpubkey',
      scope: 'relay',
      bulk: true,
      undoable: true,
      allowed: true, // node-wide owner
      cli: 'beamhop moderation ban-pubkey',
    });
    expect(ban.inputSchema.type).toBe('object');
    expect(ban.inputSchema.properties.pubkey.pattern).toBe('^[0-9a-f]{64}$');
    const ids = r.json.actions.map((a: { id: string }) => a.id);
    for (const id of [
      'admins.invite',
      'admins.set-role',
      'admins.remove',
      'notes.add',
      'notes.list',
    ])
      expect(ids).toContain(id);
    const relayCat = await call(env.kernel, 'GET', `${RELAY()}/actions`, { token: env.ownerToken });
    expect(relayCat.json.actions.every((a: { scope: string }) => a.scope === 'relay')).toBe(true);
  });

  test('preview, run, undo, validation and scope errors', async () => {
    const env = await bootClaimed();
    const pk = makeKey().pk;
    const url = `${RELAY()}/actions/moderation.ban-pubkey`;
    const pv = await call(env.kernel, 'POST', `${url}/preview`, {
      token: env.ownerToken,
      body: { input: { pubkey: pk } },
    });
    expect(pv.json.diff).toEqual([{ kind: 'add', text: `${pk.slice(0, 8)} will be banned` }]);
    expect(env.banned.get('main')?.has(pk)).toBeFalsy();

    const bad = await call(env.kernel, 'POST', url, {
      token: env.ownerToken,
      body: { input: { pubkey: 'zz' } },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.issues[0].path).toBe('pubkey');

    const run = await call(env.kernel, 'POST', url, {
      token: env.ownerToken,
      body: { input: { pubkey: pk }, reason: 'spam' },
    });
    expect(run.status).toBe(200);
    expect(run.json.summary).toBe(`Banned ${pk.slice(0, 8)}`);
    expect(env.banned.get('main')?.has(pk)).toBe(true);
    const undo = await call(env.kernel, 'POST', `${NODE}/undo/${run.json.undo.token}`, {
      token: env.ownerToken,
    });
    expect(undo.json.undone).toBe(`Banned ${pk.slice(0, 8)}`);
    expect(env.banned.get('main')?.has(pk)).toBe(false);

    // Undo window expires.
    const run2 = await call(env.kernel, 'POST', url, {
      token: env.ownerToken,
      body: { input: { pubkey: pk } },
    });
    env.ports.clock.advance(301);
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/undo/${run2.json.undo.token}`, {
          token: env.ownerToken,
        })
      ).status,
    ).toBe(410);

    // Wrong scope / unknown
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/actions/moderation.ban-pubkey`, {
          token: env.ownerToken,
          body: { input: { pubkey: pk } },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(env.kernel, 'POST', `${RELAY()}/actions/admins.list`, {
          token: env.ownerToken,
          body: { input: {} },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/actions/nope.nope`, {
          token: env.ownerToken,
          body: {},
        })
      ).status,
    ).toBe(404);

    // Failing actions are reported and audited as failures.
    const boom = await call(env.kernel, 'POST', `${NODE}/actions/test.explode`, {
      token: env.ownerToken,
      body: { input: {} },
    });
    expect(boom.status).toBe(422);
    expect(boom.json.error.message).toBe('This never works');
    const act = await call(env.kernel, 'GET', `${NODE}/activity`, { token: env.ownerToken });
    expect(act.json.items[0].ok).toBe(false);
    expect(act.json.items[0].text).toBe('Ayşe tried to explode, but it failed');
  });

  test('bulk run with a single undo', async () => {
    const env = await bootClaimed();
    const keys = [makeKey().pk, makeKey().pk, makeKey().pk];
    const r = await call(env.kernel, 'POST', `${RELAY()}/actions/moderation.ban-pubkey/bulk`, {
      token: env.ownerToken,
      body: { inputs: [...keys.map((pubkey) => ({ pubkey })), { pubkey: 'bad' }] },
    });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, true, false]);
    expect(r.json.summary).toBe('Ban a user: 3 done, 1 failed');
    expect(env.banned.get('main')?.size).toBe(3);
    const u = await call(env.kernel, 'POST', `${RELAY()}/undo/${r.json.undo.token}`, {
      token: env.ownerToken,
    });
    expect(u.status).toBe(200);
    expect(env.banned.get('main')?.size).toBe(0);
    // Non-bulk actions refuse bulk.
    const nb = await call(env.kernel, 'POST', `${RELAY()}/actions/notes.add/bulk`, {
      token: env.ownerToken,
      body: { inputs: [{}] },
    });
    expect(nb.status).toBe(400);
  });

  test('internal notes are relay-scoped and undoable', async () => {
    const env = await bootClaimed();
    const pk = makeKey().pk;
    const add = await call(env.kernel, 'POST', `${RELAY()}/actions/notes.add`, {
      token: env.ownerToken,
      body: { input: { subject: { type: 'user', id: pk }, text: 'Known spammer from last week' } },
    });
    expect(add.status).toBe(200);
    await call(env.kernel, 'POST', `${RELAY('team')}/actions/notes.add`, {
      token: env.ownerToken,
      body: { input: { subject: { type: 'user', id: pk }, text: 'other relay' } },
    });
    const list = await call(env.kernel, 'POST', `${RELAY()}/actions/notes.list`, {
      token: env.ownerToken,
      body: { input: { subject: { type: 'user', id: pk } } },
    });
    expect(list.json.output.notes).toHaveLength(1);
    expect(list.json.output.notes[0]).toMatchObject({
      text: 'Known spammer from last week',
      authorName: 'Ayşe',
    });
    await call(env.kernel, 'POST', `${NODE}/undo/${add.json.undo.token}`, {
      token: env.ownerToken,
    });
    const after = await call(env.kernel, 'POST', `${RELAY()}/actions/notes.list`, {
      token: env.ownerToken,
      body: { input: {} },
    });
    expect(after.json.output.notes).toHaveLength(0);
  });

  test('OpenAPI document includes static routes and generated actions', async () => {
    const env = await bootClaimed();
    const r = await call(env.kernel, 'GET', 'http://localhost/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe('3.1.0');
    const paths = Object.keys(r.json.paths);
    expect(paths).toContain('/nodes/{node}/config/propose');
    expect(paths).toContain('/nodes/{node}/relays/{relay}/config/propose');
    expect(paths).toContain('/nodes/{node}/auth/nostr');
    expect(paths).toContain('/nodes/{node}/relays/{relay}/actions/moderation.ban-pubkey');
    expect(paths).toContain('/nodes/{node}/relays/{relay}/actions/moderation.ban-pubkey/bulk');
    expect(paths).toContain('/nodes/{node}/actions/admins.invite/preview');
    const run = r.json.paths['/nodes/{node}/actions/admins.invite'].post;
    expect(run.summary).toBe('Invite an admin');
    expect(run['x-permission']).toBe('admins.manage');
    expect(
      run.requestBody.content['application/json'].schema.properties.input.properties.role.enum,
    ).toContain('moderator');
    expect(r.json.components.securitySchemes.nip98).toBeDefined();
  });
});
