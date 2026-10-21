// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin actions of enterprise-compliance (routes, CLI, palette are generated from these). */
import { type ActionDef, type DiffLine, defineAction } from '@beamhop/core';
import { z } from 'zod';
import type { EDiscovery } from './ediscovery.ts';
import { type HoldScope, type LegalHolds, hasUserSelectors } from './holds.ts';
import type { UsageReports } from './reports.ts';
import { previousMonth } from './reports.ts';
import { type ResidencyIssue, checkResidency } from './residency.ts';
import type { Rt } from './runtime.ts';
import type { SiemExporter } from './siem/exporter.ts';
import { b64encode, plural, shortKey } from './util.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const unix = z.number().int().nonnegative();

const ScopeInput = {
  pubkeys: z.array(z.string().regex(HEX64)).default([]).describe('People (public keys, hex)'),
  subjects: z
    .array(z.object({ subject: z.string().min(1), idp: z.string().optional() }))
    .default([])
    .describe('People from the company directory'),
  groups: z.array(z.string()).default([]).describe('Company directory groups'),
  relays: z.array(z.string()).default([]).describe('Relays (all when empty)'),
  since: unix.optional().describe('From (unix time)'),
  until: unix.optional().describe('Until (unix time)'),
  kinds: z.array(z.number().int().nonnegative()).optional(),
};

function describeScope(s: HoldScope): string {
  const who: string[] = [];
  if (s.pubkeys.length) who.push(s.pubkeys.map(shortKey).join(', '));
  if (s.subjects.length) who.push(s.subjects.map((x) => x.subject).join(', '));
  if (s.groups.length) who.push(`groups ${s.groups.join(', ')}`);
  const where = s.relays.length ? ` on ${s.relays.join(', ')}` : ' on every relay';
  const when =
    s.since !== undefined || s.until !== undefined
      ? ` from ${s.since !== undefined ? new Date(s.since * 1000).toISOString().slice(0, 10) : 'the start'} to ${s.until !== undefined ? new Date(s.until * 1000).toISOString().slice(0, 10) : 'now'}`
      : '';
  return `${who.length ? who.join('; ') : 'everyone'}${where}${when}`;
}

export interface ComplianceParts {
  rt: Rt;
  holds: LegalHolds;
  ediscovery: EDiscovery;
  siem: SiemExporter;
  reports: UsageReports;
  residencyIssues(): ResidencyIssue[];
}

export function complianceActions(p: ComplianceParts): ActionDef[] {
  const { rt, holds, ediscovery, siem, reports } = p;
  const toScope = (i: {
    pubkeys: string[];
    subjects: Array<{ subject: string; idp?: string | undefined }>;
    groups: string[];
    relays: string[];
    since?: number | undefined;
    until?: number | undefined;
    kinds?: number[] | undefined;
  }): HoldScope => {
    const s: HoldScope = {
      pubkeys: i.pubkeys,
      subjects: i.subjects.map((x) =>
        x.idp ? { subject: x.subject, idp: x.idp } : { subject: x.subject },
      ),
      groups: i.groups,
      relays: i.relays,
    };
    if (i.since !== undefined) s.since = i.since;
    if (i.until !== undefined) s.until = i.until;
    if (i.kinds?.length) s.kinds = i.kinds;
    return s;
  };

  return [
    defineAction({
      id: 'compliance.list-holds',
      title: 'Show legal holds',
      description: 'Data that cannot be deleted because of a legal hold.',
      technical: 'compliance.holds; enforced via lifecycle.holds + store-level archive guard.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      keywords: ['legal hold', 'litigation', 'freeze'],
      input: z.object({ includeReleased: z.boolean().default(false) }),
      async run(input) {
        const all = await holds.list();
        const list = input.includeReleased ? all : all.filter((h) => h.status === 'active');
        return {
          output: { holds: list.map((h) => ({ ...h, describe: describeScope(h.scope) })) },
          summary: `Listed ${plural(list.length, 'legal hold')}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.create-hold',
      title: 'Start a legal hold',
      description:
        'Freeze data so nobody can delete it — not the people themselves, retention or admins — until the hold is released.',
      technical:
        'Blocks retention / NIP-62 vanish / crypto-shred / recycle purge via lifecycle.holds; NIP-09 & admin deletions are archived to compliance.hold-archive first; blobs are pinned.',
      scope: 'node',
      permission: 'compliance.write',
      keywords: ['legal hold', 'litigation', 'freeze', 'preserve'],
      input: z.object({
        name: z.string().min(1).max(120).describe('Matter name'),
        reason: z.string().min(1).max(1000).describe('Why the data must be kept'),
        ...ScopeInput,
      }),
      async preview(input) {
        const scope = toScope(input);
        const lines: DiffLine[] = [
          {
            kind: 'add',
            text: `Nothing can be deleted for ${describeScope(scope)}`,
            technical: JSON.stringify(scope),
          },
        ];
        if (!hasUserSelectors(scope))
          lines.push({
            kind: 'warning',
            text: 'No people or groups chosen: this freezes ALL data in scope',
          });
        if (scope.groups.length && !rt.kernel.use('enterprise.identity'))
          lines.push({
            kind: 'warning',
            text: 'Groups only work when the company directory is connected',
          });
        return lines;
      },
      async run(input, ctx) {
        const hold = await holds.create(
          { name: input.name, reason: input.reason, scope: toScope(input) },
          ctx.principal.id,
        );
        return {
          output: { hold },
          summary: `Started legal hold “${hold.name}” for ${describeScope(hold.scope)}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.release-hold',
      title: 'Release a legal hold',
      description: 'Let normal deletion rules apply again. Needs a second admin’s approval.',
      technical: 'Sets status=released; lifecycle may delete held data on its next pass.',
      scope: 'node',
      permission: 'compliance.write',
      sensitive: true,
      keywords: ['legal hold', 'release', 'end'],
      input: z.object({
        holdId: z.string().min(1),
        reason: z.string().min(1).max(1000).describe('Why the hold can end'),
      }),
      async preview(input) {
        const h = await holds.get(input.holdId);
        if (!h) return [{ kind: 'warning', text: 'That legal hold does not exist' }];
        return [
          {
            kind: 'remove',
            text: `Legal hold “${h.name}” ends; data for ${describeScope(h.scope)} can be deleted again`,
          },
        ];
      },
      async run(input, ctx) {
        const h = await holds.release(input.holdId, ctx.principal.id, input.reason);
        return { output: { hold: h }, summary: `Released legal hold “${h.name}”` };
      },
    }),
    defineAction({
      id: 'compliance.export',
      title: 'Export data for legal review (eDiscovery)',
      description:
        'Collect posts and a list of files for chosen people, groups, dates or words into a signed archive that anyone can check for tampering.',
      technical:
        'NDJSON events per relay + blobs.ndjson manifest + manifest.json (sha256 of every file) + signature.json (BIP-340 by the node key); stored content-addressed in the blob store and pinned.',
      scope: 'node',
      permission: 'compliance.write',
      keywords: ['ediscovery', 'export', 'legal', 'archive', 'subpoena'],
      input: z.object({
        name: z.string().max(120).optional(),
        ...ScopeInput,
        keywords: z
          .array(z.string().min(1))
          .default([])
          .describe('Only posts containing these words'),
        includeBlobs: z.boolean().optional().describe('Include the list of files'),
      }),
      async preview(input) {
        return [
          {
            kind: 'add',
            text: `A signed archive of posts by ${describeScope(toScope(input))}${input.keywords.length ? ` containing “${input.keywords.join('”, “')}”` : ''} will be created`,
          },
          { kind: 'info', text: 'The archive files are kept until deleted by an owner' },
        ];
      },
      async run(input, ctx) {
        const q: Parameters<EDiscovery['export']>[0] = {
          pubkeys: input.pubkeys,
          subjects: toScope(input).subjects,
          groups: input.groups,
          relays: input.relays,
          keywords: input.keywords,
        };
        if (input.name) q.name = input.name;
        if (input.since !== undefined) q.since = input.since;
        if (input.until !== undefined) q.until = input.until;
        if (input.kinds?.length) q.kinds = input.kinds;
        if (input.includeBlobs !== undefined) q.includeBlobs = input.includeBlobs;
        const rec = await ediscovery.export(q, ctx.principal.id);
        return {
          output: { export: rec },
          summary: `Created eDiscovery export “${rec.name}” (${plural(rec.counts.events, 'post')}, ${plural(rec.counts.blobs, 'file')})${rec.truncated ? ' — limit reached, narrow the search' : ''}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.list-exports',
      title: 'Show eDiscovery exports',
      description: 'Signed archives created for legal review.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      async run() {
        const list = await ediscovery.list();
        return { output: { exports: list }, summary: `Listed ${plural(list.length, 'export')}` };
      },
    }),
    defineAction({
      id: 'compliance.export-file',
      title: 'Download an eDiscovery archive file',
      description: 'Get one file of an archive (base64).',
      technical: 'Reads the content-addressed file from the blob store.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({ exportId: z.string(), path: z.string() }),
      async run(input) {
        const rec = await ediscovery.get(input.exportId);
        const f = rec?.files.find((x) => x.path === input.path);
        if (!rec || !f) throw new Error('That archive file does not exist');
        const files = await ediscovery.files(input.exportId);
        const data = files[f.path]!;
        return {
          output: { path: f.path, sha256: f.sha256, type: f.type, base64: b64encode(data) },
          summary: `Downloaded ${f.path}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.test-sink',
      title: 'Test a SIEM connection',
      description: 'Send one test record to your security log system.',
      technical: 'Sends a synthetic `siem.test` record; cursors are not moved.',
      scope: 'node',
      permission: 'compliance.write',
      keywords: ['siem', 'splunk', 'sentinel', 'chronicle', 'syslog', 'webhook', 'test'],
      input: z.object({ sinkId: z.string().optional().describe('Destination (all when empty)') }),
      async run(input) {
        const ids = input.sinkId ? [input.sinkId] : rt.settings().siem.sinks.map((s) => s.id);
        if (!ids.length) throw new Error('No SIEM destinations are set up yet');
        const results: Record<string, Awaited<ReturnType<SiemExporter['test']>>> = {};
        for (const id of ids) results[id] = await siem.test(id);
        const failed = Object.entries(results).filter(([, r]) => !r.ok);
        return {
          output: { results },
          summary: failed.length
            ? `${failed.length} of ${ids.length} destination(s) failed: ${failed.map(([id, r]) => `${id} (${r.error})`).join('; ')}`
            : `All ${ids.length} destination(s) received the test record`,
        };
      },
    }),
    defineAction({
      id: 'compliance.siem-status',
      title: 'Show SIEM export status',
      description: 'How far each security log destination has caught up.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      async run() {
        const out: Record<string, unknown> = {};
        for (const s of rt.settings().siem.sinks)
          out[s.id] = { type: s.type, enabled: s.enabled, ...(await siem.state(s.id)) };
        return {
          output: { sinks: out },
          summary: `Status of ${plural(Object.keys(out).length, 'destination')}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.usage-report',
      title: 'Make a usage report',
      description: 'People, posts and storage per company group for one month (CSV and PDF).',
      technical: 'Stored in the blob store (pinned) and indexed in compliance.reports.',
      scope: 'node',
      permission: 'compliance.read',
      keywords: ['usage', 'report', 'cost', 'chargeback', 'billing'],
      input: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe('Month, e.g. 2026-09 (last month when empty)'),
      }),
      async run(input) {
        const month = input.month ?? previousMonth(rt.now());
        const r = await reports.generate(month);
        return {
          output: { report: r },
          summary: `Usage report for ${month}: ${plural(r.rows.length, 'group')}, ${plural(r.totals.events, 'post')}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.report-file',
      title: 'Download a usage report',
      description: 'Get a usage report you already made, as a spreadsheet (CSV) or PDF.',
      technical:
        'Reads the pinned CSV/PDF the usage report stored in the blob store (compliance.reports index), base64.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      keywords: ['usage', 'report', 'download', 'csv', 'pdf'],
      input: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, 'Use the form 2026-09')
          .describe('Month, e.g. 2026-09'),
        format: z.enum(['csv', 'pdf']).default('csv').describe('File type'),
      }),
      async run(input) {
        const r = await reports.get(input.month);
        if (!r) throw new Error(`There is no usage report for ${input.month} yet. Make it first.`);
        const ref = r[input.format];
        const blob = await rt.ports.blobs.get(ref.sha256);
        if (!blob) throw new Error('The report file is missing. Make the report again.');
        const data = new Uint8Array(await new Response(blob.body).arrayBuffer());
        const type = input.format === 'csv' ? 'text/csv' : 'application/pdf';
        return {
          output: { type, base64: b64encode(data) },
          summary: `Downloaded the ${input.format.toUpperCase()} usage report for ${input.month}`,
        };
      },
    }),
    defineAction({
      id: 'compliance.check-residency',
      title: 'Check where data is stored',
      description: 'Make sure each relay’s data stays in its required region.',
      scope: 'node',
      permission: 'compliance.read',
      readOnly: true,
      input: z.object({}),
      async run() {
        const issues = checkResidency(rt.kernel.config(), rt.settings());
        return {
          output: { issues },
          summary: issues.length
            ? `${plural(issues.length, 'problem')} found`
            : 'All data is in the required regions',
        };
      },
    }),
  ] as unknown[] as ActionDef[];
}
