// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin actions (§6.13): admin-api generates REST routes, CLI commands and
 * palette entries from these. Registered only when the module is enabled.
 */
import {
  type ActionContext,
  type ActionDef,
  type BeamhopConfig,
  type DiffLine,
  type Kernel,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { IdpSchema, KeyModelSchema, MODULE_ID } from './config.ts';
import type { GoogleDirectorySync } from './google.ts';
import { groupIdentifiers, mappingMatches } from './mapping.ts';
import type { OidcClient } from './oidc.ts';
import { issuerOf } from './oidc.ts';
import { redirectUriOf } from './routes.ts';
import { SCIM_BASE, createScimToken, scimTokenInfo } from './scim.ts';
import type { EnterpriseIdentityService } from './service.ts';
import { type Binding, COL, type GroupMapping, bindingKey } from './store.ts';

export interface ActionDeps {
  kernel: Kernel;
  identity: EnterpriseIdentityService;
  oidc: OidcClient;
  google: GoogleDirectorySync;
}

const RoleSchema = z.enum(['owner', 'admin', 'moderator', 'viewer']);
const UNDO_SECONDS = 300;

const MapInput = z.object({
  idp: z.string().default('*').describe('Sign-in provider id, or * for any'),
  group: z.string().min(1).describe('Directory group name, email or id'),
  relays: z
    .array(z.object({ relayId: z.string(), access: z.enum(['read', 'write']).default('write') }))
    .default([])
    .describe('Relays this group can use'),
  tier: z.string().optional().describe('Limits and quotas for this group'),
  adminRole: RoleSchema.optional().describe('Admin app role for this group'),
  keyModel: KeyModelSchema.optional(),
  channel: z.boolean().default(true).describe('Create a chat channel for this group'),
});

const GroupRef = z.object({ idp: z.string().default('*'), group: z.string().min(1) });

function describeMapping(m: Pick<GroupMapping, 'relays' | 'tier' | 'adminRole' | 'keyModel'>) {
  const parts: string[] = [];
  if (m.relays.length)
    parts.push(
      m.relays.map((r) => `${r.access === 'write' ? 'posts on' : 'reads'} ${r.relayId}`).join(', '),
    );
  if (m.tier) parts.push(`tier “${m.tier}”`);
  if (m.adminRole) parts.push(`${m.adminRole} in the admin app`);
  if (m.keyModel) parts.push(m.keyModel === 'managed' ? 'company-held keys' : 'own keys');
  return parts.join('; ') || 'no access';
}

async function affected(
  identity: EnterpriseIdentityService,
  idp: string,
  group: string,
): Promise<Binding[]> {
  const probe = {
    idp,
    group,
    relays: [],
    channel: false,
    createdAt: 0,
    createdBy: '',
  } as GroupMapping;
  const out: Binding[] = [];
  for (const b of await identity.store.list()) {
    if (b.status === 'suspended' || b.status === 'deleted') continue;
    if (mappingMatches(probe, b.idp, await groupIdentifiers(identity.store, b))) out.push(b);
  }
  return out;
}

function baseUrlFor(kernel: Kernel, identity: EnterpriseIdentityService): string {
  const configured = identity.cfg().publicUrl;
  if (configured) return configured.replace(/\/+$/, '');
  const host = kernel.config().relays[0]?.hosts[0];
  return host ? `https://${host}` : 'https://your-server.example.com';
}

export function createActions(deps: ActionDeps): ActionDef[] {
  const { kernel, identity, oidc, google } = deps;
  const store = identity.store;
  const undoToken = (actionId: string, payload: unknown) => ({
    actionId,
    payload,
    expiresAt: kernel.ports.clock.now() + UNDO_SECONDS,
  });
  const restore = async (payload: unknown) => {
    const p = payload as { prev: GroupMapping | null; idp: string; group: string };
    if (p.prev) await store.putMapping(p.prev);
    else await store.removeMapping(p.idp, p.group);
    await identity.afterChange();
  };

  const actions = [
    defineAction({
      id: 'enterprise.list-mappings',
      title: 'Show directory group rules',
      description: 'What each company directory group can do here.',
      technical: 'IdP group → relay access, tier, admin role, key model (enterprise.mappings).',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      keywords: ['groups', 'sso', 'directory', 'mapping'],
      async run() {
        const list = await store.mappings();
        const out = [];
        for (const m of list)
          out.push({ ...m, people: (await affected(identity, m.idp, m.group)).length });
        return { output: { mappings: out }, summary: `${list.length} group rules` };
      },
    }),

    defineAction({
      id: 'enterprise.map-group',
      title: 'Set what a directory group can do',
      description: 'Choose relays, tier, admin role and key type for a company group.',
      technical:
        'Upserts enterprise.mappings; access resolver, tierOf, admin SSO roles and NIP-29 channel sync follow it.',
      scope: 'node',
      permission: 'admins.manage',
      input: MapInput,
      keywords: ['groups', 'sso', 'tier', 'role'],
      async preview(input) {
        const prev = await store.getMapping(input.idp, input.group);
        const people = await affected(identity, input.idp, input.group);
        const lines: DiffLine[] = [];
        for (const r of input.relays)
          if (!kernel.relay(r.relayId))
            lines.push({ kind: 'warning', text: `There is no relay called “${r.relayId}”` });
        lines.push(
          prev
            ? {
                kind: 'change',
                text: `“${input.group}”: ${describeMapping(prev)} → ${describeMapping(input)}`,
                technical: `enterprise.mappings[${input.idp}:${input.group}]`,
              }
            : {
                kind: 'add',
                text: `“${input.group}” ${describeMapping(input)}`,
                technical: `enterprise.mappings[${input.idp}:${input.group}]`,
              },
        );
        lines.push({
          kind: 'info',
          text: `${people.length} ${people.length === 1 ? 'person is' : 'people are'} in this group`,
        });
        if (input.adminRole === 'owner')
          lines.push({ kind: 'warning', text: 'Everyone in this group becomes an owner' });
        return lines;
      },
      async run(input, ctx) {
        const prev = await store.getMapping(input.idp, input.group);
        const m: GroupMapping = {
          idp: input.idp,
          group: input.group,
          relays: input.relays,
          channel: input.channel,
          createdAt: prev?.createdAt ?? kernel.ports.clock.now(),
          createdBy: prev?.createdBy ?? ctx.principal.id,
          ...(input.tier ? { tier: input.tier } : {}),
          ...(input.adminRole ? { adminRole: input.adminRole } : {}),
          ...(input.keyModel ? { keyModel: input.keyModel } : {}),
        };
        await store.putMapping(m);
        await identity.afterChange();
        return {
          output: { mapping: m },
          summary: `“${input.group}” ${describeMapping(m)}`,
          undo: undoToken('enterprise.map-group', { prev, idp: input.idp, group: input.group }),
        };
      },
      undo: restore,
    }),

    defineAction({
      id: 'enterprise.unmap-group',
      title: 'Remove a directory group rule',
      description: 'People in this group lose what the rule gave them.',
      technical: 'Deletes enterprise.mappings entry.',
      scope: 'node',
      permission: 'admins.manage',
      input: GroupRef,
      async preview(input) {
        const prev = await store.getMapping(input.idp, input.group);
        if (!prev) return [{ kind: 'info', text: `There is no rule for “${input.group}”` }];
        const people = await affected(identity, input.idp, input.group);
        return [
          { kind: 'remove', text: `“${input.group}” no longer ${describeMapping(prev)}` },
          { kind: 'info', text: `${people.length} people are affected` },
        ];
      },
      async run(input) {
        const prev = await store.getMapping(input.idp, input.group);
        await store.removeMapping(input.idp, input.group);
        await identity.afterChange();
        return {
          output: { removed: !!prev },
          summary: prev ? `Removed the rule for “${input.group}”` : 'Nothing to remove',
          ...(prev ? { undo: undoToken('enterprise.unmap-group', { prev, ...input }) } : {}),
        };
      },
      undo: restore,
    }),

    defineAction({
      id: 'enterprise.list-people',
      title: 'Show company people',
      description: 'Everyone from the company directory and whether their key is linked.',
      technical: 'enterprise.bindings: (idp, subject, email) ↔ npub ↔ key model ↔ groups.',
      scope: 'node',
      permission: 'users.write',
      readOnly: true,
      input: z.object({ status: z.enum(['pending', 'active', 'suspended', 'deleted']).optional() }),
      async run(input) {
        const people = (await store.list())
          .filter((b) => !input.status || b.status === input.status)
          .map((b) => ({
            key: bindingKey(b.idp, b.subject),
            email: b.email,
            name: b.name,
            pubkey: b.npub,
            keyModel: b.keyModel,
            status: b.status,
            groups: b.groups,
            source: b.source,
          }));
        return { output: { people }, summary: `${people.length} people` };
      },
    }),

    defineAction({
      id: 'enterprise.offboard-person',
      title: 'Remove someone’s access now',
      description:
        'Signs them out everywhere, unlinks their key, and hands their groups and files to their manager.',
      technical:
        'Offboarding cascade §12.5: revocation list, sessions, admin records/tokens, allowlists, NIP-29 ownership transfer, blob ownership, managed key destruction schedule.',
      scope: 'node',
      permission: 'users.write',
      sensitive: true,
      input: z.object({ person: z.string().describe('Email or <idp>:<subject>') }),
      async preview(input) {
        const b = (await store.byEmail(input.person)) ?? (await store.get(input.person));
        if (!b) return [{ kind: 'warning', text: `No one called “${input.person}”` }];
        return [
          { kind: 'remove', text: `${b.name ?? b.email ?? input.person} loses access right away` },
          { kind: 'info', text: 'Their groups and files go to their manager' },
          ...(b.keyModel === 'managed'
            ? [
                {
                  kind: 'warning' as const,
                  text: `Their company-held key is destroyed after ${identity.cfg().offboarding.keyDestructionGraceDays} days`,
                },
              ]
            : []),
        ];
      },
      async run(input, ctx: ActionContext) {
        const b = (await store.byEmail(input.person)) ?? (await store.get(input.person));
        if (!b) throw new Error(`No one called “${input.person}”`);
        const report = await identity.offboard(
          bindingKey(b.idp, b.subject),
          ctx.reason ?? 'Removed by an admin',
        );
        return { output: report, summary: `Removed access for ${b.email ?? report.bindingKey}` };
      },
    }),

    defineAction({
      id: 'enterprise.connect-idp',
      title: 'Connect your company directory',
      description: 'Step-by-step setup for Google, Microsoft or another sign-in provider.',
      technical:
        'OIDC client registration (redirect URIs), SCIM 2.0 endpoint + bearer token (Entra/Okta), Google Directory API service account.',
      scope: 'node',
      permission: 'config.write',
      input: z.object({
        provider: z.enum(['google', 'microsoft', 'oidc']),
        id: z
          .string()
          .regex(/^[a-z0-9-]{1,32}$/)
          .optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        tenant: z.string().optional(),
        hostedDomain: z.string().optional(),
        issuer: z.string().url().optional(),
        scimToken: z.boolean().default(true).describe('Create a provisioning (SCIM) token'),
      }),
      async preview(input) {
        const lines: DiffLine[] = [
          { kind: 'info', text: `Shows the setup steps for ${providerName(input.provider)}` },
        ];
        if (input.clientId)
          lines.push({ kind: 'add', text: `Adds ${providerName(input.provider)} sign-in` });
        if (input.provider !== 'google' && input.scimToken)
          lines.push({
            kind: 'warning',
            text: 'Creates a new provisioning token (an older one stops working)',
          });
        return lines;
      },
      async run(input, ctx) {
        const id = input.id ?? (input.provider === 'microsoft' ? 'entra' : input.provider);
        const base = baseUrlFor(kernel, identity);
        const redirectUris = {
          admin: redirectUriOf(base, id),
          team: redirectUriOf(base, id),
        };
        let scimToken: string | undefined;
        if (input.provider !== 'google' && input.scimToken)
          scimToken = await createScimToken(kernel, id);
        const idpEntry = IdpSchema.parse({
          id,
          type: input.provider,
          clientId: input.clientId ?? 'PASTE-CLIENT-ID',
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          ...(input.tenant ? { tenant: input.tenant } : {}),
          ...(input.hostedDomain ? { hostedDomain: input.hostedDomain } : {}),
          ...(input.issuer ? { issuer: input.issuer } : {}),
        });
        let applied = false;
        const cfgSvc = kernel.use<{
          apply?(next: unknown, o: { principalId: string; summary?: string }): Promise<unknown>;
        }>('admin.config');
        if (input.clientId && cfgSvc?.apply) {
          const cur: BeamhopConfig = kernel.config();
          const section = { ...((cur.modules[MODULE_ID] as Record<string, unknown>) ?? {}) };
          const idps = ((section.idps as Array<{ id: string }>) ?? []).filter((i) => i.id !== id);
          section.idps = [...idps, idpEntry];
          section.configured = true;
          await cfgSvc.apply(
            { ...cur, modules: { ...cur.modules, [MODULE_ID]: section } },
            { principalId: ctx.principal.id, summary: `Connected ${providerName(input.provider)}` },
          );
          oidc.forget(id);
          applied = true;
        }
        return {
          output: {
            idp: id,
            steps: setupSteps(input.provider, {
              base,
              redirectUris,
              scimUrl: `${base}${SCIM_BASE}`,
              scimToken,
              tenant: input.tenant,
            }),
            values: {
              redirectUri: redirectUris.team,
              signInUrl: `${base}/api/v1/sso/${id}/start`,
              ...(input.provider !== 'google' ? { scimUrl: `${base}${SCIM_BASE}` } : {}),
              ...(scimToken ? { scimToken } : {}),
            },
            config: idpEntry,
            applied,
          },
          summary: `Setup steps for ${providerName(input.provider)}`,
        };
      },
    }),

    defineAction({
      id: 'enterprise.test-connection',
      title: 'Test the company directory connection',
      description: 'Checks that sign-in and directory sync can reach your provider.',
      technical:
        'OIDC discovery + JWKS fetch; Google: service-account token + Directory API users.list; SCIM: token present.',
      scope: 'node',
      permission: 'config.write',
      readOnly: true,
      input: z.object({ idp: z.string() }),
      async run(input) {
        const idp = identity.idp(input.idp);
        const checks: Array<{ name: string; ok: boolean; message: string; technical?: string }> =
          [];
        if (!idp) {
          checks.push({ name: 'provider', ok: false, message: `“${input.idp}” is not set up yet` });
        } else {
          try {
            oidc.forget(idp.id);
            const as = await oidc.discover(idp);
            checks.push({
              name: 'sign-in',
              ok: true,
              message: 'Sign-in provider answered',
              technical: `issuer ${as.issuer}`,
            });
          } catch (err) {
            checks.push({
              name: 'sign-in',
              ok: false,
              message: 'Could not reach the sign-in provider. Check the tenant / issuer address.',
              technical: `${issuerOf(idp)}: ${String(err)}`,
            });
          }
          if (idp.type !== 'google') {
            const info = await scimTokenInfo(kernel, idp.id);
            checks.push({
              name: 'provisioning',
              ok: !!info,
              message: info
                ? `Provisioning token ending in …${info.last4} is ready`
                : 'No provisioning token yet — run “Connect your company directory”',
            });
          }
        }
        if (idp?.type === 'google' || input.idp === identity.cfg().google.directorySync.idp) {
          if (google.configured()) {
            try {
              await google.test();
              checks.push({ name: 'directory', ok: true, message: 'Google directory is readable' });
            } catch (err) {
              checks.push({
                name: 'directory',
                ok: false,
                message: 'Google refused the directory request. Check domain-wide delegation.',
                technical: String(err),
              });
            }
          } else {
            checks.push({
              name: 'directory',
              ok: false,
              message: 'Directory sync is not set up (service account, admin email)',
            });
          }
        }
        const ok = checks.every((c) => c.ok);
        return { output: { ok, checks }, summary: ok ? 'Connection works' : 'Connection problems' };
      },
    }),

    defineAction({
      id: 'enterprise.sync-directory',
      title: 'Sync the Google directory now',
      description: 'Fetch people and groups from Google Workspace right away.',
      technical: 'Admin SDK Directory API users/groups/members delta sync.',
      scope: 'node',
      permission: 'users.write',
      input: z.object({}),
      async preview() {
        return [{ kind: 'info', text: 'People who were suspended in Google lose access' }];
      },
      async run() {
        if (!google.configured()) throw new Error('Google directory sync is not set up');
        const report = await google.run();
        return {
          output: report,
          summary: `${report.users.seen} people, ${report.groups.seen} groups synced`,
        };
      },
    }),

    defineAction({
      id: 'enterprise.list-key-destructions',
      title: 'Show scheduled key destruction',
      description: 'Company-held keys of people who left, and when they are destroyed.',
      technical: 'Managed key crypto-shredding schedule; legal holds block destruction.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      async run() {
        const page = await kernel.ports.docs.list(COL.keyDestruction, { limit: 1000 });
        return {
          output: { items: page.items.map((i) => i.value) },
          summary: `${page.items.length} scheduled`,
        };
      },
    }),
  ];
  return actions as unknown as ActionDef[];
}

function providerName(p: 'google' | 'microsoft' | 'oidc'): string {
  return p === 'google'
    ? 'Google Workspace'
    : p === 'microsoft'
      ? 'Microsoft Entra ID'
      : 'your provider';
}

export function setupSteps(
  provider: 'google' | 'microsoft' | 'oidc',
  v: {
    base: string;
    redirectUris: { admin: string; team: string };
    scimUrl: string;
    scimToken?: string | undefined;
    tenant?: string | undefined;
  },
): Array<{ title: string; body: string; copy?: Record<string, string> }> {
  if (provider === 'google')
    return [
      {
        title: 'Create an OAuth client',
        body: 'Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.',
        copy: { 'Authorized redirect URI': v.redirectUris.team },
      },
      {
        title: 'Paste the client id and secret',
        body: 'Copy the Client ID and Client secret back into Beamhop. Add your Workspace domain so only colleagues can sign in.',
      },
      {
        title: 'Optional: sync people and groups',
        body: 'Create a service account, enable the Admin SDK API, and grant domain-wide delegation for these scopes. Then add the service account key and an admin email.',
        copy: {
          Scopes:
            'https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.group.member.readonly',
        },
      },
      { title: 'Test the connection', body: 'Press “Test connection” in Beamhop.' },
    ];
  if (provider === 'microsoft')
    return [
      {
        title: 'Register an app',
        body: 'Microsoft Entra admin center → App registrations → New registration. Supported account types: this organization only. Redirect URI: Web.',
        copy: { 'Redirect URI': v.redirectUris.team },
      },
      {
        title: 'Create a client secret',
        body: 'Certificates & secrets → New client secret. Copy the value, the Application (client) ID and the Directory (tenant) ID into Beamhop.',
      },
      {
        title: 'Send groups in the token',
        body: 'Token configuration → Add groups claim → Security groups (Group ID).',
      },
      {
        title: 'Turn on provisioning',
        body: 'Enterprise applications → your app → Provisioning → Automatic. Paste the tenant URL and secret token, then “Test Connection”. Under Mappings, map objectId to externalId for users.',
        copy: { 'Tenant URL': v.scimUrl, ...(v.scimToken ? { 'Secret Token': v.scimToken } : {}) },
      },
      {
        title: 'Start provisioning',
        body: 'Assign users and groups, then set Provisioning Status to On.',
      },
    ];
  return [
    {
      title: 'Create an OIDC client',
      body: 'In Okta, Keycloak, Authentik, Auth0 or JumpCloud create a confidential web client using the authorization code flow with PKCE.',
      copy: { 'Redirect URI': v.redirectUris.team },
    },
    {
      title: 'Add a groups claim',
      body: 'Include a “groups” claim in the ID token, then paste the issuer address, client id and secret into Beamhop.',
    },
    {
      title: 'Optional: SCIM provisioning',
      body: 'Point SCIM 2.0 provisioning at Beamhop so people who leave lose access right away.',
      copy: { 'SCIM base URL': v.scimUrl, ...(v.scimToken ? { 'Bearer token': v.scimToken } : {}) },
    },
    { title: 'Test the connection', body: 'Press “Test connection” in Beamhop.' },
  ];
}
