// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import {
  type EnterpriseIdentityService,
  IDENTITY_SERVICE,
  applyPatch,
  parseFilter,
  parsePath,
} from '../src/index.ts';
import { type Harness, makeKernel, runAction } from './helpers.ts';

const CT = { 'content-type': 'application/scim+json' };

async function setup() {
  const h = await makeKernel({
    enterprise: {
      relays: ['corp'],
      idps: [{ id: 'entra', type: 'microsoft', tenant: 'contoso.onmicrosoft.com', clientId: 'c' }],
    },
  });
  const out = await runAction(h.kernel, 'enterprise.connect-idp', {
    provider: 'microsoft',
    id: 'entra',
  });
  const token = (out.output as { values: { scimToken: string } }).values.scimToken;
  const identity = h.kernel.use<EnterpriseIdentityService>(IDENTITY_SERVICE);
  if (!identity) throw new Error('not registered');
  const scim = (path: string, method = 'GET', body?: unknown) =>
    h.req(`/scim/v2${path}`, {
      method,
      headers: { ...CT, authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { h, token, identity, scim };
}

/** Body Entra sends when creating a user (default attribute mappings). */
function entraUser(upn: string, objectId: string) {
  return {
    schemas: [
      'urn:ietf:params:scim:schemas:core:2.0:User',
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    ],
    externalId: objectId,
    userName: upn,
    active: true,
    displayName: 'Alice Example',
    title: 'Engineer',
    emails: [{ primary: true, type: 'work', value: upn }],
    name: { formatted: 'Alice Example', familyName: 'Example', givenName: 'Alice' },
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'R&D' },
  };
}

async function linkKey(h: Harness, identity: EnterpriseIdentityService, key: string) {
  const b = await identity.store.get(key);
  if (!b) throw new Error('missing');
  const k = makeKey();
  await identity.bindPubkey(b, k.pk, 'self-custody');
  return k;
}

describe('SCIM 2.0 (Entra provisioning)', () => {
  test('auth: missing or wrong token is refused', async () => {
    const { h } = await setup();
    expect((await h.req('/scim/v2/Users')).status).toBe(401);
    const bad = await h.req('/scim/v2/Users', { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { schemas: string[] }).schemas[0]).toContain('Error');
  });

  test('discovery endpoints', async () => {
    const { scim } = await setup();
    const spc = (await (await scim('/ServiceProviderConfig')).json()) as {
      patch: { supported: boolean };
    };
    expect(spc.patch.supported).toBe(true);
    const rt = (await (await scim('/ResourceTypes')).json()) as {
      Resources: Array<{ id: string }>;
    };
    expect(rt.Resources.map((r) => r.id)).toEqual(['User', 'Group']);
    const sc = (await (await scim('/Schemas')).json()) as { totalResults: number };
    expect(sc.totalResults).toBe(3);
  });

  test('Entra sequence: probe, create user, group + member add, PATCH active false', async () => {
    const { h, identity, scim } = await setup();
    // 1. Entra "test connection" probe with a random userName → empty list, 200.
    const probe = await scim(`/Users?filter=${encodeURIComponent('userName eq "a1b2c3"')}`);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ totalResults: 0, Resources: [] });

    // 2. Lookup by userName, then create.
    const upn = 'alice@contoso.com';
    const oid = '0b3b6a2c-1111-4c9e-9f3a-7a8c9d0e1f20';
    const created = await scim('/Users', 'POST', entraUser(upn, oid));
    expect(created.status).toBe(201);
    const user = (await created.json()) as { id: string; active: boolean; userName: string };
    expect(user.active).toBe(true);
    expect(user.userName).toBe(upn);
    const dup = await scim('/Users', 'POST', entraUser(upn, oid));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { scimType: string }).scimType).toBe('uniqueness');

    const byName = (await (
      await scim(`/Users?filter=${encodeURIComponent(`userName eq "${upn}"`)}`)
    ).json()) as { totalResults: number; Resources: Array<{ id: string }> };
    expect(byName.totalResults).toBe(1);
    expect(byName.Resources[0]?.id).toBe(user.id);
    const byExt = (await (
      await scim(`/Users?filter=${encodeURIComponent(`externalId eq "${oid}"`)}`)
    ).json()) as { totalResults: number };
    expect(byExt.totalResults).toBe(1);

    // Binding key uses the externalId (= Entra objectId = OIDC `oid`).
    const key = `entra:${oid}`;
    const b = await identity.store.get(key);
    expect(b).toMatchObject({
      email: upn,
      department: 'R&D',
      title: 'Engineer',
      status: 'pending',
    });

    // 3. Group create, filter by displayName, member add (Entra PATCH form).
    const g = await scim('/Groups', 'POST', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Engineering',
      externalId: 'grp-oid-1',
      members: [],
    });
    expect(g.status).toBe(201);
    const group = (await g.json()) as { id: string };
    const gl = (await (
      await scim(
        `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "Engineering"')}`,
      )
    ).json()) as { Resources: Array<Record<string, unknown>> };
    expect(gl.Resources[0]?.id).toBe(group.id);
    expect(gl.Resources[0]?.members).toBeUndefined();

    const add = await scim(`/Groups/${group.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Add', path: 'members', value: [{ value: user.id }] }],
    });
    expect(add.status).toBe(204);
    expect((await identity.store.get(key))?.groups).toEqual([group.id]);
    const full = (await (await scim(`/Groups/${group.id}`)).json()) as {
      members: Array<{ value: string }>;
    };
    expect(full.members.map((m) => m.value)).toEqual([user.id]);

    // Group mapping by display name grants the relay; the person links a key.
    await runAction(h.kernel, 'enterprise.map-group', {
      idp: 'entra',
      group: 'engineering',
      relays: [{ relayId: 'corp', access: 'write' }],
      tier: 'staff',
    });
    const k = await linkKey(h, identity, key);
    const resolver = h.kernel.access[0];
    expect(resolver?.id).toBe('enterprise.binding');
    expect(await resolver?.canWrite?.('corp', k.pk)).toBe(true);
    expect(await resolver?.tierOf?.('corp', k.pk)).toBe('staff');

    // 4. PATCH replace attributes (path-less value object with URN keys).
    const upd = await scim(`/Users/${user.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Replace', path: 'title', value: 'Staff Engineer' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: 'alice.e@contoso.com' },
        {
          op: 'Replace',
          value: { 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department': 'Eng' },
        },
      ],
    });
    expect(upd.status).toBe(200);
    expect(await identity.store.get(key)).toMatchObject({
      title: 'Staff Engineer',
      email: 'alice.e@contoso.com',
      department: 'Eng',
      status: 'active',
    });

    // 5. Entra soft delete: PATCH active "False" (string) → offboarding.
    const off = await scim(`/Users/${user.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { active: boolean }).active).toBe(false);
    const after = await identity.store.get(key);
    expect(after?.status).toBe('suspended');
    expect(after?.npub).toBeUndefined();
    expect(await resolver?.canWrite?.('corp', k.pk)).toBe(false);

    // 6. Re-enable → pending (must link again); revocation stays until relinked.
    const on = await scim(`/Users/${user.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: true } }],
    });
    expect(on.status).toBe(200);
    expect((await identity.store.get(key))?.status).toBe('pending');
    expect(await resolver?.canWrite?.('corp', k.pk)).toBe(false);
    await identity.bindPubkey((await identity.store.get(key))!, k.pk, 'self-custody');
    expect(await resolver?.canWrite?.('corp', k.pk)).toBe(true);

    // 7. Member remove (filtered path form), then hard delete → 404 afterwards.
    const rm = await scim(`/Groups/${group.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Remove', path: `members[value eq "${user.id}"]` }],
    });
    expect(rm.status).toBe(204);
    expect((await identity.store.get(key))?.groups).toEqual([]);
    expect(await resolver?.canWrite?.('corp', k.pk)).toBe(false); // mapping no longer matches

    const del = await scim(`/Users/${user.id}`, 'DELETE');
    expect(del.status).toBe(204);
    expect((await scim(`/Users/${user.id}`)).status).toBe(404);
    expect((await identity.store.get(key))?.status).toBe('deleted');
  });

  test('PUT replaces a user; member removal by value array; group delete', async () => {
    const { scim, identity } = await setup();
    const u = (await (
      await scim('/Users', 'POST', entraUser('bob@contoso.com', 'bob-oid'))
    ).json()) as { id: string };
    const g = (await (
      await scim('/Groups', 'POST', {
        displayName: 'Sales',
        members: [{ value: u.id }],
      })
    ).json()) as { id: string };
    expect((await identity.store.get('entra:bob-oid'))?.groups).toEqual([g.id]);
    await scim(`/Groups/${g.id}`, 'PATCH', {
      Operations: [{ op: 'Remove', path: 'members', value: [{ value: u.id }] }],
    });
    expect((await identity.store.get('entra:bob-oid'))?.groups).toEqual([]);

    const put = await scim(`/Users/${u.id}`, 'PUT', {
      ...entraUser('bob@contoso.com', 'bob-oid'),
      displayName: 'Robert',
      title: undefined,
    });
    expect(put.status).toBe(200);
    expect(await identity.store.get('entra:bob-oid')).toMatchObject({ name: 'Robert' });

    expect((await scim(`/Groups/${g.id}`, 'DELETE')).status).toBe(204);
    expect((await scim(`/Groups/${g.id}`)).status).toBe(404);
  });

  test('unsupported filter → 400 invalidFilter', async () => {
    const { scim } = await setup();
    const r = await scim(`/Users?filter=${encodeURIComponent('title co "x"')}`);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { scimType: string }).scimType).toBe('invalidFilter');
  });
});

describe('SCIM helpers', () => {
  test('parseFilter / parsePath', () => {
    expect(parseFilter('UserName eq "a@b.c"')).toEqual({ attr: 'username', value: 'a@b.c' });
    expect(parsePath('emails[type eq "work"].value')).toEqual({
      attr: 'emails',
      filter: { attr: 'type', value: 'work' },
      sub: 'value',
    });
    expect(
      parsePath('urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager').attr,
    ).toBe('urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager');
  });

  test('applyPatch handles dotted paths, manager and add to missing email', () => {
    const doc: Record<string, unknown> = { userName: 'x' };
    applyPatch(doc, {
      Operations: [
        { op: 'Add', path: 'name.givenName', value: 'Xan' },
        { op: 'Add', path: 'emails[type eq "work"].value', value: 'x@y.z' },
        {
          op: 'Add',
          path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager',
          value: 'mgr-id',
        },
      ],
    });
    expect(doc).toEqual({
      userName: 'x',
      name: { givenName: 'Xan' },
      emails: [{ type: 'work', value: 'x@y.z' }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { manager: 'mgr-id' },
    });
  });
});
