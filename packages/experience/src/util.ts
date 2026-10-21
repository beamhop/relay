// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ActionContext, Kernel, Principal, RelayId } from '@beamhop/core';

export const MODULE_ID = 'experience';

/** DocStore collections owned by this module. */
export const COL = {
  /** Per-admin dismiss/snooze/approved state of inbox cards (key = principal id). */
  cardState: 'experience.card-state',
  /** Setup checklist bookkeeping (key = `checklist`). */
  checklist: 'experience.checklist',
  /** Last "Test my relay" result per relay (key = relay id). */
  testRuns: 'experience.test-runs',
  /** Weekly admin time per principal (key = `<principalId>|<weekStart>`). Local only. */
  adminTime: 'experience.admin-time',
} as const;

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

/** Thin error type the admin API maps to a plain message (duck-typed `status`/`code`). */
export class ExperienceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly technical?: string,
  ) {
    super(message);
  }
}

export function relayIdsOf(kernel: Kernel, relayId: RelayId | null | undefined): RelayId[] {
  return relayId ? [relayId] : kernel.config().relays.map((r) => r.id);
}

/** Context for running another action on behalf of the same principal. */
export function childContext(ctx: ActionContext, relayId: RelayId | null): ActionContext {
  const out: ActionContext = { principal: ctx.principal, relayId, ports: ctx.ports };
  if (ctx.reason) out.reason = ctx.reason;
  return out;
}

/** Principals that are not people (system, file sync) never count as admin time. */
export function isHuman(p: Pick<Principal, 'id'> | string): boolean {
  const id = typeof p === 'string' ? p : p.id;
  return id !== 'system' && !id.startsWith('file:');
}

/** Serialize async writes (per process) so read-modify-write cycles never interleave. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => {});
    return p;
  }
  idle(): Promise<unknown> {
    return this.tail;
  }
}
