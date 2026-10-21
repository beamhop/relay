// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Public pages (§11): landing page, self-service portal and status page,
 * server-rendered with Hono JSX. Each surface follows `relay.public.*` and
 * answers 404 when disabled (private-only mode, §12.10).
 *
 * Exposes `kernel.use<PublicWebService>('public-web')` so the alerts module can
 * open incidents, and auto-subscribes to `kernel.use('alerts').onAlert` when present.
 */
import { type Kernel, type Notification, defineModule } from '@beamhop/core';
import { createAccountActions } from './account.ts';
import { PUBLIC_WEB_MODULE_ID, PublicWebConfigSchema } from './config.ts';
import { type Incident, IncidentStore, createIncidentActions } from './incidents.ts';
import { registerRoutes } from './routes.tsx';

export * from './account.ts';
export * from './config.ts';
export * from './incidents.ts';
export { encodeQr, qrSvg, type QrCode } from './qr.ts';
export {
  bech32Hex,
  consumeChallenge,
  issueChallenge,
  npub,
  readSession,
  signSession,
  verifyNip98,
  COOKIE as PORTAL_COOKIE,
  NIP98_KIND,
} from './session.ts';
export { levelOf, type StatusLevel } from './status.ts';
export { LOCALES, type StringKey, type Strings, pickLocale, translator } from './strings.ts';
export { surfaceOf, parseVanishRequest } from './routes.tsx';
export { uptimeDays, type InsightsUptime, type UptimeDay } from './uptime.ts';

export interface PublicWebService {
  readonly incidents: IncidentStore;
  /** Open (or reuse) an incident for a critical alert. Non-critical alerts are ignored. */
  incidentFromAlert(n: Notification & { key?: string }): Promise<Incident[]>;
}

/** Optional contract of the alerts module (duck-typed). */
export interface AlertsHook {
  onAlert?(handler: (n: Notification & { key?: string }) => void): () => void;
}

const state = new WeakMap<Kernel, { svc: PublicWebService; unsubscribe?: () => void }>();

export const publicWebModule = defineModule({
  id: PUBLIC_WEB_MODULE_ID,
  configSchema: PublicWebConfigSchema,
  register(kernel) {
    const incidents = new IncidentStore(kernel.ports);
    const svc: PublicWebService = {
      incidents,
      incidentFromAlert: (n) =>
        incidents.fromAlert(
          n,
          kernel.config().relays.map((r) => r.id),
        ),
    };
    state.set(kernel, { svc });
    kernel.provide(PUBLIC_WEB_MODULE_ID, svc);
    for (const a of createIncidentActions(kernel, incidents)) kernel.actions.register(a);
    for (const a of createAccountActions(kernel)) kernel.actions.register(a);
    registerRoutes({ kernel, incidents, bootedAt: kernel.ports.clock.now() });
  },
  start(kernel) {
    const entry = state.get(kernel);
    const alerts = kernel.use<AlertsHook>('alerts');
    if (!entry || !alerts?.onAlert) return;
    entry.unsubscribe = alerts.onAlert((n) => {
      entry.svc
        .incidentFromAlert(n)
        .catch((err) =>
          kernel.bus.emit('error', { source: 'public-web.alerts', message: String(err) }),
        );
    });
  },
  stop(kernel) {
    state.get(kernel)?.unsubscribe?.();
  },
});

export default publicWebModule;
