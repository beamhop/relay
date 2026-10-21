// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-tap update progress (§14) as a small state machine. The server keeps
 * the authoritative phase (`system.update-status`); the app polls it and adds
 * what only the client knows: the server is offline while it restarts, and
 * when it has been gone too long.
 */
import type { UpdatePhase, UpdateStatus } from './types.ts';

export type FlowStage = 'idle' | 'running' | 'offline' | 'done' | 'failed' | 'rolled-back';

export interface UpdateFlowState {
  stage: FlowStage;
  phase: UpdatePhase;
  status: UpdateStatus | null;
  /** Index into STEPS of the furthest step reached (for the failed mark). */
  reached: number;
  /** Unix ms when polls started failing. */
  offlineSince?: number;
  misses: number;
  /** Client-side failure text (server gone too long). */
  error?: string;
}

export type FlowEvent =
  | { type: 'started'; status: UpdateStatus }
  | { type: 'status'; status: UpdateStatus; now: number }
  | { type: 'poll-failed'; now: number }
  | { type: 'reset' };

export const STEPS = ['backup', 'download', 'verify', 'install', 'restart', 'check'] as const;
export type StepId = (typeof STEPS)[number];
export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

/** Polls in a row that may fail before a running update counts as offline. */
export const MISSES_BEFORE_OFFLINE = 3;
/** How long the server may be away during a restart (ms). */
export const OFFLINE_TIMEOUT_MS = 3 * 60_000;

const PHASE_STEP: Record<UpdatePhase, number> = {
  idle: -1,
  'backing-up': 0,
  downloading: 1,
  verifying: 2,
  installing: 3,
  restarting: 4,
  checking: 5,
  done: STEPS.length,
  failed: -1,
  'rolled-back': -1,
};

const RUNNING: readonly UpdatePhase[] = [
  'backing-up',
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'checking',
];

function stageOf(phase: UpdatePhase): FlowStage {
  if (RUNNING.includes(phase)) return 'running';
  if (phase === 'done' || phase === 'failed' || phase === 'rolled-back') return phase;
  return 'idle';
}

/** State for a status loaded when the screen opens (an update may already be running). */
export function initialState(status: UpdateStatus | null): UpdateFlowState {
  const phase = status?.phase ?? 'idle';
  return {
    stage: stageOf(phase),
    phase,
    status,
    reached: Math.max(0, PHASE_STEP[phase]),
    misses: 0,
  };
}

export function reduce(s: UpdateFlowState, e: FlowEvent): UpdateFlowState {
  switch (e.type) {
    case 'reset':
      return initialState(null);
    case 'started':
      return {
        stage: 'running',
        phase: e.status.phase,
        status: e.status,
        reached: Math.max(0, PHASE_STEP[e.status.phase]),
        misses: 0,
      };
    case 'status': {
      const phase = e.status.phase;
      // A stale "done/failed" from a previous update must not end a fresh start.
      const stage = stageOf(phase);
      const reached = Math.max(s.reached, PHASE_STEP[phase]);
      return { stage, phase, status: e.status, reached, misses: 0 };
    }
    case 'poll-failed': {
      if (s.stage !== 'running' && s.stage !== 'offline') return s;
      const misses = s.misses + 1;
      const expected = s.phase === 'restarting' || s.phase === 'installing';
      if (s.stage === 'running' && !expected && misses < MISSES_BEFORE_OFFLINE)
        return { ...s, misses };
      const offlineSince = s.offlineSince ?? e.now;
      if (e.now - offlineSince > OFFLINE_TIMEOUT_MS)
        return {
          ...s,
          stage: 'failed',
          misses,
          offlineSince,
          error: 'gone',
        };
      return {
        ...s,
        stage: 'offline',
        phase: 'restarting',
        reached: Math.max(s.reached, PHASE_STEP.restarting),
        misses,
        offlineSince,
      };
    }
  }
}

/** Step list for the progress view. */
export function steps(s: UpdateFlowState): Array<{ id: StepId; status: StepStatus }> {
  const current =
    s.stage === 'offline'
      ? PHASE_STEP.restarting
      : s.stage === 'done'
        ? STEPS.length
        : s.stage === 'running'
          ? PHASE_STEP[s.phase]
          : -1;
  return STEPS.map((id, i) => {
    let status: StepStatus = 'pending';
    if (s.stage === 'failed' || s.stage === 'rolled-back') {
      if (i < s.reached) status = 'done';
      else if (i === s.reached) status = 'failed';
    } else if (i < current) status = 'done';
    else if (i === current) status = 'active';
    return { id, status };
  });
}

/** Download percentage while downloading/verifying (undefined otherwise). */
export function percent(s: UpdateFlowState): number | undefined {
  const p = s.status?.progress;
  if (!p?.total || (s.phase !== 'downloading' && s.phase !== 'verifying')) return undefined;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

/** Milliseconds until the next status poll; null = stop polling. */
export function pollDelay(s: UpdateFlowState): number | null {
  if (s.stage === 'running') return s.phase === 'checking' ? 2000 : 1000;
  if (s.stage === 'offline') return 2000;
  return null;
}

/** "Go back" stays offered until the next update: whenever a previous version is kept. */
export function canRollback(s: UpdateFlowState): boolean {
  return !!s.status?.previousVersion && s.stage !== 'running' && s.stage !== 'offline';
}
