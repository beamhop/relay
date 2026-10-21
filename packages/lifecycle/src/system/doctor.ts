// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-app doctor: the `beamhop doctor` checks (provided by the runtime as
 * `runtime.doctor`; DNS, certificate, ports, proxy, WebSocket, disk, clock…)
 * plus every registered health check, as plain results with a technical lens.
 * Fixes are suggestions — an action id + input the admin can preview and
 * apply — never applied here.
 */
import type { HealthCheck, Kernel } from '@beamhop/core';
import { DOCTOR_SERVICE, type DoctorFinding, type DoctorRunner } from './types.ts';

export type DoctorTone = 'green' | 'amber' | 'red' | 'grey';

export interface DoctorFix {
  label: string;
  actionId: string;
  input: Record<string, unknown>;
}

export interface DoctorResult {
  id: string;
  /** `doctor` (beamhop doctor) or `health` (registered health check). */
  source: 'doctor' | 'health';
  tone: DoctorTone;
  title: string;
  message: string;
  /** Technical lens lines (ids, raw values). */
  lens: string[];
  fix?: DoctorFix;
  /** Plain advice when no in-app fix exists. */
  advice?: string;
}

export interface DoctorReport {
  at: number;
  results: DoctorResult[];
  counts: { green: number; amber: number; red: number; grey: number };
  /** False when the runtime has no doctor (e.g. Cloudflare): only health checks ran. */
  fullChecks: boolean;
}

interface FixRule {
  /** Finding / check id, or a prefix ending with `.` or `:`. */
  match: string;
  fix: DoctorFix;
}

/** Known fixes (each an existing action, previewed before it runs). */
export const FIX_RULES: FixRule[] = [
  {
    match: 'lifecycle.backups',
    fix: {
      label: 'Set up backups',
      actionId: 'backups.setup',
      input: { enabled: true, schedule: 'daily' },
    },
  },
  {
    match: 'insights.backups',
    fix: { label: 'Back up now', actionId: 'backups.run-now', input: {} },
  },
  {
    match: 'lifecycle.storage-cap',
    fix: { label: 'Remove oldest reactions', actionId: 'lifecycle.prune-storage', input: {} },
  },
  {
    match: 'disk.free',
    fix: { label: 'Free up space', actionId: 'lifecycle.prune-storage', input: {} },
  },
  {
    match: 'insights.storage',
    fix: { label: 'Free up space', actionId: 'lifecycle.prune-storage', input: {} },
  },
  {
    match: 'lifecycle.retention',
    fix: { label: 'Clean up now', actionId: 'retention.run-now', input: {} },
  },
];

const CLI_ADVICE = 'Run `beamhop doctor --fix` on the server to fix this.';

function fixFor(kernel: Kernel, id: string): DoctorFix | undefined {
  for (const r of FIX_RULES) {
    const hit =
      r.match === id ||
      ((r.match.endsWith('.') || r.match.endsWith(':')) && id.startsWith(r.match));
    if (hit && kernel.actions.get(r.fix.actionId)) return r.fix;
  }
  return undefined;
}

const TONE: Record<DoctorFinding['status'], DoctorTone> = {
  ok: 'green',
  warn: 'amber',
  fail: 'red',
  skip: 'grey',
};

export function fromFinding(kernel: Kernel, f: DoctorFinding): DoctorResult {
  const tone = TONE[f.status];
  const r: DoctorResult = {
    id: f.id,
    source: 'doctor',
    tone,
    title: f.title,
    message: f.message,
    lens: [`check ${f.id}`, ...(f.technical ? [f.technical] : [])],
  };
  if (tone === 'amber' || tone === 'red') {
    const fix = fixFor(kernel, f.id);
    if (fix) r.fix = fix;
    else if (f.fixHint) r.advice = `${f.fixHint}. ${CLI_ADVICE}`;
  }
  if (f.fixHint) r.lens.push(`beamhop doctor --fix: ${f.fixHint}`);
  return r;
}

const SUBSYSTEM_TITLE: Record<string, string> = {
  backups: 'Backups',
  storage: 'Storage',
  availability: 'Availability',
  errors: 'Errors',
  latency: 'Speed',
  certificates: 'Certificate',
  tls: 'Certificate',
};

function titleOf(c: HealthCheck): string {
  const sub = SUBSYSTEM_TITLE[c.subsystem];
  if (sub) return sub;
  const tail = c.id.split('.').pop() ?? c.id;
  return tail.charAt(0).toUpperCase() + tail.slice(1).replace(/-/g, ' ');
}

export async function fromHealth(kernel: Kernel, c: HealthCheck): Promise<DoctorResult> {
  try {
    const h = await c.run(null);
    const tone: DoctorTone =
      h.status === 'critical' ? 'red' : h.status === 'warn' ? 'amber' : 'green';
    const r: DoctorResult = {
      id: c.id,
      source: 'health',
      tone,
      title: titleOf(c),
      message: h.message,
      lens: [`health check ${c.id} · score ${h.score}`, ...(h.technical ? [h.technical] : [])],
    };
    if (tone !== 'green') {
      const fix = fixFor(kernel, c.id);
      if (fix) r.fix = fix;
    }
    return r;
  } catch (err) {
    return {
      id: c.id,
      source: 'health',
      tone: 'grey',
      title: titleOf(c),
      message: 'This check could not run',
      lens: [`health check ${c.id}`, String(err)],
    };
  }
}

const RANK: Record<DoctorTone, number> = { red: 0, amber: 1, grey: 2, green: 3 };

export async function runDoctorReport(kernel: Kernel): Promise<DoctorReport> {
  const runner = kernel.use<DoctorRunner>(DOCTOR_SERVICE);
  const results: DoctorResult[] = [];
  if (runner) {
    try {
      for (const f of await runner.run()) results.push(fromFinding(kernel, f));
    } catch (err) {
      results.push({
        id: 'doctor',
        source: 'doctor',
        tone: 'grey',
        title: 'Server checks',
        message: 'The server checks could not run',
        lens: [String(err)],
      });
    }
  }
  for (const c of kernel.health) {
    if (c.weight === 0) continue;
    results.push(await fromHealth(kernel, c));
  }
  // Worst first; stable within a tone.
  const sorted = results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RANK[a.r.tone] - RANK[b.r.tone] || a.i - b.i)
    .map((x) => x.r);
  const counts = { green: 0, amber: 0, red: 0, grey: 0 };
  for (const r of sorted) counts[r.tone]++;
  return { at: kernel.ports.clock.now(), results: sorted, counts, fullChecks: !!runner };
}
