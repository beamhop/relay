// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BeamhopModule,
  type Kernel,
  createKernel,
  defineAction,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { type TestKey, makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import { type AdminClaimService, adminApiModule } from '../src/index.ts';
import { HttpError, sha256Hex, utf8 } from '../src/util.ts';

export const ORIGIN = 'http://localhost';
export const NODE = `${ORIGIN}/api/v1/nodes/n1`;
export const RELAY = (id = 'main') => `${NODE}/relays/${id}`;

/** Fake moderation module so action endpoints and NIP-86 have something to drive. */
export function testActionsModule(banned: Map<string, Set<string>>): BeamhopModule {
  return defineModule({
    id: 'test-actions',
    register(k) {
      const set = (relay: string) => {
        let s = banned.get(relay);
        if (!s) {
          s = new Set();
          banned.set(relay, s);
        }
        return s;
      };
      k.actions.register(
        defineAction({
          id: 'moderation.ban-pubkey',
          title: 'Ban a user',
          description: 'They can no longer post here.',
          technical: 'NIP-86 banpubkey',
          scope: 'relay',
          permission: 'moderation.write',
          bulk: true,
          input: z.object({
            pubkey: z.string().regex(/^[0-9a-f]{64}$/),
            reason: z.string().optional(),
          }),
          async preview(input) {
            return [{ kind: 'add', text: `${input.pubkey.slice(0, 8)} will be banned` }];
          },
          async run(input, ctx) {
            set(ctx.relayId!).add(input.pubkey);
            return {
              output: { banned: input.pubkey },
              summary: `Banned ${input.pubkey.slice(0, 8)}`,
              undo: {
                actionId: 'moderation.ban-pubkey',
                payload: { pubkey: input.pubkey, relayId: ctx.relayId },
                expiresAt: ctx.ports.clock.now() + 300,
              },
            };
          },
          async undo(payload) {
            const p = payload as { pubkey: string; relayId: string };
            set(p.relayId).delete(p.pubkey);
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'moderation.list-banned-pubkeys',
          title: 'Show banned users',
          description: 'Everyone banned here.',
          scope: 'relay',
          permission: 'relay.read',
          readOnly: true,
          input: z.object({}),
          async run(_i, ctx) {
            return {
              output: { pubkeys: [...set(ctx.relayId!)].map((pubkey) => ({ pubkey, reason: '' })) },
              summary: 'Listed bans',
            };
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'test.explode',
          title: 'Explode',
          description: 'Always fails.',
          scope: 'node',
          permission: 'config.write',
          input: z.object({}),
          async run() {
            throw new HttpError(422, 'nope', 'This never works');
          },
        }),
      );
    },
  });
}

export interface Env {
  kernel: Kernel;
  ports: ReturnType<typeof memoryPorts>;
  banned: Map<string, Set<string>>;
  owner: TestKey;
  ownerToken: string;
  recoveryCodes: string[];
}

export async function boot(extra: BeamhopModule[] = []) {
  const ports = memoryPorts();
  const config = parseConfig({
    node: { id: 'n1' },
    relays: [
      { id: 'main', hosts: ['localhost'] },
      { id: 'team', hosts: ['team.localhost'] },
    ],
  });
  const banned = new Map<string, Set<string>>();
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [adminApiModule, testActionsModule(banned), ...extra],
  });
  return { kernel, ports, banned };
}

/** Build a real NIP-98 Authorization header. */
export async function nip98(
  ports: { clock: { now(): number } },
  key: TestKey,
  url: string,
  method: string,
  body?: string,
  createdAt?: number,
): Promise<string> {
  const tags = [
    ['u', url],
    ['method', method],
    ['nonce', crypto.randomUUID()],
  ];
  if (body) tags.push(['payload', await sha256Hex(utf8(body))]);
  const ev = makeEvent(key, {
    kind: 27235,
    tags,
    content: '',
    created_at: createdAt ?? ports.clock.now(),
  });
  return `Nostr ${btoa(JSON.stringify(ev))}`;
}

export interface ReqOpts {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

export async function call(kernel: Kernel, method: string, url: string, o: ReqOpts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: string | undefined = o.raw;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await kernel.http.request(url, { method, headers, body });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: test convenience for arbitrary JSON responses
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Sign in with Nostr (NIP-98), optionally redeeming a code. */
export async function nostrLogin(
  env: { kernel: Kernel; ports: ReturnType<typeof memoryPorts> },
  key: TestKey,
  body: Record<string, unknown> = {},
) {
  const url = `${NODE}/auth/nostr`;
  const raw = JSON.stringify(body);
  const auth = await nip98(env.ports, key, url, 'POST', raw === '{}' ? undefined : raw);
  return call(env.kernel, 'POST', url, {
    raw: raw === '{}' ? undefined : raw,
    headers: { authorization: auth, 'content-type': 'application/json' },
  });
}

/** Boot and claim the node as owner via Nostr. */
export async function bootClaimed(extra: BeamhopModule[] = []): Promise<Env> {
  const b = await boot(extra);
  const owner = makeKey();
  const claim = b.kernel.use<AdminClaimService>('admin.claim')!;
  const code = (await claim.issueCode()).code;
  const res = await nostrLogin(b, owner, { claimCode: code, displayName: 'Ayşe' });
  if (res.status !== 200) throw new Error(`claim failed: ${res.text}`);
  return { ...b, owner, ownerToken: res.json.token, recoveryCodes: res.json.recoveryCodes };
}

/** Add a team member with a role (via the invite action) and return a session for them. */
export async function addMember(
  env: Env,
  role: 'owner' | 'admin' | 'moderator' | 'viewer',
  relayId?: string,
  displayName?: string,
) {
  const key = makeKey();
  const input: Record<string, unknown> = { pubkey: key.pk, role };
  if (relayId) input.relayId = relayId;
  if (displayName) input.displayName = displayName;
  const r = await call(env.kernel, 'POST', `${NODE}/actions/admins.invite`, {
    token: env.ownerToken,
    body: { input },
  });
  if (r.status !== 200) throw new Error(`invite failed: ${r.text}`);
  const login = await nostrLogin(env, key);
  if (login.status !== 200) throw new Error(`login failed: ${login.text}`);
  return { key, token: login.json.token as string };
}

export { makeKey };
