// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin SCIM 2.0 server (RFC 7643/7644) over Hono at `/scim/v2`, built for the
 * provisioning behaviour of Microsoft Entra ID (also fine for Okta, JumpCloud…).
 *
 * Entra quirks handled:
 * 1. PATCH `op` values are capitalised ("Replace", "Add", "Remove").
 * 2. Booleans arrive as strings: `{"op":"Replace","path":"active","value":"False"}`.
 * 3. Soft-delete is `PATCH active=false` (→ suspend + offboarding); hard delete is DELETE.
 * 4. "Test connection" and every sync probe with `GET /Users?filter=userName eq "<guid>"`
 *    and expect `200` with an empty ListResponse (never 404).
 * 5. Filter attribute names are case-insensitive; values are double-quoted.
 * 6. Path-less PATCH with a value object whose keys are paths, incl. URN-prefixed
 *    enterprise extension attributes (`urn:…:enterprise:2.0:User:department`).
 * 7. Value-filtered paths: `emails[type eq "work"].value`, `members[value eq "<id>"]`.
 * 8. Group member removal comes as `{"op":"Remove","path":"members","value":[{"value":id}]}`
 *    as well as the filtered-path form; adds come in batches of up to ~100.
 * 9. `GET /Groups?excludedAttributes=members` must omit members.
 * 10. Duplicate `userName` on POST must be `409` with `scimType: "uniqueness"`.
 * 11. `manager` is sent as `{ "value": "<scim id>" }` or as the bare id string.
 *
 * Auth: `Authorization: Bearer <token>`; tokens are stored as SHA-256 hashes and
 * each token is tied to one IdP id.
 */
import type { Kernel, KernelEnv } from '@beamhop/core';
import { Hono } from 'hono';
import type { EnterpriseIdentityService } from './service.ts';
import { type Binding, COL, type DirectoryGroup, bindingKey } from './store.ts';
import { randomToken, sha256Hex } from './util.ts';

export const SCIM_BASE = '/scim/v2';
const S_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const S_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const S_ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const S_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const S_ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const S_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const CT = 'application/scim+json';

type Json = Record<string, unknown>;

// ───────────────────────── tokens ─────────────────────────

export async function createScimToken(kernel: Kernel, idp: string): Promise<string> {
  const docs = kernel.ports.docs;
  const prev = await docs.get<{ hash: string }>(COL.secrets, `scim-token:${idp}`);
  if (prev) await docs.delete(COL.secrets, `scim-hash:${prev.hash}`);
  const token = `bhscim_${randomToken(32)}`;
  const hash = await sha256Hex(token);
  await docs.put(COL.secrets, `scim-token:${idp}`, {
    hash,
    last4: token.slice(-4),
    createdAt: kernel.ports.clock.now(),
  });
  await docs.put(COL.secrets, `scim-hash:${hash}`, { idp });
  return token;
}

export async function scimTokenInfo(
  kernel: Kernel,
  idp: string,
): Promise<{ last4: string; createdAt: number } | null> {
  return kernel.ports.docs.get(COL.secrets, `scim-token:${idp}`);
}

async function idpForToken(kernel: Kernel, req: Request): Promise<string | null> {
  const h = req.headers.get('authorization');
  if (!h || !/^bearer\s/i.test(h)) return null;
  const hash = await sha256Hex(h.replace(/^bearer\s+/i, '').trim());
  const rec = await kernel.ports.docs.get<{ idp: string }>(COL.secrets, `scim-hash:${hash}`);
  return rec?.idp ?? null;
}

// ───────────────────────── helpers ─────────────────────────

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

function errBody(status: number, detail: string, scimType?: string): Json {
  return { schemas: [S_ERR], status: String(status), detail, ...(scimType ? { scimType } : {}) };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': CT, ...headers },
  });
}

export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

/** `attr eq "value"` (only the equality filters provisioning clients use). */
export function parseFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*([\w.:]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, `Unsupported filter: ${filter}`, 'invalidFilter');
  return { attr: (m[1] as string).toLowerCase(), value: (m[2] as string).replace(/\\(.)/g, '$1') };
}

function iso(t: number): string {
  return new Date(t * 1000).toISOString();
}

// ───────────────────────── PATCH engine ─────────────────────────

interface PatchOp {
  op: string;
  path?: string;
  value?: unknown;
}

interface ParsedPath {
  attr: string;
  filter?: { attr: string; value: string };
  sub?: string;
}

export function parsePath(path: string): ParsedPath {
  let p = path;
  let urn: string | undefined;
  if (p.toLowerCase().startsWith(`${S_ENT.toLowerCase()}:`)) {
    urn = S_ENT;
    p = p.slice(S_ENT.length + 1);
  } else if (p.toLowerCase().startsWith(`${S_USER.toLowerCase()}:`)) {
    p = p.slice(S_USER.length + 1);
  } else if (p.toLowerCase().startsWith(`${S_GROUP.toLowerCase()}:`)) {
    p = p.slice(S_GROUP.length + 1);
  }
  const m = /^([\w]+)(?:\[\s*(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\])?(?:\.(\w+))?$/i.exec(p);
  if (!m) throw new ScimError(400, `Unsupported path: ${path}`, 'invalidPath');
  const out: ParsedPath = { attr: (urn ? `${urn}:` : '') + (m[1] as string) };
  if (m[2]) out.filter = { attr: m[2], value: (m[3] as string).replace(/\\(.)/g, '$1') };
  if (m[4]) out.sub = m[4];
  return out;
}

function getCI(obj: Json, key: string): [string, unknown] {
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? [k, obj[k]] : [key, undefined];
}

/** Resolve the container object and key for an attribute (handles the enterprise URN). */
function container(obj: Json, attr: string): [Json, string] {
  if (attr.startsWith(`${S_ENT}:`)) {
    const [k, cur] = getCI(obj, S_ENT);
    let ext = cur as Json | undefined;
    if (!ext || typeof ext !== 'object') {
      ext = {};
      obj[k] = ext;
    }
    return [ext, getCI(ext, attr.slice(S_ENT.length + 1))[0]];
  }
  return [obj, getCI(obj, attr)[0]];
}

function sameValue(a: unknown, b: unknown): boolean {
  const v = (x: unknown) => (x && typeof x === 'object' ? (x as Json).value : x);
  return String(v(a)) === String(v(b));
}

function applyOne(obj: Json, op: string, path: string, value: unknown): void {
  // Dotted path without filter: name.givenName
  const dotted = /^[\w]+\.[\w]+$/.test(path) && !path.startsWith('urn:');
  const pp = dotted
    ? { attr: path.split('.')[0] as string, sub: path.split('.')[1] as string }
    : parsePath(path);
  const [box, key] = container(obj, pp.attr);
  const cur = box[key];
  if (pp.filter) {
    const list = Array.isArray(cur) ? (cur as Json[]) : [];
    const f = pp.filter;
    const match = (e: Json) =>
      String(getCI(e, f.attr)[1] ?? '').toLowerCase() === f.value.toLowerCase();
    if (op === 'remove') {
      box[key] = pp.sub
        ? list.map((e) => {
            if (!match(e)) return e;
            const c = { ...e };
            delete c[getCI(c, pp.sub as string)[0]];
            return c;
          })
        : list.filter((e) => !match(e));
      return;
    }
    let el = list.find(match);
    if (!el) {
      el = { [f.attr]: f.value };
      list.push(el);
    }
    if (pp.sub) el[getCI(el, pp.sub)[0]] = value;
    else if (value && typeof value === 'object') Object.assign(el, value);
    box[key] = list;
    return;
  }
  if (pp.sub) {
    let inner = cur as Json | undefined;
    if (!inner || typeof inner !== 'object') {
      inner = {};
      box[key] = inner;
    }
    if (op === 'remove') delete inner[getCI(inner, pp.sub)[0]];
    else inner[getCI(inner, pp.sub)[0]] = value;
    return;
  }
  if (op === 'remove') {
    if (Array.isArray(cur) && Array.isArray(value))
      box[key] = cur.filter((e) => !value.some((v) => sameValue(e, v)));
    else delete box[key];
    return;
  }
  if (op === 'add' && Array.isArray(cur)) {
    const add = Array.isArray(value) ? value : [value];
    box[key] = [...cur, ...add.filter((v) => !cur.some((e) => sameValue(e, v)))];
    return;
  }
  box[key] = value;
}

/** Apply a SCIM PatchOp request to a resource JSON (in place). */
export function applyPatch(obj: Json, body: unknown): Json {
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops)) throw new ScimError(400, 'PATCH needs Operations', 'invalidSyntax');
  for (const raw of ops as PatchOp[]) {
    const op = String(raw.op ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op))
      throw new ScimError(400, `Unsupported op ${raw.op}`, 'invalidSyntax');
    if (raw.path) {
      applyOne(obj, op, raw.path, raw.value);
    } else if (raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)) {
      for (const [k, v] of Object.entries(raw.value as Json)) {
        if (k === S_ENT && v && typeof v === 'object') {
          for (const [k2, v2] of Object.entries(v as Json)) applyOne(obj, op, `${S_ENT}:${k2}`, v2);
        } else applyOne(obj, op, k, v);
      }
    } else throw new ScimError(400, 'PATCH operation needs a path or a value', 'noTarget');
  }
  return obj;
}

// ───────────────────────── resource mapping ─────────────────────────

export function userToScim(b: Binding, base: string): Json {
  const ent: Json = {};
  if (b.department) ent.department = b.department;
  if (b.manager) ent.manager = { value: b.manager };
  const out: Json = {
    schemas: [S_USER, S_ENT],
    id: b.scimId,
    userName: b.userName ?? b.email ?? b.subject,
    active: b.status === 'active' || b.status === 'pending',
    meta: {
      resourceType: 'User',
      created: iso(b.createdAt),
      lastModified: iso(b.updatedAt),
      location: `${base}${SCIM_BASE}/Users/${b.scimId}`,
    },
  };
  if (b.externalId) out.externalId = b.externalId;
  const name: Json = {};
  if (b.givenName) name.givenName = b.givenName;
  if (b.familyName) name.familyName = b.familyName;
  if (b.name) name.formatted = b.name;
  if (Object.keys(name).length) out.name = name;
  if (b.name) out.displayName = b.name;
  if (b.email) out.emails = [{ value: b.email, type: 'work', primary: true }];
  if (b.title) out.title = b.title;
  if (Object.keys(ent).length) out[S_ENT] = ent;
  return out;
}

interface UserFields {
  userName?: string;
  externalId?: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  title?: string;
  department?: string;
  manager?: string;
  active?: boolean;
}

export function scimToFields(r: Json): UserFields {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out: UserFields = {};
  const set = <K extends keyof UserFields>(k: K, v: UserFields[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('userName', s(getCI(r, 'userName')[1]));
  set('externalId', s(getCI(r, 'externalId')[1]));
  const name = getCI(r, 'name')[1] as Json | undefined;
  if (name && typeof name === 'object') {
    set('givenName', s(getCI(name, 'givenName')[1]));
    set('familyName', s(getCI(name, 'familyName')[1]));
    set('name', s(getCI(name, 'formatted')[1]));
  }
  set('name', s(getCI(r, 'displayName')[1]) ?? out.name);
  if (!out.name && (out.givenName || out.familyName))
    out.name = [out.givenName, out.familyName].filter(Boolean).join(' ');
  const emails = getCI(r, 'emails')[1];
  if (Array.isArray(emails)) {
    const pick =
      (emails as Json[]).find((e) => parseBool(e.primary)) ??
      (emails as Json[]).find((e) => String(e.type).toLowerCase() === 'work') ??
      (emails as Json[])[0];
    set('email', s(pick?.value)?.toLowerCase());
  }
  if (!out.email && out.userName?.includes('@')) out.email = out.userName.toLowerCase();
  set('title', s(getCI(r, 'title')[1]));
  const ent = getCI(r, S_ENT)[1] as Json | undefined;
  if (ent && typeof ent === 'object') {
    set('department', s(getCI(ent, 'department')[1]));
    const mgr = getCI(ent, 'manager')[1];
    set('manager', s(mgr && typeof mgr === 'object' ? (mgr as Json).value : mgr));
  }
  const active = parseBool(getCI(r, 'active')[1]);
  if (active !== undefined) out.active = active;
  return out;
}

export function groupToScim(g: DirectoryGroup, scimIdOf: Map<string, string>, base: string): Json {
  const out: Json = {
    schemas: [S_GROUP],
    id: g.id,
    displayName: g.displayName,
    members: g.members
      .map((k) => scimIdOf.get(k))
      .filter((v): v is string => !!v)
      .map((value) => ({ value, $ref: `${base}${SCIM_BASE}/Users/${value}` })),
    meta: {
      resourceType: 'Group',
      lastModified: iso(g.updatedAt),
      location: `${base}${SCIM_BASE}/Groups/${g.id}`,
    },
  };
  if (g.externalId) out.externalId = g.externalId;
  return out;
}

// ───────────────────────── routes ─────────────────────────

export interface ScimDeps {
  kernel: Kernel;
  identity: EnterpriseIdentityService;
  baseUrl: (req: Request) => string;
}

export function scimRoutes(deps: ScimDeps): Hono<KernelEnv & { Variables: { idp: string } }> {
  const { kernel, identity } = deps;
  const store = identity.store;
  const app = new Hono<KernelEnv & { Variables: { idp: string } }>();
  const now = () => kernel.ports.clock.now();

  app.onError((err) => {
    if (err instanceof ScimError)
      return json(errBody(err.status, err.message, err.scimType), err.status);
    kernel.ports.logger.log('error', 'scim request failed', {
      module: 'enterprise-identity',
      err: String(err),
    });
    return json(errBody(500, 'Internal error'), 500);
  });

  app.use('*', async (c, next) => {
    if (!identity.cfg().scim.enabled) return json(errBody(404, 'SCIM is turned off'), 404);
    const idp = await idpForToken(kernel, c.req.raw);
    if (!idp) return json(errBody(401, 'A valid SCIM bearer token is required'), 401);
    c.set('idp', idp);
    await next();
  });

  const readJson = async (req: Request): Promise<Json> => {
    try {
      const v = await req.json();
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
    } catch {
      /* fallthrough */
    }
    throw new ScimError(400, 'Request body must be a JSON object', 'invalidSyntax');
  };

  const list = (items: Json[], startIndex: number, count: number) => {
    const page = items.slice(startIndex - 1, startIndex - 1 + count);
    return json({
      schemas: [S_LIST],
      totalResults: items.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page,
    });
  };

  const paging = (q: (k: string) => string | undefined) => {
    const startIndex = Math.max(1, Number.parseInt(q('startIndex') ?? '1', 10) || 1);
    const count = Math.min(1000, Math.max(0, Number.parseInt(q('count') ?? '100', 10) || 100));
    return { startIndex, count };
  };

  const usersOf = async (idp: string) =>
    (await store.list()).filter((b) => b.idp === idp && b.scimId && b.status !== 'deleted');

  const userById = async (idp: string, id: string): Promise<Binding> => {
    const b = await store.byScimId(id);
    if (!b || b.idp !== idp || b.status === 'deleted')
      throw new ScimError(404, `User ${id} not found`);
    return b;
  };

  /** Write SCIM fields into a binding, handling activation changes. */
  const saveUser = async (prev: Binding, f: UserFields): Promise<Binding> => {
    const next: Binding = { ...prev };
    next.userName = f.userName ?? prev.userName;
    next.externalId = f.externalId;
    next.email = f.email ?? prev.email;
    next.name = f.name;
    next.givenName = f.givenName;
    next.familyName = f.familyName;
    next.title = f.title;
    next.department = f.department;
    next.manager = f.manager;
    const key = bindingKey(prev.idp, prev.subject);
    const wasActive = prev.status === 'active' || prev.status === 'pending';
    if (f.active === false && wasActive) {
      await store.put(next);
      await identity.offboard(key, 'Deactivated in the company directory (SCIM)');
      return (await store.get(key)) ?? next;
    }
    if (f.active === true && !wasActive) {
      await store.put(next);
      return (await identity.reactivate(key)) ?? next;
    }
    await store.put(next);
    if (next.status === 'active') await identity.syncProfile(next);
    return next;
  };

  // ── discovery endpoints ──
  app.get('/ServiceProviderConfig', (c) =>
    json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://beamhop.org/docs/enterprise/scim',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 1000 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'Long-lived token created in the Beamhop admin app',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${deps.baseUrl(c.req.raw)}${SCIM_BASE}/ServiceProviderConfig`,
      },
    }),
  );

  app.get('/ResourceTypes', (c) => {
    const base = deps.baseUrl(c.req.raw);
    const rt = [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: S_USER,
        schemaExtensions: [{ schema: S_ENT, required: false }],
        meta: { resourceType: 'ResourceType', location: `${base}${SCIM_BASE}/ResourceTypes/User` },
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        schema: S_GROUP,
        meta: { resourceType: 'ResourceType', location: `${base}${SCIM_BASE}/ResourceTypes/Group` },
      },
    ];
    return list(rt, 1, rt.length);
  });

  app.get('/Schemas', () => {
    const attr = (name: string, type = 'string', multiValued = false) => ({
      name,
      type,
      multiValued,
      required: name === 'userName' || name === 'displayName',
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: name === 'userName' ? 'server' : 'none',
    });
    const schemas = [
      {
        id: S_USER,
        name: 'User',
        attributes: [
          attr('userName'),
          attr('externalId'),
          attr('displayName'),
          attr('title'),
          attr('active', 'boolean'),
          attr('name', 'complex'),
          attr('emails', 'complex', true),
        ],
      },
      {
        id: S_ENT,
        name: 'EnterpriseUser',
        attributes: [attr('department'), attr('manager', 'complex')],
      },
      {
        id: S_GROUP,
        name: 'Group',
        attributes: [attr('displayName'), attr('externalId'), attr('members', 'complex', true)],
      },
    ].map((s) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], ...s }));
    return list(schemas, 1, schemas.length);
  });

  // ── Users ──
  app.get('/Users', async (c) => {
    const idp = c.get('idp');
    const base = deps.baseUrl(c.req.raw);
    const f = parseFilter(c.req.query('filter'));
    let users = await usersOf(idp);
    if (f) {
      const v = f.value.toLowerCase();
      if (f.attr === 'username') users = users.filter((b) => b.userName?.toLowerCase() === v);
      else if (f.attr === 'externalid') users = users.filter((b) => b.externalId === f.value);
      else if (f.attr === 'emails.value' || f.attr === 'emails')
        users = users.filter((b) => b.email === v);
      else if (f.attr === 'id') users = users.filter((b) => b.scimId === f.value);
      else throw new ScimError(400, `Cannot filter on ${f.attr}`, 'invalidFilter');
    }
    users.sort((a, b) => a.createdAt - b.createdAt);
    const { startIndex, count } = paging((k) => c.req.query(k));
    return list(
      users.map((b) => userToScim(b, base)),
      startIndex,
      count,
    );
  });

  app.get('/Users/:id', async (c) => {
    const b = await userById(c.get('idp'), c.req.param('id'));
    return json(userToScim(b, deps.baseUrl(c.req.raw)));
  });

  app.post('/Users', async (c) => {
    const idp = c.get('idp');
    const body = await readJson(c.req.raw);
    const f = scimToFields(body);
    if (!f.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const userName = f.userName;
    const dup = (await usersOf(idp)).find(
      (b) => b.userName?.toLowerCase() === userName.toLowerCase(),
    );
    if (dup) throw new ScimError(409, `User ${userName} already exists`, 'uniqueness');
    const subject = f.externalId ?? userName.toLowerCase();
    const key = bindingKey(idp, subject);
    // Correlate with a record created earlier by SSO login or directory sync.
    const existing =
      (await store.get(key)) ?? (f.email ? await store.byEmail(f.email) : null) ?? null;
    const now_ = now();
    const base: Binding =
      existing && existing.idp === idp
        ? { ...existing }
        : {
            idp,
            subject,
            groups: [],
            keyModel: identity.cfg().defaultKeyModel,
            status: 'pending',
            source: 'scim',
            createdAt: now_,
            updatedAt: now_,
          };
    if (base.status === 'deleted') base.status = 'pending';
    base.scimId = base.scimId ?? crypto.randomUUID();
    base.userName = userName;
    const saved = await saveUser(base, { ...f, active: f.active ?? true });
    return json(userToScim(saved, deps.baseUrl(c.req.raw)), 201, {
      location: `${deps.baseUrl(c.req.raw)}${SCIM_BASE}/Users/${saved.scimId}`,
    });
  });

  app.put('/Users/:id', async (c) => {
    const prev = await userById(c.get('idp'), c.req.param('id'));
    const f = scimToFields(await readJson(c.req.raw));
    const saved = await saveUser(prev, { ...f, active: f.active ?? true });
    return json(userToScim(saved, deps.baseUrl(c.req.raw)));
  });

  app.patch('/Users/:id', async (c) => {
    const prev = await userById(c.get('idp'), c.req.param('id'));
    const base = deps.baseUrl(c.req.raw);
    const body = await readJson(c.req.raw);
    const schemas = body.schemas;
    if (Array.isArray(schemas) && !schemas.includes(S_PATCH))
      throw new ScimError(400, 'Expected a PatchOp request', 'invalidSyntax');
    const doc = applyPatch(userToScim(prev, base), body);
    const f = scimToFields(doc);
    const saved = await saveUser(prev, f);
    return json(userToScim(saved, base));
  });

  app.delete('/Users/:id', async (c) => {
    const idp = c.get('idp');
    const b = await userById(idp, c.req.param('id'));
    const key = bindingKey(b.idp, b.subject);
    await identity.offboard(key, 'Removed from the company directory (SCIM)', 'deleted');
    // Drop from SCIM groups and forget the SCIM id (Entra expects 404 afterwards).
    for (const g of await store.listGroups(idp))
      if (g.members.includes(key))
        await store.putGroup({ ...g, members: g.members.filter((m) => m !== key) });
    if (b.scimId) await store.dropAlias(`scim:${b.scimId}`, key);
    const cur = await store.get(key);
    if (cur) await store.put({ ...cur, scimId: undefined, groups: [] });
    return new Response(null, { status: 204 });
  });

  // ── Groups ──
  const groupById = async (idp: string, id: string) => {
    const g = await store.getGroup(idp, id);
    if (!g) throw new ScimError(404, `Group ${id} not found`);
    return g;
  };

  const scimIds = async (idp: string) => {
    const m = new Map<string, string>();
    for (const b of await usersOf(idp)) if (b.scimId) m.set(bindingKey(b.idp, b.subject), b.scimId);
    return m;
  };

  /** Persist group + reflect membership on bindings; returns whether members changed. */
  const saveGroup = async (prev: DirectoryGroup | null, next: DirectoryGroup) => {
    const before = new Set(prev?.members ?? []);
    const after = new Set(next.members);
    await store.putGroup(next);
    let changed = false;
    for (const k of after)
      if (!before.has(k)) {
        const b = await store.get(k);
        if (b && !b.groups.includes(next.id))
          await store.put({ ...b, groups: [...b.groups, next.id] });
        changed = true;
      }
    for (const k of before)
      if (!after.has(k)) {
        const b = await store.get(k);
        if (b) await store.put({ ...b, groups: b.groups.filter((g) => g !== next.id) });
        changed = true;
      }
    if (changed || prev?.displayName !== next.displayName) await identity.afterChange();
  };

  const membersFrom = async (idp: string, raw: unknown): Promise<string[]> => {
    const out: string[] = [];
    for (const m of Array.isArray(raw) ? raw : []) {
      const id = m && typeof m === 'object' ? (m as Json).value : m;
      if (typeof id !== 'string') continue;
      const b = await store.byScimId(id);
      if (b && b.idp === idp) out.push(bindingKey(b.idp, b.subject));
    }
    return [...new Set(out)];
  };

  app.get('/Groups', async (c) => {
    const idp = c.get('idp');
    const base = deps.baseUrl(c.req.raw);
    const f = parseFilter(c.req.query('filter'));
    let groups = (await store.listGroups(idp)).filter((g) => g.source === 'scim');
    if (f) {
      if (f.attr === 'displayname')
        groups = groups.filter((g) => g.displayName.toLowerCase() === f.value.toLowerCase());
      else if (f.attr === 'externalid') groups = groups.filter((g) => g.externalId === f.value);
      else if (f.attr === 'id') groups = groups.filter((g) => g.id === f.value);
      else throw new ScimError(400, `Cannot filter on ${f.attr}`, 'invalidFilter');
    }
    const ids = await scimIds(idp);
    const excluded = (c.req.query('excludedAttributes') ?? '').toLowerCase().split(',');
    const { startIndex, count } = paging((k) => c.req.query(k));
    return list(
      groups.map((g) => {
        const r = groupToScim(g, ids, base);
        if (excluded.includes('members')) r.members = undefined;
        return r;
      }),
      startIndex,
      count,
    );
  });

  app.get('/Groups/:id', async (c) => {
    const idp = c.get('idp');
    const g = await groupById(idp, c.req.param('id'));
    const r = groupToScim(g, await scimIds(idp), deps.baseUrl(c.req.raw));
    if ((c.req.query('excludedAttributes') ?? '').toLowerCase().includes('members'))
      r.members = undefined;
    return json(r);
  });

  app.post('/Groups', async (c) => {
    const idp = c.get('idp');
    const body = await readJson(c.req.raw);
    const displayName = getCI(body, 'displayName')[1];
    if (typeof displayName !== 'string' || !displayName)
      throw new ScimError(400, 'displayName is required', 'invalidValue');
    const dup = (await store.listGroups(idp)).find(
      (g) => g.source === 'scim' && g.displayName.toLowerCase() === displayName.toLowerCase(),
    );
    if (dup) throw new ScimError(409, `Group ${displayName} already exists`, 'uniqueness');
    const ext = getCI(body, 'externalId')[1];
    const g: DirectoryGroup = {
      idp,
      id: crypto.randomUUID(),
      displayName,
      members: await membersFrom(idp, getCI(body, 'members')[1]),
      source: 'scim',
      updatedAt: now(),
      ...(typeof ext === 'string' ? { externalId: ext } : {}),
    };
    await saveGroup(null, g);
    const base = deps.baseUrl(c.req.raw);
    return json(groupToScim(g, await scimIds(idp), base), 201, {
      location: `${base}${SCIM_BASE}/Groups/${g.id}`,
    });
  });

  app.put('/Groups/:id', async (c) => {
    const idp = c.get('idp');
    const prev = await groupById(idp, c.req.param('id'));
    const body = await readJson(c.req.raw);
    const dn = getCI(body, 'displayName')[1];
    const ext = getCI(body, 'externalId')[1];
    const next: DirectoryGroup = {
      ...prev,
      displayName: typeof dn === 'string' && dn ? dn : prev.displayName,
      members: await membersFrom(idp, getCI(body, 'members')[1]),
    };
    if (typeof ext === 'string') next.externalId = ext;
    await saveGroup(prev, next);
    return json(groupToScim(next, await scimIds(idp), deps.baseUrl(c.req.raw)));
  });

  app.patch('/Groups/:id', async (c) => {
    const idp = c.get('idp');
    const prev = await groupById(idp, c.req.param('id'));
    const base = deps.baseUrl(c.req.raw);
    const ids = await scimIds(idp);
    const doc = applyPatch(groupToScim(prev, ids, base), await readJson(c.req.raw));
    const dn = getCI(doc, 'displayName')[1];
    const ext = getCI(doc, 'externalId')[1];
    const next: DirectoryGroup = {
      ...prev,
      displayName: typeof dn === 'string' && dn ? dn : prev.displayName,
      members: await membersFrom(idp, getCI(doc, 'members')[1]),
    };
    if (typeof ext === 'string') next.externalId = ext;
    else next.externalId = undefined;
    await saveGroup(prev, next);
    // RFC 7644 §3.5.2: 204 is allowed when the client did not ask for attributes.
    return new Response(null, { status: 204 });
  });

  app.delete('/Groups/:id', async (c) => {
    const idp = c.get('idp');
    const prev = await groupById(idp, c.req.param('id'));
    await saveGroup(prev, { ...prev, members: [] });
    await store.removeGroup(idp, prev.id);
    return new Response(null, { status: 204 });
  });

  app.notFound(() => json(errBody(404, 'Unknown SCIM resource'), 404));
  return app;
}
