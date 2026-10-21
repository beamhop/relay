// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Outputs of the `system.*` actions (mirrors packages/lifecycle/src/system:
 * UpdateCheckOutput, UpdateStatus, DoctorReport, AdvisorReport).
 */

export type UpdatePhase =
  | 'idle'
  | 'backing-up'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'checking'
  | 'done'
  | 'failed'
  | 'rolled-back';

export interface InstallInfo {
  kind: 'binary' | 'docker' | 'systemd' | 'source' | 'readonly' | 'cloudflare' | 'unknown';
  canSelfUpdate: boolean;
  howTo?: string;
  technical?: string;
  restart?: 're-exec' | 'exit';
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  notes?: string;
  notesSummary?: string;
  downloadBytes?: number;
  canVerify: boolean;
  signature: 'verifiable' | 'no-key' | 'unsigned-release' | 'unknown';
  allowUnsigned: boolean;
  install: InstallInfo;
  canSelfUpdate: boolean;
  blocked?: string;
  runtime: string;
  technical: string;
  error?: string;
}

export interface UpdateStatus {
  phase: UpdatePhase;
  from?: string;
  to?: string;
  startedAt?: number;
  updatedAt: number;
  message: string;
  technical?: string;
  backupId?: string;
  backupSize?: number;
  progress?: { done: number; total?: number };
  autoRolledBack?: boolean;
  current: string;
  previousVersion: string | null;
  busy: boolean;
}

export type DoctorTone = 'green' | 'amber' | 'red' | 'grey';

export interface DoctorResult {
  id: string;
  source: 'doctor' | 'health';
  tone: DoctorTone;
  title: string;
  message: string;
  lens: string[];
  fix?: { label: string; actionId: string; input: Record<string, unknown> };
  advice?: string;
}

export interface DoctorReport {
  at: number;
  results: DoctorResult[];
  counts: Record<DoctorTone, number>;
  fullChecks: boolean;
}

export interface Advice {
  id: string;
  severity: 'info' | 'suggestion' | 'warning';
  title: string;
  body: string;
  lens: string[];
  apply?: { label: string; actionId: string; input: Record<string, unknown> };
}

export interface AdvisorReport {
  at: number;
  size: { vcpus: number; memoryGb: number; diskGb: number };
  advice: Advice[];
}
