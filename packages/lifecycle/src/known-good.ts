// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Safe mode support (§6.11): after a healthy boot — no critical health result
 * for `healthySeconds` (default 5 minutes) — mark the running config as
 * known-good via `admin.config.markKnownGood()` so `beamhop --safe` can fall
 * back to it. Never marks while booted in safe mode.
 */
import type { LifecycleRuntime } from './runtime.ts';
import { COL } from './settings.ts';

interface KnownGoodService {
  markKnownGood?(target?: unknown): Promise<unknown> | unknown;
}

export type KnownGoodState = 'waiting' | 'marked' | 'skipped';

export class KnownGoodMarker {
  private healthySince: number;
  state: KnownGoodState = 'waiting';

  constructor(private readonly rt: LifecycleRuntime) {
    this.healthySince = rt.bootAt;
  }

  /** True when any registered health check reports critical (failing checks are ignored). */
  async anyCritical(): Promise<boolean> {
    for (const check of this.rt.kernel.health) {
      try {
        if ((await check.run(null)).status === 'critical') return true;
      } catch {
        // A broken check is not evidence of a broken boot.
      }
    }
    return false;
  }

  /** One check; returns the state after it. */
  async tick(): Promise<KnownGoodState> {
    if (this.state !== 'waiting') return this.state;
    const cfg = this.rt.settings().knownGood;
    if (!cfg.enabled) return this.state;
    if (this.rt.runtimeInfo()?.safe) {
      this.state = 'skipped';
      return this.state;
    }
    const svc = this.rt.kernel.use<KnownGoodService>('admin.config');
    if (!svc?.markKnownGood) return this.state;
    const now = this.rt.ports.clock.now();
    if (await this.anyCritical()) {
      this.healthySince = now;
      return this.state;
    }
    if (now - this.healthySince < cfg.healthySeconds) return this.state;
    const revision = await svc.markKnownGood();
    this.state = 'marked';
    await this.rt.ports.docs.put(COL.boot, 'known-good', {
      at: now,
      bootAt: this.rt.bootAt,
      ...(typeof revision === 'number' ? { revision } : {}),
    });
    this.rt.log('info', 'settings marked as known-good after a healthy start', { revision });
    return this.state;
  }
}
