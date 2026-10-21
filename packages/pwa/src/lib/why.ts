// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Why?" everywhere (§6.10). Every number, alert, block and refused post can
 * ask the server (`experience.why`) for a plain cause, options and the
 * technical lens lines. Screens use `<WhyButton subject={…} />`.
 */
import { query } from './stores/actions.svelte.ts';

/** What to explain. Mirrors `WhySubject` in packages/experience/src/why.ts. */
export type WhySubject =
  | { subject: 'rejected-event'; eventId: string }
  | { subject: 'limit'; field: string; tier?: string }
  | { subject: 'health'; subsystem?: string; checkId?: string }
  | { subject: 'card'; cardId: string }
  | { subject: 'alert'; alertId: string }
  | { subject: 'metric'; metric: string; value?: number }
  | { subject: 'block'; pubkey: string };

export interface WhyOption {
  label: string;
  actionId?: string;
  input?: unknown;
  playbook?: string;
  /** App screen to open. */
  screen?: string;
}

export interface WhyAnswer {
  title: string;
  cause: string;
  options: WhyOption[];
  technical: string[];
  found: boolean;
}

export function askWhy(subject: WhySubject): Promise<WhyAnswer | null> {
  return query<WhyAnswer>('experience.why', subject);
}
