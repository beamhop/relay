// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NIP-86 relay management API (JSON-RPC over HTTP, `application/nostr+json+rpc`,
 * NIP-98 auth). Standard methods map onto action registry ids; a method whose
 * action is not registered answers "unsupported". Relay name/description/icon
 * map onto the config service, so they always work.
 */
import type { ActionDef, Kernel, Principal, RelayId } from '@beamhop/core';
import type { Context } from 'hono';
import { nip98For } from '../auth/providers.ts';
import { HttpError } from '../util.ts';
import { type Api, type Deps, toResponse } from './api.ts';
import { runAction } from './routes-actions.ts';

export const NIP86_CONTENT_TYPE = 'application/nostr+json+rpc';

interface Mapping {
  /** Action registry id this method maps onto. */
  actionId: string;
  input(params: unknown[]): unknown;
  /** Turn the action output into the NIP-86 result. */
  result?(output: unknown): unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const listOf = (key: string) => (output: unknown) => {
  if (Array.isArray(output)) return output;
  const o = output as Record<string, unknown> | null;
  const v = o?.[key] ?? o?.items;
  return Array.isArray(v) ? v : [];
};
const ok = () => true;

/**
 * Contract for modules implementing NIP-86 targets: register actions with
 * these ids and input shapes (`{pubkey, reason?}`, `{id, reason?}`, `{kind}`,
 * `{ip, reason?}`, list actions take `{}` and return an array or
 * `{ items | pubkeys | events | kinds | ips }`).
 */
export const NIP86_METHODS: Record<string, Mapping> = {
  banpubkey: {
    actionId: 'moderation.ban-pubkey',
    input: ([pubkey, reason]) => ({ pubkey: str(pubkey), reason: str(reason) }),
    result: ok,
  },
  listbannedpubkeys: {
    actionId: 'moderation.list-banned-pubkeys',
    input: () => ({}),
    result: listOf('pubkeys'),
  },
  allowpubkey: {
    actionId: 'access.allow-pubkey',
    input: ([pubkey, reason]) => ({ pubkey: str(pubkey), reason: str(reason) }),
    result: ok,
  },
  listallowedpubkeys: {
    actionId: 'access.list-allowed-pubkeys',
    input: () => ({}),
    result: listOf('pubkeys'),
  },
  listeventsneedingmoderation: {
    actionId: 'moderation.list-held-events',
    input: () => ({}),
    result: listOf('events'),
  },
  allowevent: {
    actionId: 'moderation.allow-event',
    input: ([id, reason]) => ({ id: str(id), reason: str(reason) }),
    result: ok,
  },
  banevent: {
    actionId: 'moderation.ban-event',
    input: ([id, reason]) => ({ id: str(id), reason: str(reason) }),
    result: ok,
  },
  listbannedevents: {
    actionId: 'moderation.list-banned-events',
    input: () => ({}),
    result: listOf('events'),
  },
  allowkind: {
    actionId: 'policy.allow-kind',
    input: ([kind]) => ({ kind: Number(kind) }),
    result: ok,
  },
  disallowkind: {
    actionId: 'policy.disallow-kind',
    input: ([kind]) => ({ kind: Number(kind) }),
    result: ok,
  },
  listallowedkinds: {
    actionId: 'policy.list-allowed-kinds',
    input: () => ({}),
    result: listOf('kinds'),
  },
  blockip: {
    actionId: 'network.block-ip',
    input: ([ip, reason]) => ({ ip: str(ip), reason: str(reason) }),
    result: ok,
  },
  unblockip: { actionId: 'network.unblock-ip', input: ([ip]) => ({ ip: str(ip) }), result: ok },
  listblockedips: {
    actionId: 'network.list-blocked-ips',
    input: () => ({}),
    result: listOf('ips'),
  },
};

/** Config-backed methods: relay info fields. */
const CONFIG_METHODS: Record<string, 'name' | 'description' | 'icon'> = {
  changerelayname: 'name',
  changerelaydescription: 'description',
  changerelayicon: 'icon',
};

function resolveAction(kernel: Kernel, method: string): ActionDef | undefined {
  const m = NIP86_METHODS[method];
  return m ? kernel.actions.get(m.actionId) : undefined;
}

export function supportedMethods(kernel: Kernel): string[] {
  return [
    'supportedmethods',
    ...Object.keys(NIP86_METHODS).filter((m) => resolveAction(kernel, m)),
    ...Object.keys(CONFIG_METHODS),
  ];
}

async function call(
  deps: Deps,
  principal: Principal,
  relayId: RelayId,
  method: string,
  params: unknown[],
): Promise<unknown> {
  if (method === 'supportedmethods') return supportedMethods(deps.kernel);
  const field = CONFIG_METHODS[method];
  if (field) {
    const value = str(params[0]);
    if (value === undefined) throw new HttpError(400, 'bad_params', `${method} expects a string`);
    const proposal = await deps.config.propose(
      {
        relayId,
        merge: { info: { [field]: value } },
        summary: `Changed the relay ${field} (NIP-86)`,
      },
      principal,
    );
    if (proposal.patch.length > 0) await deps.config.commit(proposal.id, principal);
    await deps.audit.flush();
    return true;
  }
  const mapping = NIP86_METHODS[method];
  const def = resolveAction(deps.kernel, method);
  if (!mapping || !def) throw new HttpError(400, 'unsupported', `unsupported method: ${method}`);
  const scoped = def.scope === 'relay' ? relayId : null;
  const r = await runAction(deps, def, mapping.input(params), principal, scoped, 'NIP-86');
  return mapping.result ? mapping.result(r.output) : r.output;
}

export async function handleNip86(c: Context, deps: Deps, relayId: RelayId): Promise<Response> {
  try {
    const res = await nip98For(deps.kernel, c.req.raw);
    if (!res.ok) return c.json({ result: null, error: `unauthorized: ${res.reason}` }, 401);
    const rec = await deps.dir.get(res.event.pubkey);
    if (!rec)
      return c.json({ result: null, error: 'unauthorized: not an admin of this relay' }, 401);
    const principal = deps.dir.principalOf(rec, 'nip07');
    let body: { method?: unknown; params?: unknown };
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ result: null, error: 'invalid JSON' }, 400);
    }
    const method = typeof body.method === 'string' ? body.method : '';
    const params = Array.isArray(body.params) ? body.params : [];
    try {
      const result = await call(deps, principal, relayId, method, params);
      return c.json({ result, error: null }, 200, { 'content-type': 'application/json' });
    } catch (err) {
      const msg =
        err instanceof HttpError
          ? err.code === 'unsupported'
            ? err.message
            : `${err.message}${err.technical ? ` (${err.technical})` : ''}`
          : String(err);
      return c.json({ result: null, error: msg }, 200);
    }
  } catch (err) {
    return toResponse(c as never, err, deps);
  }
}

export function isNip86(req: Request): boolean {
  return (
    req.method === 'POST' &&
    (req.headers.get('content-type') ?? '').toLowerCase().startsWith(NIP86_CONTENT_TYPE)
  );
}

export function nip86Routes(api: Api, deps: Deps): void {
  api.openAPIRegistry.registerPath({
    method: 'post',
    path: '/nodes/{node}/relays/{relay}/nip86',
    summary: 'NIP-86 relay management (JSON-RPC)',
    description: `Content-Type ${NIP86_CONTENT_TYPE}, NIP-98 auth. Also accepted on the relay's own URL.`,
    tags: ['NIP-86'],
    security: [{ nip98: [] }],
    responses: { 200: { description: '{ result, error }' } },
  });
  api.post('/nodes/:node/relays/:relay/nip86', (c) => handleNip86(c, deps, c.req.param('relay')));
}

/** Intercept NIP-86 calls on a relay's own URL (the runtime sets `route`). */
export function nip86Interceptor(deps: Deps) {
  return async (
    c: Context<{ Variables: { route?: { relayId: RelayId } } }>,
    next: () => Promise<void>,
  ) => {
    if (!isNip86(c.req.raw) || c.req.path.startsWith('/api/')) return next();
    const relayId = c.get('route')?.relayId;
    if (!relayId || !deps.kernel.relay(relayId)) return next();
    return handleNip86(c as unknown as Context, deps, relayId);
  };
}
