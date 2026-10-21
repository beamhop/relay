// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Kernel, Notification } from '@beamhop/core';
import { type AlertsModuleConfig, AlertsModuleConfigSchema } from './config.ts';
import { type DigestContent, STATE_COLLECTION, buildDigest, digestDue } from './digest.ts';
import { type AlertListener, AlertsEngine } from './engine.ts';
import type { FetchLike, RelayPublisher } from './notifiers.ts';
import { type DeliveryResult, Router } from './router.ts';

export interface AlertsModuleOptions {
  /** fetch for all notifiers (tests inject a stub). */
  fetch?: FetchLike;
  /** Outbound relay publisher for NIP-17 DMs (tests inject a stub). */
  publish?: RelayPublisher;
}

/** Service exposed as `kernel.use<AlertsService>('alerts')`. */
export interface AlertsService {
  /**
   * Subscribe to fired alerts. Only `category: 'ops'` alerts are delivered —
   * safety/abuse alerts (e.g. media hash matches, moderation backlog) never
   * reach subscribers, so they can't leak onto public status pages.
   */
  onAlert(fn: AlertListener): () => void;
  /** Run one evaluation now. */
  evaluate(): Promise<unknown>;
  sendDigest(period?: 'daily' | 'weekly', force?: boolean): Promise<DigestContent>;
  /** Route a notification as the kernel notifier would. */
  route(n: Notification): Promise<DeliveryResult[]>;
}

export class AlertsRuntime implements AlertsService {
  readonly router: Router;
  readonly engine: AlertsEngine;

  constructor(
    readonly kernel: Kernel,
    readonly opts: AlertsModuleOptions = {},
  ) {
    this.router = new Router({
      kernel,
      config: () => this.config(),
      fetch: opts.fetch ?? ((i, init) => fetch(i, init)),
      ...(opts.publish ? { publish: opts.publish } : {}),
    });
    this.engine = new AlertsEngine(
      kernel,
      () => this.config(),
      (n) => this.router.route(n),
    );
  }

  config(): AlertsModuleConfig {
    return (
      this.kernel.moduleConfig<AlertsModuleConfig>('alerts') ?? AlertsModuleConfigSchema.parse({})
    );
  }

  onAlert(fn: AlertListener): () => void {
    return this.engine.onAlert(fn);
  }

  evaluate() {
    return this.engine.evaluate();
  }

  /** Kernel notifier: other modules' notifications are routed and (if ops) forwarded. */
  async route(n: Notification): Promise<DeliveryResult[]> {
    this.engine.forwardExternal(n);
    return this.router.route(n);
  }

  async sendDigest(period?: 'daily' | 'weekly', force = false): Promise<DigestContent> {
    const k = this.kernel;
    const now = k.ports.clock.now();
    const cadence = k.config().alerts.digest;
    const p = period ?? (cadence === 'weekly' ? 'weekly' : 'daily');
    const state = (await k.ports.docs.get<{ lastSentAt: number; seq: number }>(
      STATE_COLLECTION,
      'digest',
    )) ?? { lastSentAt: 0, seq: 0 };
    const digest = await buildDigest(k, this.engine, p, {
      now,
      tips: this.config().digestTips,
      seq: state.seq,
    });
    const targets = await this.router.targets('critical');
    await this.router.deliver(
      { severity: 'info', title: digest.title, body: digest.body, category: 'ops' },
      targets,
    );
    if (!force || targets.length)
      await k.ports.docs.put(STATE_COLLECTION, 'digest', { lastSentAt: now, seq: state.seq + 1 });
    return digest;
  }

  /** Hourly job: send the digest when due. */
  async digestTick(): Promise<DigestContent | null> {
    const k = this.kernel;
    const cadence = k.config().alerts.digest;
    const state = await k.ports.docs.get<{ lastSentAt: number }>(STATE_COLLECTION, 'digest');
    const cfg = this.config();
    if (
      !digestDue(
        cadence,
        k.ports.clock.now(),
        state?.lastSentAt ?? null,
        cfg.digestHourUtc,
        cfg.digestWeekday,
      )
    )
      return null;
    if (k.config().alerts.channels.length === 0) return null;
    return this.sendDigest(cadence === 'weekly' ? 'weekly' : 'daily');
  }
}
