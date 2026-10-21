// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notification routing (installed via `kernel.setNotifier`).
 *
 * 1. Severity gate: notifications below `minSeverity` (default warning) are
 *    not pushed — they wait for the digest ("only when needed", §6.9).
 * 2. On-call: if `alerts.oncall/schedule` has a rotation, only the on-duty
 *    admin's channels receive it (web push goes to that admin's devices).
 *    Without a schedule every configured channel receives it.
 * 3. Per-channel minimum severity (`channelSeverity`).
 */
import type { BeamhopConfig, Kernel, Notification, Notifier } from '@beamhop/core';
import { type AlertsModuleConfig, SEVERITY_RANK, type Severity } from './config.ts';
import {
  DiscordNotifier,
  EmailNotifier,
  type FetchLike,
  NostrDmNotifier,
  type RelayPublisher,
  SlackNotifier,
  TelegramNotifier,
  WebPushNotifier,
  emailTransportFor,
} from './notifiers.ts';

export type ChannelConfig = BeamhopConfig['alerts']['channels'][number];

export const ONCALL_COLLECTION = 'alerts.oncall';

export interface OnCallSchedule {
  /** Unix seconds when rotation slot 0 starts. */
  startAt: number;
  periodDays: number;
  rotation: Array<{ principalId: string; channels: string[] }>;
}

export function onDuty(
  s: OnCallSchedule | null,
  now: number,
): OnCallSchedule['rotation'][number] | null {
  if (!s || s.rotation.length === 0) return null;
  const period = Math.max(1, s.periodDays) * 86400;
  const idx = Math.floor((now - s.startAt) / period);
  const n = s.rotation.length;
  return s.rotation[((idx % n) + n) % n] ?? null;
}

export interface Target {
  channel: ChannelConfig;
  recipient: string;
}

export interface RouterDeps {
  kernel: Kernel;
  config(): AlertsModuleConfig;
  fetch: FetchLike;
  publish?: RelayPublisher;
}

export interface DeliveryResult {
  channelId: string;
  ok: boolean;
  error?: string;
}

export class Router {
  constructor(private d: RouterDeps) {}

  notifierFor(c: ChannelConfig): Notifier {
    const f = this.d.fetch;
    switch (c.type) {
      case 'telegram':
        return new TelegramNotifier(f, c.botToken);
      case 'discord':
        return new DiscordNotifier(f);
      case 'slack':
        return new SlackNotifier(f);
      case 'email':
        return new EmailNotifier(emailTransportFor(c.smtpUrl, f), this.d.config().email.from);
      case 'nostr-dm':
        return new NostrDmNotifier(
          this.d.kernel,
          () => this.d.config().nostrDm.relays,
          ...(this.d.publish ? [this.d.publish] : []),
        );
      case 'webpush':
        return new WebPushNotifier(this.d.kernel, f, () => this.vapidSubject());
    }
  }

  vapidSubject(): string {
    const cfg = this.d.config().vapidSubject;
    if (cfg) return cfg;
    const host = this.d.kernel.config().relays[0]?.hosts[0];
    return host ? `https://${host}` : 'mailto:admin@localhost';
  }

  recipientFor(c: ChannelConfig, principalId: string | null): string {
    switch (c.type) {
      case 'telegram':
        return c.chatId;
      case 'discord':
      case 'slack':
        return c.webhookUrl;
      case 'email':
        return c.to;
      case 'nostr-dm':
        return c.pubkey;
      case 'webpush':
        return principalId ?? '*';
    }
  }

  async targets(severity: Severity): Promise<Target[]> {
    const k = this.d.kernel;
    const channels = k.config().alerts.channels;
    const schedule = await k.ports.docs.get<OnCallSchedule>(ONCALL_COLLECTION, 'schedule');
    const duty = onDuty(schedule, k.ports.clock.now());
    const chosen = duty ? channels.filter((c) => duty.channels.includes(c.id)) : channels;
    const minPer = this.d.config().channelSeverity;
    return chosen
      .filter((c) => SEVERITY_RANK[severity] >= SEVERITY_RANK[minPer[c.id] ?? 'info'])
      .map((c) => ({ channel: c, recipient: this.recipientFor(c, duty?.principalId ?? null) }));
  }

  /** Deliver to explicit targets; failures are reported, never thrown. */
  async deliver(n: Notification, targets: Target[]): Promise<DeliveryResult[]> {
    return Promise.all(
      targets.map(async (t): Promise<DeliveryResult> => {
        try {
          await this.notifierFor(t.channel).send(n, t.recipient);
          return { channelId: t.channel.id, ok: true };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.d.kernel.bus.emit('error', {
            ...(n.relayId ? { relayId: n.relayId } : {}),
            source: `alerts.notify.${t.channel.type}`,
            message: error,
          });
          return { channelId: t.channel.id, ok: false, error };
        }
      }),
    );
  }

  /** The kernel notifier: severity gate + on-call routing. */
  async route(n: Notification): Promise<DeliveryResult[]> {
    if (SEVERITY_RANK[n.severity] < SEVERITY_RANK[this.d.config().minSeverity]) return [];
    return this.deliver(n, await this.targets(n.severity));
  }
}
