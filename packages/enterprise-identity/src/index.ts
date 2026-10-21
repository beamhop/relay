// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/enterprise-identity — company sign-in (OIDC: Google Workspace,
 * Microsoft Entra ID, generic), SCIM 2.0 provisioning, Google directory sync,
 * identity ↔ npub binding, group mapping, offboarding and company identity
 * on Nostr (NIP-05, profiles, NIP-29 channels, directory). PLAN §12.1–§12.6.
 *
 * Isolation (§12.0): the module registers NOTHING (no routes, hooks, actions,
 * access resolvers, jobs) unless `config.modules['enterprise-identity']` is
 * present and non-empty; runtimes additionally load it only when that key exists.
 */
import { type AuthProvider, type Kernel, defineModule } from '@beamhop/core';
import { bindingAccessResolver } from './access.ts';
import { createActions } from './actions.ts';
import {
  type EnterpriseIdentityConfig,
  EnterpriseIdentityConfigSchema,
  MODULE_ID,
  parseEnterpriseConfig,
} from './config.ts';
import { GoogleDirectorySync } from './google.ts';
import { type FetchLike, OidcClient } from './oidc.ts';
import { defaultLabel, registerRoutes } from './routes.ts';
import { EnterpriseIdentityService } from './service.ts';
import { services } from './services.ts';
import { TeamSessions } from './sessions.ts';
import { IdentityStore } from './store.ts';

export * from './config.ts';
export * from './services.ts';
export * from './store.ts';
export { ACCESS_RESOLVER_ID, bindingAccessResolver } from './access.ts';
export { resolveEntitlements, entitlementsOf, ROLE_RANK, type Entitlements } from './mapping.ts';
export { OidcClient, issuerOf, type IdClaims, type FetchLike } from './oidc.ts';
export {
  applyPatch,
  createScimToken,
  parseFilter,
  parsePath,
  scimToFields,
  userToScim,
  SCIM_BASE,
} from './scim.ts';
export {
  GoogleDirectorySync,
  DIRECTORY_SCOPES,
  GOOGLE_TOKEN_URL,
  DIRECTORY_API,
} from './google.ts';
export type { SyncReport, GoogleUser, GoogleGroup } from './google.ts';
export {
  EnterpriseIdentityService,
  IdentityError,
  LINK_KINDS,
  type OffboardReport,
  type DirectoryPerson,
  type KeyDestructionRecord,
} from './service.ts';
export { TeamSessions, TEAM_COOKIE, STATE_COOKIE } from './sessions.ts';
export { setupSteps } from './actions.ts';

/** Service name: `kernel.use<EnterpriseIdentityService>('enterprise.identity')`. */
export const IDENTITY_SERVICE = 'enterprise.identity';
export const GOOGLE_SYNC_JOB = 'enterprise.google-sync';
export const MAINTENANCE_JOB = 'enterprise.maintenance';

export interface EnterpriseIdentityOptions {
  /** Outbound fetch (IdP discovery/token/JWKS, Google APIs). Tests inject mocks. */
  fetch?: FetchLike;
}

interface Runtime {
  identity: EnterpriseIdentityService;
  google: GoogleDirectorySync;
}

const runtimes = new WeakMap<Kernel, Runtime>();

/** True when the module section was actually written by an admin (isolation guard). */
export function isConfigured(kernel: Kernel): boolean {
  const raw = kernel.config().modules[MODULE_ID];
  if (raw === undefined) return false;
  const cfg = parseEnterpriseConfig(raw);
  return cfg.configured && cfg.enabled;
}

export function createEnterpriseIdentityModule(opts: EnterpriseIdentityOptions = {}) {
  return defineModule({
    id: MODULE_ID,
    configSchema: EnterpriseIdentityConfigSchema,
    // Hot-swappable: `modules.enable { id: 'enterprise-identity' }` loads it without a restart.
    optional: true,
    register(kernel) {
      if (!isConfigured(kernel)) return;
      const fetchImpl: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
      let memo: { raw: unknown; parsed: EnterpriseIdentityConfig } | null = null;
      const cfg = (): EnterpriseIdentityConfig => {
        const raw = kernel.config().modules[MODULE_ID];
        if (!memo || memo.raw !== raw) memo = { raw, parsed: parseEnterpriseConfig(raw) };
        return memo.parsed;
      };
      const store = new IdentityStore(kernel);
      const sessions = new TeamSessions(kernel, () => cfg().teamSessionTtlSeconds);
      const identity = new EnterpriseIdentityService(
        kernel,
        cfg,
        store,
        sessions,
        services(kernel),
      );
      const oidc = new OidcClient(fetchImpl, () => kernel.ports.clock.nowMs());
      const google = new GoogleDirectorySync(identity, fetchImpl);

      // Front of the chain: revocations and bindings win over allowlists/WoT.
      kernel.access.unshift(bindingAccessResolver(kernel, store, cfg));
      const provider: AuthProvider = {
        id: 'enterprise-sso',
        get label() {
          const first = cfg().idps.find((i) => i.audiences.includes('admin'));
          return first ? (first.label ?? defaultLabel(first)) : 'Sign in with your company account';
        },
        // Admin SSO is a redirect flow (/api/v1/sso/:idp/start?audience=admin) that ends in a
        // regular admin session; this entry only advertises the button on the login screen.
        async authenticate() {
          return null;
        },
      };
      kernel.authProviders.push(provider);
      for (const a of createActions({ kernel, identity, oidc, google })) kernel.actions.register(a);
      registerRoutes({ kernel, identity, oidc });
      kernel.provide(IDENTITY_SERVICE, identity);
      kernel.ui.push(
        {
          path: '/settings/company',
          title: 'Company sign-in',
          placement: 'settings-section',
          chunk: 'enterprise-identity',
        },
        {
          path: '/people/company',
          title: 'Company groups',
          placement: 'people-section',
          chunk: 'enterprise-identity',
        },
      );
      runtimes.set(kernel, { identity, google });
    },
    start(kernel) {
      const rt = runtimes.get(kernel);
      if (!rt) return;
      const { identity, google } = rt;
      const sched = kernel.ports.scheduler;
      const log = (msg: string, err: unknown) =>
        kernel.ports.logger.log('warn', msg, { module: MODULE_ID, err: String(err) });
      sched.every(MAINTENANCE_JOB, 3600, async () => {
        try {
          await identity.processKeyDestruction();
          await identity.sessions.gc();
          await identity.syncGroupChannels();
        } catch (err) {
          log('enterprise maintenance failed', err);
        }
      });
      if (google.configured()) {
        const minutes = identity.cfg().google.directorySync.intervalMinutes;
        sched.every(GOOGLE_SYNC_JOB, minutes * 60, async () => {
          try {
            await google.run();
          } catch (err) {
            log('google directory sync failed', err);
          }
        });
      }
    },
    stop(kernel) {
      kernel.ports.scheduler.cancel(MAINTENANCE_JOB);
      kernel.ports.scheduler.cancel(GOOGLE_SYNC_JOB);
      runtimes.delete(kernel);
    },
  });
}

export const enterpriseIdentityModule = createEnterpriseIdentityModule();
export default enterpriseIdentityModule;

/** Test/ops helper: the running service and Google sync for a kernel. */
export function enterpriseRuntime(kernel: Kernel): Runtime | undefined {
  return runtimes.get(kernel);
}
