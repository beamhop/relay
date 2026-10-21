// SPDX-License-Identifier: AGPL-3.0-or-later
/** Compliance screen: shapes of the compliance actions and plain wording (lazy chunk). */

export interface LegalHold {
  id: string;
  name: string;
  reason: string;
  scope: Record<string, unknown>;
  status: 'active' | 'released';
  createdAt: number;
  createdBy: string;
  releasedAt?: number;
  releasedBy?: string;
  releaseReason?: string;
  /** Plain description of what the hold covers. */
  describe?: string;
}

export interface ArchiveFile {
  path: string;
  sha256: string;
  size: number;
  type: string;
}

export interface ExportRecord {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  signer: string;
  files: ArchiveFile[];
  counts: { events: number; archivedEvents: number; blobs: number; relays: number };
  truncated: boolean;
}

export interface SinkStatus {
  type: string;
  enabled: boolean;
  sent: number;
  dropped: number;
  failures: number;
  lastError?: string;
  lastErrorAt?: number;
  lastSuccessAt?: number;
  auditSeq?: number;
  outboxSeq?: number;
}

export interface ResidencyIssue {
  relayId: string;
  severity: 'warning' | 'critical';
  message: string;
  technical: string;
}

const SINKS: Record<string, string> = {
  syslog: 'Syslog',
  splunk: 'Splunk',
  'splunk-hec': 'Splunk',
  sentinel: 'Microsoft Sentinel',
  chronicle: 'Google Chronicle',
  webhook: 'Web address (webhook)',
};

export function sinkName(type: string): string {
  return SINKS[type] ?? type;
}

/** One plain line about a security-log destination. */
export function sinkText(s: SinkStatus): string {
  if (!s.enabled) return 'Turned off';
  if (s.failures > 0) return `Not reaching it (${s.failures} tries failed)`;
  if (s.sent === 0) return 'Nothing sent yet';
  return `${s.sent.toLocaleString()} records sent`;
}

export function sinkTone(s: SinkStatus): 'ok' | 'warn' | 'critical' | 'neutral' {
  if (!s.enabled) return 'neutral';
  if (s.failures > 0) return 'critical';
  return 'ok';
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Last calendar month as YYYY-MM. */
export function lastMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Decode base64 file content returned by `compliance.export-file`. */
export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
