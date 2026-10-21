// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Usage reports for cost allocation (§12.7): per IdP group and month — people,
 * posts, stored media bytes, uploaded bytes — as CSV and a simple PDF, stored in the
 * blob store (pinned) with an index in `compliance.reports`. Node totals include
 * ingress from the insights time series (`events.bytes`, `blobs.uploaded_bytes`)
 * when insights is running. Egress is not metered by Beamhop.
 */
import type { RelayId } from '@beamhop/core';
import { COL } from './config.ts';
import type { LegalHolds } from './holds.ts';
import { identityOf } from './identity.ts';
import { renderPdf } from './pdf.ts';
import type { Rt } from './runtime.ts';
import { sha256Hex, utf8 } from './util.ts';

export interface UsageRow {
  group: string;
  users: number | null;
  events: number;
  storageBytes: number;
  uploadedBytes: number;
}

export interface UsageReport {
  month: string;
  from: number;
  to: number;
  generatedAt: number;
  rows: UsageRow[];
  totals: { events: number; storageBytes: number; ingressBytes: number | null };
  csv: { sha256: string; size: number };
  pdf: { sha256: string; size: number };
}

/** `YYYY-MM` → [from, to) unix seconds (UTC). */
export function monthRange(month: string): { from: number; to: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('Month must look like 2026-09');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error('Month must be between 01 and 12');
  return { from: Date.UTC(y, mo - 1, 1) / 1000, to: Date.UTC(y, mo, 1) / 1000 };
}

export function previousMonth(nowSec: number): string {
  const d = new Date(nowSec * 1000);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(month: string, rows: UsageRow[]): string {
  const lines = ['month,group,users,events,storage_bytes,uploaded_bytes'];
  for (const r of rows)
    lines.push(
      [month, r.group, r.users, r.events, r.storageBytes, r.uploadedBytes].map(csvCell).join(','),
    );
  return `${lines.join('\n')}\n`;
}

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export class UsageReports {
  constructor(
    private readonly rt: Rt,
    private readonly holds: LegalHolds,
  ) {}

  private relays(): RelayId[] {
    return this.rt.kernel.config().relays.map((r) => r.id);
  }

  private async countEvents(authors: string[] | null, from: number, to: number): Promise<number> {
    let n = 0;
    for (const relayId of this.relays()) {
      if (!authors) {
        n += await this.rt.ports.events.count(relayId, [{ since: from, until: to - 1 }]);
        continue;
      }
      for (let i = 0; i < authors.length; i += 100) {
        n += await this.rt.ports.events.count(relayId, [
          { authors: authors.slice(i, i + 100), since: from, until: to - 1 },
        ]);
      }
    }
    return n;
  }

  private async media(
    authors: string[],
    from: number,
    to: number,
  ): Promise<{ stored: number; uploaded: number }> {
    let stored = 0;
    let uploaded = 0;
    const idx = this.rt.ports.blobIndex;
    for (const relayId of this.relays()) {
      for (const pk of authors) {
        stored += await idx.usage(relayId, pk);
        for (const o of await idx.listByOwner(relayId, pk, {
          since: from,
          until: to - 1,
          limit: 100_000,
        }))
          uploaded += o.size;
      }
    }
    return { stored, uploaded };
  }

  private async ingress(from: number, to: number): Promise<number | null> {
    if (!this.rt.kernel.use('insights')) return null;
    let total = 0;
    try {
      for (const metric of ['events.bytes', 'blobs.uploaded_bytes']) {
        const pts = await this.rt.ports.metrics.range({
          metric,
          from,
          to,
          stepSeconds: Math.max(60, to - from),
          agg: 'sum',
        });
        for (const p of pts) total += p.v;
      }
    } catch {
      return null;
    }
    return total;
  }

  async build(month: string): Promise<{ rows: UsageRow[]; from: number; to: number }> {
    const { from, to } = monthRange(month);
    const id = identityOf(this.rt.kernel);
    const rows: UsageRow[] = [];
    if (id?.members) {
      const byGroup = new Map<string, Set<string>>();
      for (const m of await id.members()) {
        const groups = m.groups.length ? m.groups : ['(no group)'];
        for (const g of groups) {
          let s = byGroup.get(g);
          if (!s) {
            s = new Set();
            byGroup.set(g, s);
          }
          s.add(m.pubkey);
        }
      }
      for (const [group, set] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const authors = [...set];
        const media = await this.media(authors, from, to);
        rows.push({
          group,
          users: authors.length,
          events: await this.countEvents(authors, from, to),
          storageBytes: media.stored,
          uploadedBytes: media.uploaded,
        });
      }
    } else {
      // No company directory: one row for everyone.
      let stored = 0;
      let uploaded = 0;
      const owners = new Set<string>();
      for (const relayId of this.relays()) {
        let cursor: string | undefined;
        do {
          const page = await this.rt.ports.blobIndex.list(relayId, { cursor, limit: 1000 });
          for (const o of page.items) {
            stored += o.size;
            owners.add(o.pubkey);
            if (o.uploadedAt >= from && o.uploadedAt < to) uploaded += o.size;
          }
          cursor = page.cursor;
        } while (cursor);
      }
      rows.push({
        group: 'everyone',
        users: null,
        events: await this.countEvents(null, from, to),
        storageBytes: stored,
        uploadedBytes: uploaded,
      });
    }
    return { rows, from, to };
  }

  async generate(month: string): Promise<UsageReport> {
    const { rows, from, to } = await this.build(month);
    const totals = {
      events: rows.reduce((a, r) => a + r.events, 0),
      storageBytes: (await this.rt.ports.events.stats().catch(() => ({ bytes: 0 }))).bytes,
      ingressBytes: await this.ingress(from, to),
    };
    const csv = utf8(toCsv(month, rows));
    const lines = [
      `Node: ${this.rt.kernel.config().node.id}    Period: ${new Date(from * 1000).toISOString().slice(0, 10)} to ${new Date((to - 1) * 1000).toISOString().slice(0, 10)}`,
      '',
      `${'Group'.padEnd(28)}${'People'.padStart(8)}${'Posts'.padStart(12)}${'Stored'.padStart(12)}${'Uploaded'.padStart(12)}`,
      '-'.repeat(72),
      ...rows.map(
        (r) =>
          `${r.group.slice(0, 27).padEnd(28)}${(r.users === null ? '-' : String(r.users)).padStart(8)}${String(r.events).padStart(12)}${fmtBytes(r.storageBytes).padStart(12)}${fmtBytes(r.uploadedBytes).padStart(12)}`,
      ),
      '-'.repeat(72),
      `Total posts: ${totals.events}`,
      `Database size: ${fmtBytes(totals.storageBytes)}`,
      `Ingress: ${totals.ingressBytes === null ? 'not measured (insights off)' : fmtBytes(totals.ingressBytes)}`,
      '',
      'People can be in several groups; group rows may overlap.',
    ];
    const pdf = renderPdf({ title: `Beamhop usage report ${month}`, lines });
    const put = async (data: Uint8Array, type: string) => {
      const hash = await sha256Hex(data);
      await this.rt.ports.blobs.put({ sha256: hash, size: data.length, type }, data);
      await this.holds.pinBlob(hash, `usage report ${month}`);
      return { sha256: hash, size: data.length };
    };
    const report: UsageReport = {
      month,
      from,
      to,
      generatedAt: this.rt.now(),
      rows,
      totals,
      csv: await put(csv, 'text/csv'),
      pdf: await put(pdf, 'application/pdf'),
    };
    await this.rt.ports.docs.put(COL.reports, month, report);
    return report;
  }

  get(month: string): Promise<UsageReport | null> {
    return this.rt.ports.docs.get<UsageReport>(COL.reports, month);
  }

  /** Scheduled: make last month's report once. */
  async tick(): Promise<UsageReport | null> {
    if (!this.rt.settings().reports.monthly) return null;
    const month = previousMonth(this.rt.now());
    if (await this.get(month)) return null;
    return this.generate(month);
  }
}
