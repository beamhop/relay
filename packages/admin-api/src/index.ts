// SPDX-License-Identifier: AGPL-3.0-or-later
// tsyringe (via @simplewebauthn/server → @peculiar/x509) needs the Reflect metadata polyfill,
// which bundlers (bun --compile, Workers) do not load implicitly.
import 'reflect-metadata';
// Admin API module: auth, RBAC, config revisions, actions→routes, OpenAPI, NIP-86, audit, live SSE
import { type Kernel, defineModule } from '@beamhop/core';
import { AuditLog } from './audit.ts';
import { Directory, displayNameOf } from './auth/directory.ts';
import { gcNip98 } from './auth/nip98.ts';
import { PasskeyService } from './auth/passkeys.ts';
import { builtinProviders } from './auth/providers.ts';
import { SessionService } from './auth/sessions.ts';
import { TokenService } from './auth/tokens.ts';
import { builtinActions } from './builtin-actions.ts';
import { ConfigService } from './config/service.ts';
import { type Deps, createApi } from './http/api.ts';
import { nip86Interceptor, nip86Routes } from './http/nip86.ts';
import { openApiRoute } from './http/openapi.ts';
import { actionRoutes } from './http/routes-actions.ts';
import { authRoutes } from './http/routes-auth.ts';
import { configRoutes } from './http/routes-config.ts';
import { liveRoutes } from './http/routes-live.ts';
import { logActions } from './logs.ts';
import { moduleActions } from './modules-actions.ts';
import { type AdminApiConfig, AdminApiConfigSchema, MODULE_ID } from './settings.ts';
import { UndoStore } from './undo.ts';

export { AdminApiConfigSchema, MODULE_ID, COL } from './settings.ts';
export type { AdminApiConfig } from './settings.ts';
export type { AdminRecord, InviteRecord } from './auth/directory.ts';
export { parsePubkey, shortNpub } from './auth/directory.ts';
export { verifyNip98, NIP98_KIND } from './auth/nip98.ts';
export type { AuditEntry } from './audit.ts';
export { GENESIS, hashEntry } from './audit.ts';
export {
  type AdminConfigService,
  type ConfigProposal,
  type ConfigRevision,
  type ProposeInput,
  type RevisionInfo,
  resolveBootConfig,
  parseYamlConfig,
  toYaml,
} from './config/service.ts';
export { describeChanges } from './config/describe.ts';
export { applyPatch, diffPatch, mergePatch, type JsonPatchOp } from './config/patch.ts';
export { NIP86_METHODS, NIP86_CONTENT_TYPE, supportedMethods } from './http/nip86.ts';
export { EVENT_PERMISSIONS } from './http/routes-live.ts';
export { OPTIONAL_MODULE_TEXT, type OptionalModuleText } from './modules-actions.ts';

/** `kernel.use<AdminClaimService>('admin.claim')` — first-run claim (the runtime prints the code). */
export interface AdminClaimService {
  isClaimed(): Promise<boolean>;
  /** Current one-time claim code (stable until redeemed). Throws once claimed. */
  issueCode(): Promise<{ code: string; url?: string }>;
  /** Same as issueCode().code, or null once claimed. */
  code(): Promise<string | null>;
  /** Consume the code (normally done by the sign-in routes). */
  redeem(code: string): Promise<boolean>;
}

/** `kernel.use<AdminSessionsService>('admin.sessions')` — lets SSO modules issue admin sessions. */
export interface AdminSessionsService {
  issue(
    adminId: string,
    via: 'sso' | 'nip07' | 'nip46' | 'passkey' | 'cli',
  ): Promise<{ token: string; expiresAt: number }>;
}

const K = Symbol.for('beamhop.admin-api.deps');

export const adminApiModule = defineModule({
  id: MODULE_ID,
  configSchema: AdminApiConfigSchema,
  register(kernel: Kernel) {
    let memo: { raw: unknown; parsed: AdminApiConfig } | null = null;
    const settings = (): AdminApiConfig => {
      const raw = kernel.moduleConfig<unknown>(MODULE_ID);
      if (!memo || memo.raw !== raw) memo = { raw, parsed: AdminApiConfigSchema.parse(raw ?? {}) };
      return memo.parsed;
    };
    const ports = kernel.ports;
    const dir = new Directory(ports);
    const sessions = new SessionService(ports, () => ({
      ttlSeconds: settings().sessionTtlSeconds,
      maxAgeSeconds: settings().sessionMaxAgeSeconds,
      rotationDays: settings().keyRotationDays,
      issuer: `beamhop:${kernel.config().node.id}`,
    }));
    const passkeys = new PasskeyService(ports);
    const tokens = new TokenService(ports);
    const undo = new UndoStore(ports);
    const audit = new AuditLog(kernel);
    const config = new ConfigService({
      kernel,
      undo,
      undoWindowSeconds: () => settings().undoWindowSeconds,
      nameOf: async (id) => displayNameOf(await dir.get(id), id),
    });
    const deps: Deps = { kernel, dir, sessions, passkeys, tokens, config, audit, undo, settings };

    kernel.authProviders.push(...builtinProviders(kernel, dir, sessions, tokens));
    for (const a of builtinActions(kernel, dir, tokens)) kernel.actions.register(a);
    for (const a of moduleActions(kernel, config)) kernel.actions.register(a);
    for (const a of logActions(kernel, () => settings().logs.keep)) kernel.actions.register(a);
    audit.attach();

    const claim: AdminClaimService = {
      isClaimed: () => dir.isClaimed(),
      async issueCode() {
        const code = await dir.claimCode();
        if (!code) throw new Error('this node already has an owner');
        return { code };
      },
      code: () => dir.claimCode(),
      redeem: (code) => dir.redeemClaim(code),
    };
    const sessionsApi: AdminSessionsService = { issue: (id, via) => sessions.issue(id, via) };
    kernel.provide('admin.claim', claim);
    kernel.provide('admin.config', config);
    kernel.provide('admin.sessions', sessionsApi);
    kernel.provide('admin.directory', dir);
    kernel.provide('admin.audit', audit);

    const api = createApi(deps);
    authRoutes(api, deps);
    configRoutes(api, deps);
    actionRoutes(api, deps);
    liveRoutes(api, deps);
    nip86Routes(api, deps);
    openApiRoute(api, deps);
    kernel.http.use('*', nip86Interceptor(deps) as never);
    kernel.http.route('/api/v1', api);

    (kernel as Kernel & { [K]?: Deps })[K] = deps;
  },
  start(kernel: Kernel) {
    const deps = (kernel as Kernel & { [K]?: Deps })[K];
    if (!deps) return;
    kernel.ports.scheduler.every('admin-api.rotate-keys', 3600, async () => {
      await deps.sessions.currentKey();
    });
    kernel.ports.scheduler.every('admin-api.gc', 600, async () => {
      await Promise.all([
        deps.sessions.gc(),
        deps.passkeys.gc(),
        deps.undo.gc(),
        deps.config.gc(),
        gcNip98(kernel.ports),
      ]);
    });
  },
  stop(kernel: Kernel) {
    kernel.ports.scheduler.cancel('admin-api.rotate-keys');
    kernel.ports.scheduler.cancel('admin-api.gc');
  },
});
