// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type StoredSession, type TokenStore } from '../src/lib/api/client.ts';
import { SseParser } from '../src/lib/api/sse.ts';
import { type NostrSigner, sha256Hex } from '../src/lib/auth/nip98.ts';

function memTokens(
  initial: StoredSession | null = null,
): TokenStore & { value: StoredSession | null } {
  const t = {
    value: initial,
    get: () => t.value,
    set: (s: StoredSession | null) => {
      t.value = s;
    },
  };
  return t;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NOW = 1_800_000_000;

describe('ApiClient', () => {
  it('builds node, relay and root URLs with the `self` node alias', () => {
    const api = new ApiClient({ origin: 'https://r.example', tokens: memTokens() });
    expect(api.url('/health')).toBe('https://r.example/api/v1/nodes/self/health');
    expect(api.url('/nodes', 'root')).toBe('https://r.example/api/v1/nodes');
    expect(() => api.url('/config', 'relay')).toThrow(ApiError);
    api.relayId = 'main';
    expect(api.url('/config', 'relay')).toBe(
      'https://r.example/api/v1/nodes/self/relays/main/config',
    );
  });

  it('sends the bearer token and parses JSON', async () => {
    const fetch = vi.fn(async () => json({ score: 90 }));
    const api = new ApiClient({
      origin: 'http://x',
      fetch,
      tokens: memTokens({ token: 'tok', expiresAt: NOW + 3600 }),
      now: () => NOW,
    });
    expect(await api.get('/health')).toEqual({ score: 90 });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('turns API errors into plain-language ApiError', async () => {
    const api = new ApiClient({
      origin: 'http://x',
      fetch: async () =>
        json(
          {
            error: {
              code: 'forbidden',
              message: "You don't have permission",
              technical: 'requires x',
            },
          },
          403,
        ),
      tokens: memTokens(),
    });
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("You don't have permission");
    expect(err.technical).toBe('requires x');
  });

  it('reports network failures as offline', async () => {
    const api = new ApiClient({
      origin: 'http://x',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      tokens: memTokens(),
    });
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('offline');
  });

  it('refreshes once on 401 and retries', async () => {
    const tokens = memTokens({ token: 'old', expiresAt: NOW + 3600 });
    const seen: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization ?? '';
      seen.push(auth);
      return auth === 'Bearer new'
        ? json({ ok: true })
        : json({ error: { code: 'x', message: 'Please sign in' } }, 401);
    });
    const refresh = vi.fn(async () => {
      tokens.set({ token: 'new', expiresAt: NOW + 3600 });
      return true;
    });
    const api = new ApiClient({
      origin: 'http://x',
      fetch: fetch as never,
      tokens,
      refresh,
      now: () => NOW,
    });
    expect(await api.get('/auth/me')).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
  });

  it('clears the session and reports when refresh fails', async () => {
    const tokens = memTokens({ token: 'old', expiresAt: NOW + 3600 });
    const lost = vi.fn();
    const api = new ApiClient({
      origin: 'http://x',
      fetch: async () => json({ error: { code: 'x', message: 'Please sign in' } }, 401),
      tokens,
      refresh: async () => false,
      onAuthLost: lost,
      now: () => NOW,
    });
    await expect(api.get('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(tokens.value).toBeNull();
    expect(lost).toHaveBeenCalled();
  });

  it('refreshes proactively shortly before the session expires', async () => {
    const tokens = memTokens({ token: 'old', expiresAt: NOW + 30 });
    const refresh = vi.fn(async () => {
      tokens.set({ token: 'fresh', expiresAt: NOW + 3600 });
      return true;
    });
    const fetch = vi.fn(async () => json({}));
    const api = new ApiClient({ origin: 'http://x', fetch, tokens, refresh, now: () => NOW });
    await api.get('/health');
    expect(refresh).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });

  it('signs in with NIP-98: u/method/payload tags, signer header, stores the session', async () => {
    const tokens = memTokens();
    let header = '';
    let body = '';
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      header = h.authorization ?? '';
      body = String(init.body ?? '');
      expect(h['x-nostr-signer']).toBe('nip46');
      return json({
        token: 'jwt',
        expiresAt: NOW + 100,
        principal: { id: 'pk', roles: {}, permissions: {} },
        recoveryCodes: ['A'],
      });
    });
    const signer: NostrSigner = {
      via: 'nip46',
      getPublicKey: async () => 'pk',
      signEvent: async (t) => ({ ...t, id: 'id', pubkey: 'pk', sig: 'sig' }),
    };
    const api = new ApiClient({ origin: 'https://r.example', fetch: fetch as never, tokens });
    const res = await api.signInNostr(signer, { claimCode: 'ABCD-EFGH' });
    expect(res.recoveryCodes).toEqual(['A']);
    expect(tokens.value).toEqual({ token: 'jwt', expiresAt: NOW + 100 });
    expect(header.startsWith('Nostr ')).toBe(true);
    const ev = JSON.parse(atob(header.slice(6)));
    expect(ev.kind).toBe(27235);
    expect(ev.tags).toContainEqual(['u', 'https://r.example/api/v1/nodes/self/auth/nostr']);
    expect(ev.tags).toContainEqual(['method', 'POST']);
    expect(ev.tags).toContainEqual(['payload', sha256Hex(body)]);
  });

  it('routes actions to the node or relay scope from the catalog scope', async () => {
    const urls: string[] = [];
    const api = new ApiClient({
      origin: 'http://x',
      fetch: (async (u: string) => {
        urls.push(u);
        return json({ output: {}, summary: 'ok' });
      }) as never,
      tokens: memTokens(),
    });
    api.relayId = 'main';
    await api.run('moderation.keep', { itemIds: ['1'] }, 'relay');
    await api.run('admins.list', {}, 'node');
    await api.undo('abc');
    expect(urls).toEqual([
      'http://x/api/v1/nodes/self/relays/main/actions/moderation.keep',
      'http://x/api/v1/nodes/self/actions/admins.list',
      'http://x/api/v1/nodes/self/undo/abc',
    ]);
  });

  it('treats a missing SSO endpoint as "no SSO"', async () => {
    const api = new ApiClient({
      origin: 'http://x',
      fetch: async () => new Response('nope', { status: 404 }),
      tokens: memTokens(),
    });
    expect(await api.ssoProviders()).toEqual([]);
  });
});

describe('SseParser', () => {
  it('parses events split across chunks, ignoring comments', () => {
    const p = new SseParser();
    expect(p.push(': connected\nretry: 3000\n\nevent: ready\nda')).toEqual([]);
    const out = p.push('ta: {"a":1}\n\nid: 2\nevent: error\ndata: {"message":"x"}\n\n');
    expect(out).toEqual([
      { event: 'ready', data: { a: 1 } },
      { event: 'error', data: { message: 'x' }, id: '2' },
    ]);
  });

  it('keeps non-JSON data as text and handles CRLF', () => {
    const p = new SseParser();
    expect(p.push('data: hello\r\ndata: world\r\n\r\n')).toEqual([
      { event: 'message', data: 'hello\nworld' },
    ]);
  });
});
