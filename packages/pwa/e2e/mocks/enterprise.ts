// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enterprise mock actions for E2E (GAPS B1): company groups and people,
 * company keys, compliance, approvals (two-person rule) and network access.
 * Off unless the test resets with `{ enterprise: true }`. Shapes follow the
 * real actions in packages/enterprise-{identity,keyvault,compliance}.
 */
import { z } from 'zod';
import { NetworkConfigSchema } from '../../../enterprise-compliance/src/network/config.ts';

type Diff = {
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
  text: string;
  technical?: string;
};

export interface MockAction {
  id: string;
  title: string;
  description: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly?: boolean;
  input: z.ZodType;
  preview?: (input: Record<string, unknown>) => Diff[];
  run: (input: Record<string, unknown>) => { output: unknown; summary: string; undo?: () => void };
}

export interface Host {
  mappings(): Array<Record<string, unknown>>;
  setMappings(m: Array<Record<string, unknown>>): void;
}

const ALICE = 'c'.repeat(64);
const BOB = 'd'.repeat(64);
const ME = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const GATE: Diff = {
  kind: 'warning',
  text: 'Another admin must approve this before it happens',
  technical: 'two-person rule (§12.9): run again with _approvalId once approved',
};

function fresh(on: boolean) {
  const t = now();
  return {
    on,
    seq: 0,
    providers: [
      { id: 'google', type: 'google', name: 'Google Workspace', people: 3, provisioning: 'google' },
    ],
    lastSync: t - 600,
    people: [
      {
        key: 'google:alice',
        email: 'alice@acme.com',
        name: 'Alice Archer',
        pubkey: ALICE,
        keyModel: 'managed',
        status: 'active',
        groups: ['eng'],
        source: 'google',
      },
      {
        key: 'google:bob',
        email: 'bob@acme.com',
        name: 'Bob Baker',
        pubkey: BOB,
        keyModel: 'self-custody',
        status: 'active',
        groups: ['eng', 'ops'],
        source: 'google',
      },
      {
        key: 'google:carol',
        email: 'carol@acme.com',
        name: 'Carol Chen',
        keyModel: 'self-custody',
        status: 'pending',
        groups: [],
        source: 'google',
      },
    ] as Array<Record<string, unknown>>,
    keys: [
      { subjectId: 'google:alice', pubkey: ALICE, status: 'active', createdAt: t - 86400 * 30 },
    ] as Array<Record<string, unknown>>,
    audit: [
      {
        id: 'au1',
        at: (t - 120) * 1000,
        op: 'sign',
        kind: 1,
        subjectId: 'google:alice',
        pubkey: ALICE,
        client: 'Team client',
        via: 'bunker',
        ok: true,
      },
    ],
    holds: [
      {
        id: 'h1',
        name: 'Acme v. Example',
        reason: 'Pending litigation',
        scope: { pubkeys: [], subjects: [{ subject: 'alice' }], groups: [], relays: [] },
        describe: 'alice on every relay',
        status: 'active',
        createdAt: t - 86400,
        createdBy: ME,
      },
    ] as Array<Record<string, unknown>>,
    exports: [
      {
        id: 'ex1',
        name: 'Matter 42',
        createdAt: t - 3600,
        createdBy: ME,
        signer: 'e'.repeat(64),
        files: [
          { path: 'manifest.json', sha256: 'f'.repeat(64), size: 230, type: 'application/json' },
        ],
        counts: { events: 12, archivedEvents: 0, blobs: 1, relays: 1 },
        truncated: false,
      },
    ],
    pendingRotation: 2,
    approvals: [
      {
        id: 'apr_other',
        actionId: 'enterprise.offboard-person',
        actionTitle: 'Remove someone’s access now',
        relayId: null,
        input: { person: 'bob@acme.com' },
        inputHash: '0'.repeat(64),
        reason: 'Left the team',
        requestedBy: BOB,
        requestedByName: 'Bob Baker',
        requestedByPubkey: BOB,
        createdAt: t - 300,
        expiresAt: t + 3600 * 20,
        status: 'pending',
      },
    ] as Array<Record<string, unknown>>,
  };
}

let E = fresh(false);

/** Ids of the actions defined here (hidden from the catalog while enterprise is off). */
const OWN = new Set<string>();

function fileApproval(actionId: string, actionTitle: string, input: unknown): string {
  const id = `apr_${(++E.seq).toString(16).padStart(6, '0')}`;
  E.approvals.unshift({
    id,
    actionId,
    actionTitle,
    relayId: null,
    input,
    inputHash: '0'.repeat(64),
    requestedBy: ME,
    requestedByName: 'Owner',
    requestedByPubkey: ME,
    createdAt: now(),
    expiresAt: now() + 86400,
    status: 'pending',
  });
  return id;
}

function decide(id: string, status: 'approved' | 'denied'): Record<string, unknown> {
  const r = E.approvals.find((x) => x.id === id);
  if (!r) throw new Error('That approval request does not exist');
  if (r.status !== 'pending') throw new Error(`This request is already ${r.status}`);
  if (status === 'approved' && r.requestedBy === ME)
    throw new Error('You cannot approve your own request');
  r.status = status;
  r.decidedBy = ME;
  r.decidedByName = 'Owner';
  r.decidedAt = now();
  if (status === 'approved') r.approvalExpiresAt = now() + 3600;
  return r;
}

const node = { scope: 'node' as const };

function actions(host: Host): MockAction[] {
  const list: MockAction[] = [
    {
      ...node,
      id: 'enterprise.directory-status',
      title: 'Show company directory status',
      description: 'Sign-in providers and directory sync.',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          providers: E.providers,
          directorySync: {
            enabled: true,
            configured: true,
            idp: 'google',
            intervalMinutes: 15,
            lastRunAt: E.lastSync,
            lastReport: { users: { seen: 3 } },
          },
        },
        summary: `${E.providers.length} sign-in providers`,
      }),
    },
    {
      ...node,
      id: 'enterprise.list-people',
      title: 'Show company people',
      description: 'Everyone from the company directory.',
      permission: 'users.write',
      readOnly: true,
      input: z.object({ status: z.string().optional() }),
      run: () => ({ output: { people: E.people }, summary: `${E.people.length} people` }),
    },
    {
      ...node,
      id: 'enterprise.unmap-group',
      title: 'Remove a directory group rule',
      description: 'People in this group lose what the rule gave them.',
      permission: 'admins.manage',
      input: z.object({ idp: z.string().default('*'), group: z.string().min(1) }),
      preview: (i) => [{ kind: 'remove', text: `“${i.group}” no longer gets access` }],
      run: (i) => {
        const prev = host.mappings();
        host.setMappings(prev.filter((m) => m.group !== i.group));
        return {
          output: { removed: true },
          summary: `Removed the rule for “${i.group}”`,
          undo: () => host.setMappings(prev),
        };
      },
    },
    {
      ...node,
      id: 'enterprise.offboard-person',
      title: 'Remove someone’s access now',
      description: 'Signs them out everywhere and hands their groups and files to their manager.',
      permission: 'users.write',
      input: z.object({ person: z.string() }),
      preview: (i) => [
        { kind: 'remove', text: `${i.person} loses access right away` },
        { kind: 'info', text: 'Their groups and files go to their manager' },
      ],
      run: (i) => {
        const p = E.people.find((x) => x.email === i.person || x.key === i.person);
        if (!p) throw new Error(`No one called “${i.person}”`);
        p.status = 'suspended';
        return {
          output: { bindingKey: p.key, status: 'suspended' },
          summary: `Removed access for ${p.email}`,
        };
      },
    },
    {
      ...node,
      id: 'enterprise.disconnect-idp',
      title: 'Disconnect a company sign-in provider',
      description: 'Removes a sign-in provider.',
      permission: 'node.manage',
      input: z.object({ provider: z.string().min(1), _approvalId: z.string().optional() }),
      preview: (i) => [
        { kind: 'remove', text: 'Google Workspace will be removed from the sign-in options' },
        { kind: 'warning', text: '3 people who sign in with it will no longer be able to sign in' },
        ...(i._approvalId
          ? [{ kind: 'info' as const, text: 'A second admin approved this change' }]
          : [GATE]),
      ],
      run: (i) => {
        if (!i._approvalId) {
          const requestId = fileApproval(
            'enterprise.disconnect-idp',
            'Disconnect a company sign-in provider',
            {
              provider: i.provider,
            },
          );
          return {
            output: { status: 'approval-required', requestId, expiresAt: now() + 86400 },
            summary: 'Asked another admin to approve: disconnect a company sign-in provider',
          };
        }
        E.providers = E.providers.filter((p) => p.id !== i.provider);
        return { output: { provider: i.provider }, summary: 'Disconnected Google Workspace' };
      },
    },
    {
      ...node,
      id: 'enterprise.sync-directory',
      title: 'Sync the Google directory now',
      description: 'Fetch people and groups from Google Workspace right away.',
      permission: 'users.write',
      input: z.object({}),
      preview: () => [{ kind: 'info', text: 'People who were suspended in Google lose access' }],
      run: () => {
        E.lastSync = now();
        return { output: { users: { seen: 3 } }, summary: '3 people, 2 groups synced' };
      },
    },
    {
      ...node,
      id: 'enterprise.list-key-destructions',
      title: 'Show scheduled key destruction',
      description: 'Company-held keys of people who left.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({ output: { items: [] }, summary: '0 scheduled' }),
    },
    {
      ...node,
      id: 'keyvault.status',
      title: 'Show key vault status',
      description: 'Where the master key lives.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          provider: 'aws-kms',
          kekId: 'arn:aws:kms:eu-west-1:1:key/2',
          ready: true,
          error: null,
          dataKeys: 3,
          pendingRotation: E.pendingRotation,
          keys: {
            active: E.keys.filter((k) => k.status === 'active').length,
            'pending-destroy': E.keys.filter((k) => k.status === 'pending-destroy').length,
            destroyed: 0,
          },
          bunkerPubkey: 'b'.repeat(64),
          escrowEnabled: false,
          signing: { signed: 1, errors: 0, rateLimited: 0, since: 0 },
        },
        summary: '1 company-managed key',
      }),
    },
    {
      ...node,
      id: 'keyvault.list-keys',
      title: 'Show company-managed keys',
      description: 'Whose keys the company holds.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({ status: z.string().optional(), limit: z.number().default(200) }),
      run: () => ({ output: { keys: E.keys }, summary: `${E.keys.length} keys` }),
    },
    {
      ...node,
      id: 'keyvault.audit',
      title: 'Show signing history',
      description: 'Every signature made with company-managed keys.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({ limit: z.number().default(100) }),
      run: () => ({ output: E.audit, summary: `${E.audit.length} records` }),
    },
    {
      ...node,
      id: 'keyvault.rotate-kek',
      title: 'Switch to the new master key',
      description: 'Re-wraps every data key with the current master key.',
      permission: 'node.manage',
      input: z.object({ force: z.boolean().default(false), approvalId: z.string().optional() }),
      preview: () => [
        {
          kind: 'change',
          text: `${E.pendingRotation} data keys will be re-wrapped with the current master key`,
        },
      ],
      run: (i) => {
        const r = i.approvalId ? E.approvals.find((x) => x.id === i.approvalId) : undefined;
        if (!r || r.status !== 'approved') {
          const id = r
            ? (r.id as string)
            : fileApproval('keyvault.rotate-kek', 'Switch to the new master key', {
                force: i.force,
              });
          throw new Error(`Waiting for a second admin to approve (request ${id})`);
        }
        r.status = 'used';
        E.pendingRotation = 0;
        return { output: { rewrapped: 2, failed: [] }, summary: 'Re-wrapped 2 data key(s)' };
      },
    },
    {
      ...node,
      id: 'keyvault.wrap-legacy-keys',
      title: 'Protect older server keys with the master key',
      description: 'Encrypts keys the server stored before the key vault was turned on.',
      permission: 'node.manage',
      input: z.object({ relayGroupKeys: z.boolean().optional() }),
      run: () => ({ output: { wrapped: ['alerts'] }, summary: 'Protected 1 older key(s)' }),
    },
    {
      ...node,
      id: 'keyvault.destroy-key',
      title: 'Destroy a company-managed key',
      description: 'Permanently erases the person’s private key after a waiting period.',
      permission: 'compliance.write',
      input: z.object({
        subjectId: z.string().min(1),
        afterDays: z.number().int().min(0).optional(),
        reason: z.string().min(3).describe('Why the key must go'),
      }),
      preview: (i) => [
        {
          kind: 'warning',
          text: `The key will be destroyed in ${i.afterDays ?? 30} day(s). You can cancel until then.`,
        },
      ],
      run: (i) => {
        const k = E.keys.find((x) => x.subjectId === i.subjectId);
        if (!k) return { output: { status: 'not-found' }, summary: 'No key to destroy' };
        k.status = 'pending-destroy';
        k.destroyAfter = now() + Number(i.afterDays ?? 30) * 86400;
        return {
          output: { status: 'scheduled', destroyAfter: k.destroyAfter },
          summary: 'Scheduled the key for destruction',
        };
      },
    },
    {
      ...node,
      id: 'keyvault.cancel-destroy',
      title: 'Keep a company-managed key',
      description: 'Cancels a scheduled key destruction.',
      permission: 'compliance.write',
      input: z.object({ subjectId: z.string().min(1) }),
      run: (i) => {
        const k = E.keys.find((x) => x.subjectId === i.subjectId);
        if (k) {
          k.status = 'active';
          k.destroyAfter = undefined;
        }
        return { output: { cancelled: !!k }, summary: k ? 'Key kept' : 'Nothing was scheduled' };
      },
    },
    {
      ...node,
      id: 'keyvault.revoke-sessions',
      title: 'Sign a person out of all apps',
      description: 'Disconnects every app that signs through the company bunker for this person.',
      permission: 'users.write',
      input: z.object({ subjectId: z.string().min(1) }),
      run: () => ({ output: { revoked: 2 }, summary: 'Signed out of 2 session(s)' }),
    },
    {
      ...node,
      id: 'compliance.list-holds',
      title: 'Show legal holds',
      description: 'Data that cannot be deleted because of a legal hold.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({ includeReleased: z.boolean().default(false) }),
      run: (i) => ({
        output: {
          holds: i.includeReleased ? E.holds : E.holds.filter((h) => h.status === 'active'),
        },
        summary: 'Listed legal holds',
      }),
    },
    {
      ...node,
      id: 'compliance.create-hold',
      title: 'Start a legal hold',
      description: 'Freeze data so nobody can delete it until the hold is released.',
      permission: 'compliance.write',
      input: z.object({
        name: z.string().min(1).max(120).describe('Matter name'),
        reason: z.string().min(1).max(1000).describe('Why the data must be kept'),
      }),
      preview: (i) => [
        { kind: 'add', text: `Nothing can be deleted for everyone on every relay (“${i.name}”)` },
      ],
      run: (i) => {
        const h = {
          id: `h${E.holds.length + 1}`,
          name: i.name,
          reason: i.reason,
          scope: { pubkeys: [], subjects: [], groups: [], relays: [] },
          describe: 'everyone on every relay',
          status: 'active',
          createdAt: now(),
          createdBy: ME,
        };
        E.holds.push(h);
        return {
          output: { hold: h },
          summary: `Started legal hold “${i.name}”`,
          undo: () => {
            E.holds = E.holds.filter((x) => x !== h);
          },
        };
      },
    },
    {
      ...node,
      id: 'compliance.release-hold',
      title: 'Release a legal hold',
      description: 'Let normal deletion rules apply again.',
      permission: 'compliance.write',
      input: z.object({ holdId: z.string().min(1), reason: z.string().min(1) }),
      preview: () => [{ kind: 'remove', text: 'The legal hold ends' }, GATE],
      run: (i) => {
        const requestId = fileApproval('compliance.release-hold', 'Release a legal hold', i);
        return {
          output: { status: 'approval-required', requestId },
          summary: 'Asked another admin to approve: release a legal hold',
        };
      },
    },
    {
      ...node,
      id: 'compliance.export',
      title: 'Export data for legal review (eDiscovery)',
      description: 'Collect posts into a signed archive.',
      permission: 'compliance.write',
      input: z.object({ name: z.string().max(120).optional() }),
      run: (i) => ({
        output: { export: { id: 'ex2', name: i.name ?? 'Export' } },
        summary: 'Created eDiscovery export',
      }),
    },
    {
      ...node,
      id: 'compliance.list-exports',
      title: 'Show eDiscovery exports',
      description: 'Signed archives created for legal review.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({ output: { exports: E.exports }, summary: `Listed ${E.exports.length} export` }),
    },
    {
      ...node,
      id: 'compliance.export-file',
      title: 'Download an eDiscovery archive file',
      description: 'Get one file of an archive (base64).',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({ exportId: z.string(), path: z.string() }),
      run: (i) => ({
        output: {
          path: i.path,
          sha256: 'f'.repeat(64),
          type: 'application/json',
          base64: btoa('{"format":"beamhop-ediscovery/1"}'),
        },
        summary: `Downloaded ${i.path}`,
      }),
    },
    {
      ...node,
      id: 'compliance.siem-status',
      title: 'Show SIEM export status',
      description: 'How far each security log destination has caught up.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          sinks: {
            splunk: {
              type: 'splunk',
              enabled: true,
              sent: 120,
              dropped: 0,
              failures: 0,
              lastSuccessAt: now() - 60,
            },
          },
        },
        summary: 'Status of 1 destination',
      }),
    },
    {
      ...node,
      id: 'compliance.test-sink',
      title: 'Test a SIEM connection',
      description: 'Send one test record to your security log system.',
      permission: 'compliance.write',
      input: z.object({ sinkId: z.string().optional() }),
      run: () => ({
        output: { results: { splunk: { ok: true } } },
        summary: 'All 1 destination(s) received the test record',
      }),
    },
    {
      ...node,
      id: 'compliance.usage-report',
      title: 'Make a usage report',
      description: 'People, posts and storage per company group for one month.',
      permission: 'compliance.read',
      input: z.object({ month: z.string().optional() }),
      run: (i) => ({
        output: {
          report: {
            month: i.month,
            rows: [{ group: 'eng', people: 2, events: 40 }],
            totals: { events: 40 },
          },
        },
        summary: `Usage report for ${i.month}: 1 group, 40 posts`,
      }),
    },
    {
      ...node,
      id: 'compliance.check-residency',
      title: 'Check where data is stored',
      description: 'Make sure each relay’s data stays in its required region.',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({ output: { issues: [] }, summary: 'All data is in the required regions' }),
    },
    {
      ...node,
      id: 'approvals.list',
      title: 'Show approval requests',
      description: 'Risky changes waiting for a second admin.',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ status: z.string().optional(), limit: z.number().default(100) }),
      run: () => ({
        output: {
          requests: E.approvals.map((r) => ({
            ...r,
            mine: r.requestedBy === ME,
            canApprove: r.status === 'pending' && r.requestedBy !== ME,
          })),
        },
        summary: `Listed ${E.approvals.length} approval requests`,
      }),
    },
    {
      ...node,
      id: 'approvals.approve',
      title: 'Approve a request',
      description: 'Let another admin go ahead with a risky change.',
      permission: 'relay.read',
      input: z.object({ requestId: z.string(), note: z.string().optional() }),
      run: (i) => {
        const r = decide(String(i.requestId), 'approved');
        return {
          output: { request: r },
          summary: `Approved: ${String(r.actionTitle).toLowerCase()}`,
        };
      },
    },
    {
      ...node,
      id: 'approvals.deny',
      title: 'Deny a request',
      description: 'Stop a risky change another admin asked for (or withdraw your own).',
      permission: 'relay.read',
      input: z.object({ requestId: z.string(), note: z.string().optional() }),
      run: (i) => {
        const r = decide(String(i.requestId), 'denied');
        return {
          output: { request: r },
          summary: `Denied: ${String(r.actionTitle).toLowerCase()}`,
        };
      },
    },
  ];
  for (const a of list) OWN.add(a.id);
  return list;
}

const ROUTES = [
  {
    path: '/people/company',
    title: 'Company groups',
    placement: 'people-section',
    chunk: 'enterprise-identity',
  },
  {
    path: '/settings/company/keys',
    title: 'Company keys',
    placement: 'settings-section',
    chunk: 'enterprise-keyvault',
  },
  {
    path: '/settings/compliance',
    title: 'Compliance',
    placement: 'settings-section',
    chunk: 'enterprise-compliance',
  },
  {
    path: '/approvals',
    title: 'Approvals',
    placement: 'activity-section',
    chunk: 'enterprise-compliance',
  },
  {
    path: '/settings/network',
    title: 'Network access',
    placement: 'settings-section',
    chunk: 'enterprise-network',
  },
];

type SchemaNode = { properties?: Record<string, SchemaNode>; [k: string]: unknown };

export const enterprise = {
  actions,
  reset(on: boolean) {
    E = fresh(on);
  },
  /** Enterprise actions are in the catalog only while enterprise is on. */
  visible(id: string): boolean {
    return E.on || !OWN.has(id);
  },
  /** Mock-server state while enterprise is on: identity module enabled, one group rule. */
  seed(modules: Record<string, boolean>) {
    return {
      modules: { ...modules, 'enterprise-identity': true },
      mappings: [
        {
          idp: '*',
          group: 'eng',
          relays: [{ relayId: 'main', access: 'write' }],
          adminRole: 'moderator',
          keyModel: 'managed',
          channel: true,
          people: 2,
        },
      ] as Array<Record<string, unknown>>,
    };
  },
  routes() {
    return E.on ? ROUTES : [];
  },
  /** Publish `modules.enterprise-network` in the node config schema (as the real server does). */
  annotate(nodeSchema: unknown) {
    const modules = (nodeSchema as SchemaNode).properties?.modules;
    if (modules)
      modules.properties = {
        ...(modules.properties ?? {}),
        'enterprise-network': z.toJSONSchema(NetworkConfigSchema, {
          io: 'input',
          unrepresentable: 'any',
        }) as SchemaNode,
      };
  },
  state: () => E,
};
