// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type ActionContext, type NostrEvent, type Principal, verifyEvent } from '@beamhop/core';
import { type TestKey, makeKey } from '@beamhop/testkit';
import {
  GROUPS_KEY_COLLECTION,
  GROUPS_SERVICE,
  type GroupsService,
  type relayInfo,
} from '../src/index.ts';
import { type FakeConn, type Harness, eventsOf, setup } from './helpers.ts';

const G = 'team';

function groups(h: Harness): GroupsService {
  return h.kernel.use<GroupsService>(GROUPS_SERVICE)!;
}

async function stateEvents(h: Harness, kind: number, id = G): Promise<NostrEvent[]> {
  return h.ports.events.query('main', [{ kinds: [kind], '#d': [id] }]);
}

function pTags(e: NostrEvent | undefined): string[][] {
  return (e?.tags ?? []).filter((t) => t[0] === 'p');
}

async function createGroup(h: Harness, c: FakeConn, admin: TestKey, extra: string[][] = []) {
  const ok = await h.publish(c, h.event(admin, { kind: 9007, tags: [['h', G], ...extra] }));
  expect(ok[2]).toBe(true);
}

function adminCtx(h: Harness): ActionContext {
  const principal: Principal = { id: 'token:test', roles: { '*': 'owner' }, via: 'token' };
  return { principal, relayId: 'main', ports: h.ports };
}

describe('NIP-29 groups: lifecycle via Nostr events', () => {
  test('create-group publishes relay-signed 39000–39003 and makes the creator admin', async () => {
    const h = await setup();
    const alice = makeKey();
    const c = await h.connect();
    await createGroup(h, c, alice, [
      ['name', 'Team'],
      ['about', 'hello'],
    ]);

    const relayPk = await groups(h).relayPubkey('main');
    const stored = await h.ports.docs.get<{ pubkey: string }>(GROUPS_KEY_COLLECTION, 'main');
    expect(stored?.pubkey).toBe(relayPk);

    const [meta] = await stateEvents(h, 39000);
    expect(meta?.pubkey).toBe(relayPk);
    expect(verifyEvent(meta!)).toBe(true);
    expect(meta?.tags).toEqual([
      ['d', G],
      ['name', 'Team'],
      ['about', 'hello'],
      ['public'],
      ['open'],
    ]);
    expect(pTags((await stateEvents(h, 39001))[0])).toEqual([['p', alice.pk, 'admin']]);
    expect(pTags((await stateEvents(h, 39002))[0])).toEqual([['p', alice.pk]]);
    expect((await stateEvents(h, 39003))[0]?.tags.filter((t) => t[0] === 'role')).toHaveLength(2);

    // Duplicate create is refused.
    const dup = await h.publish(c, h.event(alice, { kind: 9007, tags: [['h', G]] }));
    expect(dup[2]).toBe(false);
    expect(String(dup[3])).toMatch(/^duplicate: /);
  });

  test('users cannot forge group state or post to unknown groups', async () => {
    const h = await setup();
    const k = makeKey();
    const c = await h.connect();
    const forged = await h.publish(c, h.event(k, { kind: 39000, tags: [['d', G]] }));
    expect(String(forged[3])).toMatch(/^restricted: /);
    const unknown = await h.publish(c, h.event(k, { kind: 9, tags: [['h', 'nope']] }));
    expect(unknown[2]).toBe(false);
    const noH = await h.publish(c, h.event(k, { kind: 9021 }));
    expect(String(noH[3])).toMatch(/^invalid: /);
  });

  test('open group: anyone may post (previous tags are accepted leniently)', async () => {
    const h = await setup();
    const alice = makeKey();
    const bob = makeKey();
    const c = await h.connect();
    await createGroup(h, c, alice);
    const post = h.event(bob, {
      kind: 9,
      tags: [
        ['h', G],
        ['previous', 'deadbeef'],
      ],
    });
    expect((await h.publish(c, post))[2]).toBe(true);
  });

  test('closed group: only members post; join needs an invite or admin approval', async () => {
    const h = await setup();
    const alice = makeKey();
    const bob = makeKey();
    const carol = makeKey();
    const c = await h.connect();
    await createGroup(h, c, alice);

    // A non-admin cannot change the group.
    const notAdmin = await h.publish(c, h.event(bob, { kind: 9002, tags: [['h', G], ['closed']] }));
    expect(String(notAdmin[3])).toMatch(/^restricted: /);
    expect(
      (await h.publish(c, h.event(alice, { kind: 9002, tags: [['h', G], ['closed']] })))[2],
    ).toBe(true);
    expect((await stateEvents(h, 39000))[0]?.tags).toContainEqual(['closed']);

    const denied = await h.publish(c, h.event(bob, { kind: 9, tags: [['h', G]] }));
    expect(String(denied[3])).toMatch(/^restricted: /);

    // Join without code: stored, pending.
    expect((await h.publish(c, h.event(bob, { kind: 9021, tags: [['h', G]] })))[2]).toBe(true);
    expect(await groups(h).isMember('main', G, bob.pk)).toBe(false);

    // Invite code from an admin admits.
    await h.publish(
      c,
      h.event(alice, {
        kind: 9009,
        tags: [
          ['h', G],
          ['code', 'xyz'],
        ],
      }),
    );
    const join = h.event(bob, {
      kind: 9021,
      tags: [
        ['h', G],
        ['code', 'xyz'],
      ],
      content: 'hi',
    });
    expect((await h.publish(c, join))[2]).toBe(true);
    expect(await groups(h).isMember('main', G, bob.pk)).toBe(true);
    expect(pTags((await stateEvents(h, 39002))[0]).map((t) => t[1])).toContain(bob.pk);
    const again = await h.publish(c, h.event(bob, { kind: 9021, tags: [['h', G]], content: 'x' }));
    expect(String(again[3])).toMatch(/^duplicate: /);
    expect((await h.publish(c, h.event(bob, { kind: 9, tags: [['h', G]] })))[2]).toBe(true);

    // put-user by admin.
    await h.publish(
      c,
      h.event(alice, {
        kind: 9000,
        tags: [
          ['h', G],
          ['p', carol.pk],
        ],
      }),
    );
    expect((await h.publish(c, h.event(carol, { kind: 9, tags: [['h', G]] })))[2]).toBe(true);

    // A plain member cannot add people or give roles.
    const sneaky = await h.publish(
      c,
      h.event(bob, {
        kind: 9000,
        tags: [
          ['h', G],
          ['p', makeKey().pk, 'admin'],
        ],
      }),
    );
    expect(String(sneaky[3])).toMatch(/^restricted: /);

    // remove-user and leave.
    await h.publish(
      c,
      h.event(alice, {
        kind: 9001,
        tags: [
          ['h', G],
          ['p', carol.pk],
        ],
      }),
    );
    expect(await groups(h).isMember('main', G, carol.pk)).toBe(false);
    expect((await h.publish(c, h.event(bob, { kind: 9022, tags: [['h', G]] })))[2]).toBe(true);
    expect(await groups(h).isMember('main', G, bob.pk)).toBe(false);
    expect(pTags((await stateEvents(h, 39002))[0])).toEqual([['p', alice.pk]]);
  });

  test('moderators can add members and delete posts, but not touch admins', async () => {
    const h = await setup();
    const alice = makeKey();
    const mod = makeKey();
    const c = await h.connect();
    await createGroup(h, c, alice);
    await h.publish(
      c,
      h.event(alice, {
        kind: 9000,
        tags: [
          ['h', G],
          ['p', mod.pk, 'moderator'],
        ],
      }),
    );
    expect(pTags((await stateEvents(h, 39001))[0])).toContainEqual(['p', mod.pk, 'moderator']);

    const post = h.event(makeKey(), { kind: 9, tags: [['h', G]] });
    await h.publish(c, post);
    const outside = h.event(makeKey(), { kind: 1 });
    await h.publish(c, outside);
    const deleted = h.record('event.deleted');
    const del = h.event(mod, {
      kind: 9005,
      tags: [
        ['h', G],
        ['e', post.id],
        ['e', outside.id],
      ],
    });
    expect((await h.publish(c, del))[2]).toBe(true);
    expect(await h.ports.events.getById('main', post.id)).toBeNull();
    // Events outside the group are untouched.
    expect(await h.ports.events.getById('main', outside.id)).not.toBeNull();
    expect(deleted.at(-1)).toEqual({ relayId: 'main', ids: [post.id], cause: 'admin' });

    const kick = await h.publish(
      c,
      h.event(mod, {
        kind: 9001,
        tags: [
          ['h', G],
          ['p', alice.pk],
        ],
      }),
    );
    expect(String(kick[3])).toMatch(/^restricted: /);
    const meta = await h.publish(
      c,
      h.event(mod, {
        kind: 9002,
        tags: [
          ['h', G],
          ['name', 'x'],
        ],
      }),
    );
    expect(String(meta[3])).toMatch(/^restricted: /);
  });

  test('delete-group removes the group, its state and its posts', async () => {
    const h = await setup();
    const alice = makeKey();
    const c = await h.connect();
    await createGroup(h, c, alice);
    const post = h.event(makeKey(), { kind: 9, tags: [['h', G]] });
    await h.publish(c, post);
    const deleted = h.record('event.deleted');
    expect((await h.publish(c, h.event(alice, { kind: 9008, tags: [['h', G]] })))[2]).toBe(true);
    expect(await groups(h).get('main', G)).toBeNull();
    expect(await h.ports.events.getById('main', post.id)).toBeNull();
    expect(await stateEvents(h, 39000)).toEqual([]);
    expect(deleted.at(-1)?.count).toBeGreaterThan(0);
  });

  test('whoCanCreate=owner limits group creation to the relay owner', async () => {
    const owner = makeKey();
    const h = await setup({
      relay: { info: { name: 'r', description: '', pubkey: owner.pk } },
      relayModule: { groups: { whoCanCreate: 'owner' } },
    });
    const c = await h.connect();
    const denied = await h.publish(c, h.event(makeKey(), { kind: 9007, tags: [['h', G]] }));
    expect(String(denied[3])).toMatch(/^restricted: /);
    await createGroup(h, c, owner);
  });
});

describe('NIP-29 private groups', () => {
  async function privateGroup() {
    const h = await setup();
    const alice = makeKey();
    const bob = makeKey();
    const eve = makeKey();
    const pub = await h.connect();
    await createGroup(h, pub, alice, [['private'], ['closed']]);
    await h.publish(
      pub,
      h.event(alice, {
        kind: 9000,
        tags: [
          ['h', G],
          ['p', bob.pk],
        ],
      }),
    );
    return { h, alice, bob, eve, pub };
  }

  test('reads require AUTH as a member', async () => {
    const { h, alice, bob, eve, pub } = await privateGroup();
    const a = await h.connect();
    await h.auth(a, alice);
    const secret = h.event(alice, { kind: 9, tags: [['h', G]], content: 'secret' });
    expect((await h.publish(a, secret))[2]).toBe(true);

    const anon = await h.connect();
    const r1 = await h.req(anon, 'g', { '#h': [G] });
    expect(String(r1[0]?.[2])).toMatch(/^auth-required: /);

    const e = await h.connect();
    await h.auth(e, eve);
    const r2 = await h.req(e, 'g', { '#h': [G] });
    expect(String(r2[0]?.[2])).toMatch(/^restricted: /);
    // Broad filters never leak private posts.
    expect(eventsOf(await h.req(e, 'all', { kinds: [9] }))).toEqual([]);
    expect(eventsOf(await h.req(anon, 'all', { ids: [secret.id] }))).toEqual([]);

    const b = await h.connect();
    await h.auth(b, bob);
    expect(eventsOf(await h.req(b, 'g', { kinds: [9], '#h': [G] }))).toEqual([secret]);
    // Metadata stays public.
    expect(eventsOf(await h.req(anon, 'meta', { kinds: [39000], '#d': [G] }))).toHaveLength(1);

    // Live delivery respects membership.
    e.take();
    b.take();
    const live = h.event(bob, { kind: 9, tags: [['h', G]], content: 'live' });
    await h.publish(b, live);
    expect(eventsOf(b.frames, 'g')).toEqual([live]);
    expect(eventsOf(e.frames)).toEqual([]);
    void pub;
  });

  test('non-members cannot post', async () => {
    const { h, eve, pub } = await privateGroup();
    const r = await h.publish(pub, h.event(eve, { kind: 9, tags: [['h', G]] }));
    expect(String(r[3])).toMatch(/^restricted: /);
  });
});

describe('NIP-29 admin actions and service', () => {
  test('groups.* actions create, manage members and roles, undo, and delete', async () => {
    const h = await setup();
    const ctx = adminCtx(h);
    const bob = makeKey();
    const carol = makeKey();
    const get = (id: string) => h.kernel.actions.get(id)!;
    for (const id of [
      'groups.create',
      'groups.add-member',
      'groups.remove-member',
      'groups.set-role',
      'groups.delete',
    ])
      expect(get(id)).toBeDefined();

    const createInput = get('groups.create').input.parse({ id: 'eng', name: 'Engineering' });
    expect((await get('groups.create').preview!(createInput, ctx))[0]?.text).toContain(
      'Engineering',
    );
    const created = await get('groups.create').run(createInput, ctx);
    expect(created.summary).toContain('Engineering');
    expect(await stateEvents(h, 39000, 'eng')).toHaveLength(1);

    const add = await get('groups.add-member').run(
      get('groups.add-member').input.parse({ group: 'eng', pubkeys: [bob.pk, carol.pk] }),
      ctx,
    );
    expect(Object.keys((await groups(h).get('main', 'eng'))!.members).sort()).toEqual(
      [bob.pk, carol.pk].sort(),
    );

    await get('groups.set-role').run(
      get('groups.set-role').input.parse({ group: 'eng', pubkey: bob.pk, roles: ['admin'] }),
      ctx,
    );
    expect(pTags((await stateEvents(h, 39001, 'eng'))[0])).toEqual([['p', bob.pk, 'admin']]);

    // Bob, now a group admin, can moderate via Nostr events too.
    const c = await h.connect();
    const r = await h.publish(
      c,
      h.event(bob, {
        kind: 9001,
        tags: [
          ['h', 'eng'],
          ['p', carol.pk],
        ],
      }),
    );
    expect(r[2]).toBe(true);

    const removed = await get('groups.remove-member').run(
      get('groups.remove-member').input.parse({ group: 'eng', pubkeys: [bob.pk] }),
      ctx,
    );
    expect(await groups(h).isMember('main', 'eng', bob.pk)).toBe(false);
    await get('groups.remove-member').undo!(removed.undo!.payload, ctx);
    expect((await groups(h).get('main', 'eng'))!.members[bob.pk]).toEqual(['admin']);
    await get('groups.add-member').undo!(add.undo!.payload, ctx);
    // Undoing the original add removes everyone who was not a member before it.
    expect(await groups(h).isMember('main', 'eng', bob.pk)).toBe(false);
    expect(await groups(h).isMember('main', 'eng', carol.pk)).toBe(false);

    const preview = await get('groups.delete').preview!({ group: 'eng' }, ctx);
    expect(preview.some((l) => l.kind === 'warning')).toBe(true);
    await get('groups.delete').run({ group: 'eng' }, ctx);
    expect(await groups(h).get('main', 'eng')).toBeNull();
    expect(created.undo).toBeDefined();
  });

  test('setMembers syncs an external member list (IdP groups)', async () => {
    const h = await setup();
    const svc = groups(h);
    const [a, b, c] = [makeKey(), makeKey(), makeKey()];
    await svc.create('main', { id: 'sales', name: 'Sales', private: true, closed: true });
    await svc.setMembers('main', 'sales', [a.pk, b.pk], { admins: [a.pk] });
    let g = (await svc.get('main', 'sales'))!;
    expect(g.members).toEqual({ [a.pk]: ['admin'], [b.pk]: [] });
    await svc.setMembers('main', 'sales', [a.pk, c.pk]);
    g = (await svc.get('main', 'sales'))!;
    expect(Object.keys(g.members).sort()).toEqual([a.pk, c.pk].sort());
    expect(g.members[a.pk]).toEqual(['admin']);
    // State events are strictly ordered even within the same second.
    const members = await stateEvents(h, 39002, 'sales');
    expect(members).toHaveLength(1);
    expect(
      pTags(members[0])
        .map((t) => t[1])
        .sort(),
    ).toEqual([a.pk, c.pk].sort());
  });

  test('groups can be disabled', async () => {
    const h = await setup({ relayModule: { groups: { enabled: false } } });
    expect(h.kernel.use(GROUPS_SERVICE)).toBeUndefined();
    expect(h.kernel.actions.get('groups.create')).toBeUndefined();
    const c = await h.connect();
    expect((await h.publish(c, h.event(makeKey(), { kind: 9, tags: [['h', 'x']] })))[2]).toBe(true);
    const res = await h.kernel.http.request('http://relay.test/', {
      headers: { accept: 'application/nostr+json' },
    });
    const doc = (await res.json()) as ReturnType<typeof relayInfo>;
    expect(doc.supported_nips).not.toContain(29);
    expect(doc.self).toBeUndefined();
  });
});
