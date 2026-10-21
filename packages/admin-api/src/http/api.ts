import {
  type Kernel,
  type KernelEnv,
  type Permission,
  type Principal,
  type RelayId,
  can,
} from '@beamhop/core';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AuditLog } from '../audit.ts';
import type { Directory } from '../auth/directory.ts';
import type { PasskeyService } from '../auth/passkeys.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { TokenService } from '../auth/tokens.ts';
import type { ConfigService } from '../config/service.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Route plumbing: an OpenAPIHono sub-app mounted at `/api/v1`, fleet-ready
 * paths (`/nodes/{node}/…` and `/nodes/{node}/relays/{relay}/…`), auth
 * middleware that sets `principal`, RBAC guards, zod body validation and
 * uniform plain-language errors.
 */
import type { AdminApiConfig } from '../settings.ts';
import type { UndoStore } from '../undo.ts';
import { HttpError, errorBody } from '../util.ts';

export interface Deps {
  kernel: Kernel;
  dir: Directory;
  sessions: SessionService;
  passkeys: PasskeyService;
  tokens: TokenService;
  config: ConfigService;
  audit: AuditLog;
  undo: UndoStore;
  settings(): AdminApiConfig;
}

export type Api = OpenAPIHono<KernelEnv>;
export type Ctx = Context<KernelEnv>;
export type Guard = Permission | 'public' | 'authenticated';

export interface OpInfo<B> {
  body: B;
  relayId: RelayId | null;
  principal: Principal | undefined;
}

export interface OpDef<S extends z.ZodType | undefined> {
  method: 'get' | 'post' | 'put' | 'delete';
  /** Path below the scope prefix, OpenAPI style (`/config/revisions/{rev}`). */
  path: string;
  /** node: `/nodes/{node}…`; relay: `…/relays/{relay}…`; both: registered twice; root: as-is. */
  scope: 'node' | 'relay' | 'both' | 'root';
  summary: string;
  description?: string;
  tags: string[];
  guard: Guard;
  body?: S;
  query?: Record<string, string>;
  /** Response content type for docs (default JSON). */
  produces?: string;
}

const NODE = '/nodes/{node}';
const RELAY = '/nodes/{node}/relays/{relay}';

export function principalOf(c: Ctx): Principal | undefined {
  return c.get('principal');
}

export function requirePrincipal(c: Ctx): Principal {
  const p = c.get('principal');
  if (!p) throw new HttpError(401, 'unauthenticated', 'Please sign in');
  return p;
}

export function requirePermission(c: Ctx, perm: Permission, relayId: RelayId | null): Principal {
  const p = requirePrincipal(c);
  if (!can(p, perm, relayId))
    throw new HttpError(
      403,
      'forbidden',
      "You don't have permission to do this",
      `requires ${perm}${relayId ? ` on relay ${relayId}` : ' on the node'}`,
    );
  return p;
}

export function toResponse(c: Ctx, err: unknown, deps: Deps): Response {
  if (err instanceof HttpError) return c.json(errorBody(err), err.status);
  deps.kernel.ports.logger.log('error', 'admin-api handler failed', { error: String(err) });
  return c.json(
    errorBody(new HttpError(500, 'internal', 'Something went wrong on the server', String(err))),
    500,
  );
}

async function readJson(c: Ctx): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON');
  }
}

export function zodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

export function parseWith<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new HttpError(
      422,
      'invalid_input',
      'Some fields are not valid',
      r.error.message,
      zodIssues(r.error),
    );
  return r.data;
}

export function op<S extends z.ZodType | undefined = undefined>(
  api: Api,
  deps: Deps,
  def: OpDef<S>,
  handler: (
    c: Ctx,
    info: OpInfo<S extends z.ZodType ? z.infer<S> : undefined>,
  ) => Promise<Response> | Response,
): void {
  const prefixes =
    def.scope === 'root'
      ? ['']
      : def.scope === 'node'
        ? [NODE]
        : def.scope === 'relay'
          ? [RELAY]
          : [NODE, RELAY];
  for (const prefix of prefixes) {
    const oaPath = `${prefix}${def.path}`;
    const names = [...oaPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    const request: Record<string, unknown> = {};
    if (names.length)
      request.params = z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
    if (def.query)
      request.query = z.object(
        Object.fromEntries(
          Object.entries(def.query).map(([k, d]) => [k, z.string().optional().describe(d)]),
        ),
      );
    if (def.body)
      request.body = { content: { 'application/json': { schema: def.body } }, required: false };
    api.openAPIRegistry.registerPath({
      method: def.method,
      path: oaPath,
      summary: def.summary,
      description:
        def.description ??
        (def.guard === 'public' ? 'No sign-in needed.' : `Requires: ${def.guard}.`),
      tags: def.tags,
      security: def.guard === 'public' ? [] : [{ session: [] }, { token: [] }, { nip98: [] }],
      request: request as never,
      responses: {
        200: {
          description: 'OK',
          content: { [def.produces ?? 'application/json']: { schema: z.unknown() } },
        },
        401: { description: 'Not signed in' },
        403: { description: 'Not permitted' },
      },
    });
    const honoPath = oaPath.replace(/\{(\w+)\}/g, ':$1');
    api.on(def.method.toUpperCase(), honoPath, async (c) => {
      try {
        const relayId = c.req.param('relay') ?? null;
        const principal = c.get('principal');
        if (def.guard === 'authenticated') requirePrincipal(c);
        else if (def.guard !== 'public') requirePermission(c, def.guard, relayId);
        const body = def.body ? parseWith(def.body, await readJson(c)) : undefined;
        return await handler(c, {
          body: body as S extends z.ZodType ? z.infer<S> : undefined,
          relayId,
          principal,
        });
      } catch (err) {
        return toResponse(c, err, deps);
      }
    });
  }
}

export function createApi(deps: Deps): Api {
  const api = new OpenAPIHono<KernelEnv>();
  const { kernel } = deps;

  // Authenticate with every registered provider (built-ins first, SSO etc. from other modules).
  api.use('*', async (c, next) => {
    if (!c.get('principal')) {
      for (const provider of kernel.authProviders) {
        try {
          const p = await provider.authenticate(c.req.raw);
          if (p) {
            c.set('principal', p);
            break;
          }
        } catch (err) {
          kernel.ports.logger.log('warn', 'auth provider failed', {
            provider: provider.id,
            error: String(err),
          });
        }
      }
    }
    await next();
  });

  // Fleet routing: `{node}` must be this node (or the alias `self`); `{relay}` must exist.
  api.use('/nodes/:node/*', async (c, next) => {
    const node = c.req.param('node');
    if (node !== kernel.config().node.id && node !== 'self')
      return c.json(
        errorBody(
          new HttpError(
            404,
            'unknown_node',
            'That server is not part of this setup',
            `node ${node}`,
          ),
        ),
        404,
      );
    await next();
  });
  api.use('/nodes/:node/relays/:relay/*', async (c, next) => {
    const relay = c.req.param('relay');
    if (!kernel.relay(relay))
      return c.json(
        errorBody(new HttpError(404, 'unknown_relay', `There is no relay called “${relay}”`)),
        404,
      );
    await next();
  });

  api.openAPIRegistry.registerComponent('securitySchemes', 'session', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Session from /auth/nostr or /auth/passkey/*',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'token', {
    type: 'http',
    scheme: 'bearer',
    description: 'API token bh_<id>_<secret>',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'nip98', {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: 'NIP-98: `Nostr <base64 kind 27235 event>`',
  });
  return api;
}
