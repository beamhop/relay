// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { FakeClock, MemoryDocStore } from '@beamhop/testkit';
import { Hono } from 'hono';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { type FetchLike, fromB64, fromB64Url, toB64, toB64Url, utf8 } from '../src/bytes.ts';
import {
  AwsKmsWrapper,
  AzureKeyVaultWrapper,
  Envelope,
  GCP_KMS_SCOPE,
  GcpKmsWrapper,
  KmsError,
  LocalMasterKeyWrapper,
  VaultTransitWrapper,
} from '../src/index.ts';
import { randomMasterKey } from './helpers.ts';

/** Fake "KMS encryption": reversible, so mocks can decrypt what they encrypted. */
const seal = (u: Uint8Array) => u.map((b) => b ^ 0x5a);

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function mockFetch(apps: Record<string, Hono>, seen: Seen[]): FetchLike {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const body = await req.clone().text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({ method: req.method, url: req.url, headers, body });
    const app = apps[new URL(req.url).host];
    if (!app) return new Response('no host', { status: 502 });
    return app.fetch(req);
  };
}

const pt = () => crypto.getRandomValues(new Uint8Array(32));

describe('AWS KMS (SigV4)', () => {
  test('signs requests and round-trips', async () => {
    const app = new Hono();
    app.post('/', async (c) => {
      const target = c.req.header('x-amz-target');
      const j = (await c.req.json()) as Record<string, string>;
      expect(j.KeyId).toBe('arn:aws:kms:eu-west-1:1:key/abc');
      if (target === 'TrentService.Encrypt')
        return c.json({ CiphertextBlob: toB64(seal(fromB64(j.Plaintext as string))) });
      if (target === 'TrentService.Decrypt')
        return c.json({ Plaintext: toB64(seal(fromB64(j.CiphertextBlob as string))) });
      return c.json({ __type: 'UnknownOperation' }, 400);
    });
    const seen: Seen[] = [];
    const w = new AwsKmsWrapper({
      region: 'eu-west-1',
      keyId: 'arn:aws:kms:eu-west-1:1:key/abc',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'session-token',
      fetch: mockFetch({ 'kms.eu-west-1.amazonaws.com': app }, seen),
    });
    const p = pt();
    const ct = await w.wrap(p);
    expect(ct).not.toEqual(p);
    expect(await w.unwrap(ct)).toEqual(p);

    expect(seen).toHaveLength(2);
    const h = seen[0]!.headers;
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('https://kms.eu-west-1.amazonaws.com/');
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/kms\/aws4_request, SignedHeaders=[^,]*x-amz-date[^,]*, Signature=[0-9a-f]{64}$/,
    );
    expect(h.authorization).toContain('x-amz-target');
    expect(h['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(h['x-amz-security-token']).toBe('session-token');
    expect(h['x-amz-target']).toBe('TrentService.Encrypt');
    expect(h['content-type']).toBe('application/x-amz-json-1.1');
    expect(seen[1]!.headers['x-amz-target']).toBe('TrentService.Decrypt');
    expect(w.id).toBe('aws-kms:arn:aws:kms:eu-west-1:1:key/abc');
  });

  test('maps HTTP errors without leaking secrets', async () => {
    const app = new Hono();
    app.post('/', (c) => c.json({ __type: 'AccessDeniedException' }, 400));
    const w = new AwsKmsWrapper({
      region: 'us-east-1',
      keyId: 'k',
      accessKeyId: 'AKID',
      secretAccessKey: 'very-secret',
      fetch: mockFetch({ 'kms.us-east-1.amazonaws.com': app }, []),
    });
    const err = await w.wrap(pt()).catch((e) => e);
    expect(err).toBeInstanceOf(KmsError);
    expect(String(err.message)).toContain('AccessDeniedException');
    expect(String(err.message)).not.toContain('very-secret');
  });
});

describe('Google Cloud KMS (service-account JWT)', () => {
  test('exchanges a signed JWT for a token, caches it, and calls :encrypt/:decrypt', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const tokenUri = 'https://oauth2.test/token';
    let tokenCalls = 0;
    const oauth = new Hono();
    oauth.post('/token', async (c) => {
      tokenCalls++;
      const form = await c.req.parseBody();
      expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const { payload, protectedHeader } = await jwtVerify(String(form.assertion), publicKey, {
        issuer: 'kv@proj.iam.gserviceaccount.com',
        audience: tokenUri,
      });
      expect(protectedHeader.alg).toBe('RS256');
      expect(payload.scope).toBe(GCP_KMS_SCOPE);
      return c.json({ access_token: 'gcp-token', expires_in: 3600, token_type: 'Bearer' });
    });
    const keyName = 'projects/p/locations/global/keyRings/r/cryptoKeys/k';
    const kms = new Hono();
    kms.post('*', async (c) => {
      expect(c.req.header('authorization')).toBe('Bearer gcp-token');
      const j = (await c.req.json()) as Record<string, string>;
      if (c.req.path === `/v1/${keyName}:encrypt`)
        return c.json({ ciphertext: toB64(seal(fromB64(j.plaintext as string))) });
      if (c.req.path === `/v1/${keyName}:decrypt`)
        return c.json({ plaintext: toB64(seal(fromB64(j.ciphertext as string))) });
      return c.json({ error: { message: `bad path ${c.req.path}` } }, 404);
    });
    const seen: Seen[] = [];
    const w = new GcpKmsWrapper({
      keyName,
      clientEmail: 'kv@proj.iam.gserviceaccount.com',
      privateKey: pem,
      tokenUri,
      endpoint: 'https://cloudkms.googleapis.com',
      fetch: mockFetch({ 'oauth2.test': oauth, 'cloudkms.googleapis.com': kms }, seen),
      nowMs: () => Date.now(),
    });
    const p = pt();
    expect(await w.unwrap(await w.wrap(p))).toEqual(p);
    expect(await w.unwrap(await w.wrap(p))).toEqual(p);
    expect(tokenCalls).toBe(1);
    expect(seen.filter((s) => s.url.includes(':encrypt'))).toHaveLength(2);
    expect(seen[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('Azure Key Vault (client credentials)', () => {
  test('gets a token, wraps with wrapkey and unwraps with the returned key version', async () => {
    let tokenCalls = 0;
    const login = new Hono();
    login.post('/tenant-1/oauth2/v2.0/token', async (c) => {
      tokenCalls++;
      const form = await c.req.parseBody();
      expect(form).toMatchObject({
        grant_type: 'client_credentials',
        client_id: 'app-id',
        client_secret: 'app-secret',
        scope: 'https://vault.azure.net/.default',
      });
      return c.json({ access_token: 'az-token', expires_in: 3599, token_type: 'Bearer' });
    });
    const vault = new Hono();
    vault.post('/keys/kek/wrapkey', async (c) => {
      expect(c.req.query('api-version')).toBe('7.4');
      expect(c.req.header('authorization')).toBe('Bearer az-token');
      const j = (await c.req.json()) as { alg: string; value: string };
      expect(j.alg).toBe('RSA-OAEP-256');
      return c.json({
        kid: 'https://my-vault.vault.azure.net/keys/kek/v7',
        value: toB64Url(seal(fromB64Url(j.value))),
      });
    });
    vault.post('/keys/kek/v7/unwrapkey', async (c) => {
      expect(c.req.query('api-version')).toBe('7.4');
      const j = (await c.req.json()) as { alg: string; value: string };
      return c.json({
        kid: 'https://my-vault.vault.azure.net/keys/kek/v7',
        value: toB64Url(seal(fromB64Url(j.value))),
      });
    });
    const seen: Seen[] = [];
    const w = new AzureKeyVaultWrapper({
      vaultUrl: 'https://my-vault.vault.azure.net',
      keyName: 'kek',
      tenantId: 'tenant-1',
      clientId: 'app-id',
      clientSecret: 'app-secret',
      algorithm: 'RSA-OAEP-256',
      authority: 'https://login.microsoftonline.com',
      apiVersion: '7.4',
      fetch: mockFetch(
        { 'login.microsoftonline.com': login, 'my-vault.vault.azure.net': vault },
        seen,
      ),
      nowMs: () => Date.now(),
    });
    const p = pt();
    const ct = await w.wrap(p);
    expect(JSON.parse(new TextDecoder().decode(ct)).kid).toBe(
      'https://my-vault.vault.azure.net/keys/kek/v7',
    );
    expect(await w.unwrap(ct)).toEqual(p);
    expect(tokenCalls).toBe(1);
    // A blob claiming another vault is refused before any request.
    const foreign = utf8.encode(JSON.stringify({ kid: 'https://evil.test/keys/x/1', value: 'AA' }));
    await expect(w.unwrap(foreign)).rejects.toThrow(/different vault/);
  });
});

describe('HashiCorp Vault Transit', () => {
  test('uses the transit encrypt/decrypt paths with token and namespace', async () => {
    const app = new Hono();
    app.post('/v1/kv-transit/encrypt/beamhop', async (c) => {
      expect(c.req.header('x-vault-token')).toBe('s.token');
      expect(c.req.header('x-vault-namespace')).toBe('team');
      const j = (await c.req.json()) as { plaintext: string };
      return c.json({ data: { ciphertext: `vault:v1:${toB64(seal(fromB64(j.plaintext)))}` } });
    });
    app.post('/v1/kv-transit/decrypt/beamhop', async (c) => {
      const j = (await c.req.json()) as { ciphertext: string };
      expect(j.ciphertext.startsWith('vault:v1:')).toBe(true);
      return c.json({ data: { plaintext: toB64(seal(fromB64(j.ciphertext.slice(9)))) } });
    });
    const seen: Seen[] = [];
    const w = new VaultTransitWrapper({
      address: 'https://vault.internal:8200',
      token: 's.token',
      keyName: 'beamhop',
      mount: 'kv-transit',
      namespace: 'team',
      fetch: mockFetch({ 'vault.internal:8200': app }, seen),
    });
    const p = pt();
    const ct = await w.wrap(p);
    expect(new TextDecoder().decode(ct)).toMatch(/^vault:v1:/);
    expect(await w.unwrap(ct)).toEqual(p);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/v1/kv-transit/encrypt/beamhop',
      '/v1/kv-transit/decrypt/beamhop',
    ]);
  });

  test('rotation from a local master key to Vault re-wraps data keys', async () => {
    const app = new Hono();
    app.post('/v1/transit/encrypt/k', async (c) => {
      const j = (await c.req.json()) as { plaintext: string };
      return c.json({ data: { ciphertext: `vault:v1:${toB64(seal(fromB64(j.plaintext)))}` } });
    });
    app.post('/v1/transit/decrypt/k', async (c) => {
      const j = (await c.req.json()) as { ciphertext: string };
      return c.json({ data: { plaintext: toB64(seal(fromB64(j.ciphertext.slice(9)))) } });
    });
    const vault = new VaultTransitWrapper({
      address: 'https://vault.internal:8200',
      token: 't',
      keyName: 'k',
      mount: 'transit',
      fetch: mockFetch({ 'vault.internal:8200': app }, []),
    });
    const old = await LocalMasterKeyWrapper.fromString(randomMasterKey());
    const docs = new MemoryDocStore();
    const e1 = new Envelope(docs, new FakeClock(), () => ({ current: old, previous: [] }));
    const ct = await e1.encrypt('acme', utf8.encode('data'));
    const e2 = new Envelope(docs, new FakeClock(), () => ({ current: vault, previous: [old] }));
    expect((await e2.rotate()).rewrapped).toBe(1);
    const e3 = new Envelope(docs, new FakeClock(), () => ({ current: vault, previous: [] }));
    expect(await e3.decrypt(ct)).toEqual(utf8.encode('data'));
  });
});
