// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enterprise screens (GAPS B1, §12.0): every module screen the backend
 * declares has a lazy chunk here, enterprise text lives only in those chunks,
 * and the pure helpers behind the screens behave.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NetworkConfigSchema } from '../../enterprise-compliance/src/network/config.ts';
import type { JsonSchema } from '../src/lib/api/types.ts';
import { flatten } from '../src/lib/forms/values.ts';
import {
  decidedText,
  requesterName,
  stackOrder,
} from '../src/lib/modules/enterprise-compliance/approvals-view.ts';
import {
  base64Bytes,
  lastMonth,
  sinkText,
} from '../src/lib/modules/enterprise-compliance/compliance.ts';
import { describeAccess, personLabel } from '../src/lib/modules/enterprise-identity/groups.ts';
import { auditText, providerName } from '../src/lib/modules/enterprise-keyvault/keys.ts';
import {
  ADVANCED,
  SIMPLE,
  fieldsFor,
  hasNetworkSchema,
  patchFor,
} from '../src/lib/modules/enterprise-network/network.ts';
import {
  type ApprovalRow,
  approvalField,
  approvalFromError,
  approvalFromOutput,
  approvedInput,
  matches,
  withoutGateLine,
} from '../src/lib/modules/shared/approvals.ts';
import { resolveScreen } from '../src/lib/screens.ts';

const pwa = join(import.meta.dirname, '..');
const packages = join(pwa, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'paraglide') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** `chunk: '…'` of every `kernel.ui` route declared by the enterprise backend packages. */
function declaredChunks(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pkg of readdirSync(packages).filter((p) => p.startsWith('enterprise-'))) {
    const src = join(packages, pkg, 'src');
    if (!existsSync(src)) continue;
    for (const f of walk(src).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(f, 'utf8');
      if (!text.includes('kernel.ui.push')) continue;
      for (const m of text.matchAll(/chunk:\s*'([a-z0-9-]+)'/g)) {
        const list = out.get(m[1] as string) ?? [];
        list.push(relative(packages, f));
        out.set(m[1] as string, list);
      }
    }
  }
  return out;
}

const ROW: ApprovalRow = {
  id: 'apr_1',
  actionId: 'enterprise.disconnect-idp',
  actionTitle: 'Disconnect a company sign-in provider',
  relayId: null,
  input: { provider: 'google' },
  requestedBy: 'alice',
  requestedByName: 'Alice',
  createdAt: 100,
  expiresAt: 1000,
  status: 'pending',
  canApprove: true,
  mine: false,
};

describe('enterprise module chunks (§12.0)', () => {
  it('has a lazy chunk for every screen the enterprise backend declares', () => {
    const chunks = declaredChunks();
    expect([...chunks.keys()].sort()).toEqual([
      'enterprise-compliance',
      'enterprise-identity',
      'enterprise-keyvault',
      'enterprise-network',
    ]);
    const missing = [...chunks.keys()].filter(
      (c) => !existsSync(join(pwa, 'src/lib/modules', `${c}.svelte`)),
    );
    expect(missing).toEqual([]);
  });

  it('keeps enterprise text out of the shared message catalog', () => {
    const en = readFileSync(join(pwa, 'messages/en.json'), 'utf8');
    for (const phrase of [
      'Waiting for a second admin',
      'Legal holds',
      'Company keeps keys',
      'Networks that can open the admin app',
      'Signing history',
    ])
      expect(en).not.toContain(phrase);
  });

  it('nothing outside the module registry imports a module chunk directly', () => {
    const offenders = walk(join(pwa, 'src'))
      .filter((f) => !f.includes(`${join('src', 'lib', 'modules')}`) && /\.(ts|svelte)$/.test(f))
      .filter((f) =>
        /from ['"](\$lib\/modules\/|\.\/modules\/|\.\.\/modules\/)/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(pwa, f));
    expect(offenders).toEqual([]);
  });

  it('resolves server-named module screens onto /m', () => {
    const mods = [
      '/settings/compliance',
      '/approvals',
      '/people/company',
      '/settings/company/keys',
    ];
    expect(resolveScreen('/settings/compliance', mods)).toMatchObject({
      href: '/m/settings/compliance',
      fallback: false,
    });
    expect(resolveScreen('/approvals/apr_123', mods)).toMatchObject({
      href: '/m/approvals/apr_123',
      fallback: false,
    });
    expect(resolveScreen('/settings/company/keys', mods).href).toBe('/m/settings/company/keys');
    // The app draws Company sign-in itself.
    expect(resolveScreen('/settings/company', mods).href).toBe('/settings/company');
    expect(resolveScreen('/approvals', []).fallback).toBe(true);
  });
});

describe('two-person rule helpers', () => {
  it('reads pending approvals from results and errors', () => {
    expect(approvalFromOutput({ status: 'approval-required', requestId: 'apr_9' })).toBe('apr_9');
    expect(approvalFromOutput({ provider: 'x' })).toBeNull();
    expect(approvalFromError('Waiting for a second admin to approve (request apr_ab12)')).toBe(
      'apr_ab12',
    );
    expect(approvalFromError('Waiting for a second admin to approve')).toBe('');
    expect(approvalFromError('This request was denied (request apr_1)')).toBeNull();
    expect(approvalFromError('Something else broke')).toBeNull();
  });

  it('runs an approved request with the right field', () => {
    const gated = { inputSchema: { properties: { provider: {}, _approvalId: {} } } } as never;
    const vault = { inputSchema: { properties: { subjectId: {}, approvalId: {} } } } as never;
    expect(approvalField(gated)).toBe('_approvalId');
    expect(approvalField(vault)).toBe('approvalId');
    expect(approvedInput(ROW, gated)).toEqual({ provider: 'google', _approvalId: 'apr_1' });
    expect(matches(ROW, 'enterprise.disconnect-idp', { provider: 'google' })).toBe(true);
    expect(matches(ROW, 'enterprise.disconnect-idp', { provider: 'entra' })).toBe(false);
    expect(
      withoutGateLine([
        { kind: 'remove', text: 'Google Workspace will be removed' },
        {
          kind: 'warning',
          text: 'Another admin must approve this before it happens',
          technical: 'two-person rule (§12.9)',
        },
      ]).map((l) => l.text),
    ).toEqual(['Google Workspace will be removed']);
  });

  it('orders the approvals stack and never offers one’s own request', () => {
    const rows: ApprovalRow[] = [
      { ...ROW, id: 'a', expiresAt: 500 },
      { ...ROW, id: 'b', expiresAt: 300 },
      { ...ROW, id: 'mine', mine: true, canApprove: false },
      { ...ROW, id: 'done', status: 'approved' },
    ];
    expect(stackOrder(rows).map((r) => r.id)).toEqual(['b', 'a']);
    expect(stackOrder(rows, 'a').map((r) => r.id)).toEqual(['a', 'b']);
    const names = { label: () => 'npub1abc…xyz' };
    expect(requesterName(ROW, names)).toBe('Alice');
    expect(
      requesterName(
        { ...ROW, requestedByName: undefined, requestedByPubkey: 'f'.repeat(64) } as ApprovalRow,
        names,
      ),
    ).toBe('npub1abc…xyz');
    expect(
      decidedText({ ...ROW, status: 'denied', decidedByName: 'Bob', note: 'not now' }, names),
    ).toBe('Denied by Bob — “not now”');
  });
});

describe('plain wording', () => {
  it('describes groups, people, keys and log destinations without jargon', () => {
    expect(
      describeAccess({
        relays: [
          { relayId: 'main', access: 'write' },
          { relayId: 'news', access: 'read' },
        ],
      }),
    ).toBe('Posts on main, Reads news');
    expect(personLabel({ key: 'g:1', email: 'a@corp.com' }, { label: () => '' })).toBe(
      'a@corp.com',
    );
    expect(providerName('aws-kms')).toBe('AWS Key Management Service');
    expect(auditText({ op: 'sign', kind: 1, ok: true })).toBe('Signed a post');
    expect(auditText({ op: 'escrow_decrypt', ok: false })).toBe(
      'Refused: opened a private message for compliance',
    );
    expect(sinkText({ type: 'splunk', enabled: true, sent: 0, dropped: 0, failures: 2 })).toMatch(
      /Not reaching/,
    );
    expect(lastMonth(new Date(Date.UTC(2026, 0, 15)))).toBe('2025-12');
    expect([...base64Bytes(btoa('hi'))]).toEqual([104, 105]);
  });
});

describe('network access settings', () => {
  const schema = {
    type: 'object',
    properties: {
      node: { type: 'object', properties: { trustProxy: { type: 'boolean', default: false } } },
      modules: {
        type: 'object',
        properties: {
          'enterprise-network': z.toJSONSchema(NetworkConfigSchema, {
            io: 'input',
            unrepresentable: 'any',
          }),
        },
      },
    },
  } as unknown as JsonSchema;
  const relays = [
    { id: 'main', name: 'Main' },
    { id: 'ops', name: 'Ops' },
  ];

  it('keeps the simple screen within 7 settings and puts other relays under Advanced', () => {
    expect(hasNetworkSchema(schema)).toBe(true);
    expect(hasNetworkSchema({ type: 'object', properties: {} } as JsonSchema)).toBe(false);
    const simple = fieldsFor(schema, SIMPLE, relays, 'main');
    expect(simple.length).toBeLessThanOrEqual(7);
    expect(simple.map((f) => f.label)).toContain('Networks that can use Main');
    expect(simple.map((f) => f.path.join('.'))).toContain('node.trustProxy');
    const advanced = fieldsFor(schema, ADVANCED, relays, 'main');
    expect(advanced.map((f) => f.label)).toContain('Networks that can use Ops');
  });

  it('patches only what changed, creating the module section when absent', () => {
    const doc = { node: { trustProxy: false }, modules: {} };
    const fields = fieldsFor(schema, SIMPLE, relays, 'main');
    const values: Record<string, unknown> = flatten(doc, fields);
    const key = fields.find((f) => f.name === 'main')!.path.join('__');
    values[key] = ['10.0.0.0/8'];
    values.node__trustProxy = true;
    const patch = patchFor(doc, fields, values);
    expect(patch).toEqual([
      {
        op: 'add',
        path: '/modules/enterprise-network',
        value: { allowlist: { relays: { main: ['10.0.0.0/8'] } } },
      },
      { op: 'add', path: '/node/trustProxy', value: true },
    ]);
  });
});
