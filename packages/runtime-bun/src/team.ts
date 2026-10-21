// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team app (`packages/team-client`, a Flotilla fork) served at `/app/`.
 *
 * Only when `modules.team.enabled` is true (default false; the organization
 * persona switches it on). Static files come from the embedded `team` asset
 * bundle (compiled binary) or a build directory on disk (dev:
 * `BEAMHOP_TEAM_DIR` or `packages/team-client/build`).
 *
 * `/app/config.json` is generated from `modules.team`:
 *   { homeRelay?, allowedRelays: string[], features: { sso, directory, escrowNotice } }
 * Enterprise modules may adjust it through the hook point
 * `kernel.provide('team.config', (base, ctx) => next | Promise<next>)`; a hook
 * that throws leaves the base config in place.
 */
import type { Kernel, RouteContext } from '@beamhop/core';
import { type AssetServer, createAssetServer } from './assets.ts';

export const TEAM_MOUNT = '/app';
export const TEAM_CONFIG_HOOK = 'team.config';

export interface TeamFeatures {
  sso: boolean;
  directory: boolean;
  escrowNotice: boolean;
}

export interface TeamClientConfig {
  homeRelay?: string;
  allowedRelays: string[];
  features: TeamFeatures;
}

export interface TeamConfigContext {
  /** Virtual relay the request was routed to, if any. */
  relayId?: string;
  /** Public base URL of that relay. */
  publicUrl?: string;
}

/** `kernel.use('team.config')`: adjust the Team app config (e.g. SSO, directory). */
export type TeamConfigHook = (
  base: TeamClientConfig,
  ctx: TeamConfigContext,
) => TeamClientConfig | Promise<TeamClientConfig>;

interface TeamModuleConfig {
  enabled: boolean;
  homeRelay?: string;
  allowedRelays: string[];
  features: TeamFeatures;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Defensive read of `config.modules.team` (unknown keys ignored, wrong types → defaults). */
export function teamModuleConfig(raw: unknown): TeamModuleConfig {
  const r = isRecord(raw) ? raw : {};
  const f = isRecord(r.features) ? r.features : {};
  const bool = (v: unknown) => v === true;
  const out: TeamModuleConfig = {
    enabled: bool(r.enabled),
    allowedRelays: Array.isArray(r.allowedRelays)
      ? r.allowedRelays.filter((u): u is string => typeof u === 'string' && u !== '')
      : [],
    features: {
      sso: bool(f.sso),
      directory: bool(f.directory),
      escrowNotice: bool(f.escrowNotice),
    },
  };
  if (typeof r.homeRelay === 'string' && r.homeRelay) out.homeRelay = r.homeRelay;
  return out;
}

export function teamEnabled(kernel: Kernel): boolean {
  return teamModuleConfig(kernel.config().modules.team).enabled;
}

/** The config.json body for the Team app (after the `team.config` hook). */
export async function teamClientConfig(
  kernel: Kernel,
  ctx: TeamConfigContext = {},
): Promise<TeamClientConfig> {
  const m = teamModuleConfig(kernel.config().modules.team);
  const base: TeamClientConfig = {
    ...(m.homeRelay ? { homeRelay: m.homeRelay } : {}),
    allowedRelays: m.allowedRelays,
    features: m.features,
  };
  const hook = kernel.use<TeamConfigHook>(TEAM_CONFIG_HOOK);
  if (typeof hook !== 'function') return base;
  try {
    const next = await hook(structuredClone(base), ctx);
    return isRecord(next) ? next : base;
  } catch (err) {
    kernel.ports.logger.log('warn', 'team.config hook failed; serving the base config', {
      error: String(err),
    });
    return base;
  }
}

export interface TeamApp {
  readonly assets: AssetServer;
  /** Response for `/app/*`, or null to fall through (disabled or not a Team path). */
  serve(req: Request, pathname: string, ctx?: TeamConfigContext): Promise<Response | null>;
}

export function createTeamApp(kernel: Kernel, opts: { dir?: string } = {}): TeamApp {
  const assets = createAssetServer({ mount: TEAM_MOUNT, dir: opts.dir, bundle: 'team' });
  return {
    assets,
    async serve(req, pathname, ctx = {}) {
      if (pathname !== TEAM_MOUNT && !pathname.startsWith(`${TEAM_MOUNT}/`)) return null;
      if (!teamEnabled(kernel)) return null;
      if (pathname === `${TEAM_MOUNT}/config.json`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return null;
        const body = JSON.stringify(await teamClientConfig(kernel, ctx));
        return new Response(req.method === 'HEAD' ? null : body, {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }
      if (pathname === TEAM_MOUNT) {
        return new Response(null, { status: 308, headers: { location: `${TEAM_MOUNT}/` } });
      }
      return assets.serve(req, pathname);
    },
  };
}

/** Route context for the hook from a resolved relay route (if any). */
export function teamContext(route: RouteContext | undefined): TeamConfigContext {
  if (!route?.relayId) return {};
  return { relayId: route.relayId, publicUrl: route.publicUrl };
}
