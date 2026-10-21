// SPDX-License-Identifier: AGPL-3.0-or-later
/** SIEM record model + wire formats (RFC 5424 syslog, Splunk HEC, Sentinel, Chronicle). */
import type { RelayId } from '@beamhop/core';
import type { SiemStream } from '../runtime.ts';
import { utf8 } from '../util.ts';

/** One exported record. `chain` carries the tamper-evident hash-chain fields. */
export interface SiemRecord {
  /** Stable id: `audit:<seq>` (admin audit log) or `evt:<seq>` (compliance event log). */
  id: string;
  stream: SiemStream;
  type: string;
  /** Unix seconds. */
  at: number;
  node: string;
  relayId: RelayId | null;
  principalId?: string;
  summary: string;
  ok?: boolean;
  data?: unknown;
  chain: {
    /** Which hash chain: the admin audit log or the compliance event log. */
    log: 'admin.audit' | 'compliance.events';
    seq: number;
    prevHash: string;
    hash: string;
  };
}

const SD_ID = 'beamhop@32473';

function sdEscape(v: string): string {
  return v.replace(/[\\"\]]/g, (c) => `\\${c}`);
}

function printable(v: string, max: number): string {
  const s = v.replace(/[^\x21-\x7e]/g, '_').slice(0, max);
  return s || '-';
}

/** RFC 5424 severity for a record. */
export function severityOf(r: SiemRecord): number {
  if (r.ok === false) return 4; // warning
  if (r.stream === 'escrow' || r.stream === 'compliance') return 5; // notice
  return 6; // informational
}

/** RFC 5424 message (no transport framing). */
export function toSyslog(
  r: SiemRecord,
  opts: { facility: number; appName: string; hostname: string },
): string {
  const pri = opts.facility * 8 + severityOf(r);
  const ts = new Date(r.at * 1000).toISOString();
  const sd = [
    `log="${sdEscape(r.chain.log)}"`,
    `seq="${r.chain.seq}"`,
    `hash="${r.chain.hash}"`,
    `prevHash="${r.chain.prevHash}"`,
    `stream="${sdEscape(r.stream)}"`,
    r.relayId ? `relay="${sdEscape(r.relayId)}"` : '',
    r.principalId ? `principal="${sdEscape(r.principalId)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<${pri}>1 ${ts} ${printable(opts.hostname, 255)} ${printable(opts.appName, 48)} - ${printable(r.type, 32)} [${SD_ID} ${sd}] ${JSON.stringify(r)}`;
}

/** RFC 6587 octet-counting framing for syslog over TCP/TLS. */
export function octetFrame(msg: string): Uint8Array {
  const body = utf8(msg);
  const head = utf8(`${body.length} `);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Splunk HEC batch body: concatenated event objects. */
export function toSplunk(
  records: SiemRecord[],
  opts: { sourcetype: string; index?: string; host: string },
): string {
  return records
    .map((r) =>
      JSON.stringify({
        time: r.at,
        host: opts.host,
        source: 'beamhop',
        sourcetype: opts.sourcetype,
        ...(opts.index ? { index: opts.index } : {}),
        event: r,
      }),
    )
    .join('\n');
}

/** Sentinel (Logs Ingestion API) rows: flat columns matching a custom table. */
export function toSentinel(records: SiemRecord[]): Array<Record<string, unknown>> {
  return records.map((r) => ({
    TimeGenerated: new Date(r.at * 1000).toISOString(),
    RecordId: r.id,
    Stream: r.stream,
    EventType: r.type,
    Node: r.node,
    RelayId: r.relayId ?? '',
    PrincipalId: r.principalId ?? '',
    Summary: r.summary,
    Ok: r.ok ?? true,
    Data: r.data ?? null,
    ChainLog: r.chain.log,
    ChainSeq: r.chain.seq,
    ChainHash: r.chain.hash,
    ChainPrevHash: r.chain.prevHash,
  }));
}

/** Chronicle unstructured log entries. */
export function toChronicle(records: SiemRecord[]): Array<{
  log_text: string;
  ts_epoch_microseconds: number;
}> {
  return records.map((r) => ({
    log_text: JSON.stringify(r),
    ts_epoch_microseconds: r.at * 1_000_000,
  }));
}
