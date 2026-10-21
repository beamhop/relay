// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Background work on Workers. A Worker isolate may cancel promises that are still running
 * after the response is returned unless they are passed to `ctx.waitUntil`. Modules hand
 * such work (SIEM log appends, audit writes) to the `runtime.background` service; the
 * Worker drains it through `waitUntil` at the end of every request and cron run.
 */

/** Service name modules look up with `kernel.use(BACKGROUND_SERVICE)`. */
export const BACKGROUND_SERVICE = 'runtime.background';

export class BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  /** Track `p` until it settles. Rejections are swallowed here (callers log their own). */
  waitUntil(p: Promise<unknown>): void {
    const tracked = p.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(tracked);
    void tracked.then(() => this.pending.delete(tracked));
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves once everything tracked so far (and anything it started) has settled. */
  async drain(): Promise<void> {
    for (let i = 0; i < 100 && this.pending.size > 0; i++) {
      await Promise.all([...this.pending]);
    }
  }
}
