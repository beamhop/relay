// SPDX-License-Identifier: AGPL-3.0-or-later
/** Safe settings changes (§6.3): propose → plain-language diff sheet → apply → undo toast. */
import type { ApiError } from '../api/client.ts';
import type { CommitResult, ConfigProposal } from '../api/types.ts';
import { m } from '../paraglide/messages.js';
import { announce, asApiError } from './actions.svelte.ts';
import { app } from './app.svelte.ts';
import { toasts } from './toasts.svelte.ts';

export interface ConfigChange {
  merge?: unknown;
  patch?: unknown[];
  summary?: string;
}

export interface Simulation {
  summary: string;
}

interface Pending {
  proposal: ConfigProposal;
  change: ConfigChange;
  relay: boolean;
  simulation?: Simulation | null;
  simulating?: boolean;
  phase: 'review' | 'applying' | 'error';
  error: ApiError | null;
  onApplied?: (r: CommitResult) => void;
}

class ConfigFlow {
  current = $state<Pending | null>(null);
  busy = $state(false);
  /** Bumped after every applied (or undone) change: screens derived from config refresh on it. */
  applied = $state(0);

  /** Validate and describe a change. Returns false (with a toast) when nothing would change. */
  async propose(
    change: ConfigChange,
    opts: { relay: boolean; onApplied?: (r: CommitResult) => void },
  ): Promise<boolean> {
    this.busy = true;
    try {
      const proposal = await app.api.propose(change, opts.relay);
      if (!proposal.changed) {
        toasts.show({ message: m.settings_nothing_changed(), kind: 'info' });
        return false;
      }
      const p: Pending = { proposal, change, relay: opts.relay, phase: 'review', error: null };
      if (opts.onApplied) p.onApplied = opts.onApplied;
      this.current = p;
      return true;
    } catch (err) {
      const e = asApiError(err);
      toasts.error(
        e.message,
        e.issues?.map((i) => `${i.path}: ${i.message}`).join('\n') ?? e.technical,
      );
      return false;
    } finally {
      this.busy = false;
    }
  }

  async apply(): Promise<CommitResult | null> {
    const cur = this.current;
    if (!cur) return null;
    cur.phase = 'applying';
    try {
      const r = await app.api.commit(cur.proposal.id, cur.relay);
      // Close the review sheet first, so the undo toast never sits over its buttons.
      if (this.current === cur) this.current = null;
      this.applied++;
      const onApplied = cur.onApplied;
      announce(
        { summary: r.revision.summary || m.settings_saved(), ...(r.undo ? { undo: r.undo } : {}) },
        () => {
          this.applied++;
          onApplied?.(r);
        },
      );
      onApplied?.(r);
      return r;
    } catch (err) {
      cur.error = asApiError(err);
      cur.phase = 'error';
      return null;
    }
  }

  /** Dry-run the pending change against recent traffic (`experience.simulate-change`). */
  async simulate(): Promise<void> {
    const cur = this.current;
    const def = app.action('experience.simulate-change');
    if (!cur || !def || !app.relayId) return;
    cur.simulating = true;
    try {
      const input: Record<string, unknown> = { target: cur.relay ? 'relay' : 'node', hours: 24 };
      if (cur.change.patch) input.patch = cur.change.patch;
      else input.merge = cur.change.merge;
      const r = await app.api.run<unknown>(def.id, input, def.scope);
      cur.simulation = { summary: r.summary };
    } catch (err) {
      cur.simulation = { summary: asApiError(err).message };
    } finally {
      cur.simulating = false;
    }
  }

  cancel(): void {
    this.current = null;
  }
}

export const configFlow = new ConfigFlow();
