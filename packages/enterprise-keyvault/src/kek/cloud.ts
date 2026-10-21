// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloud KEK providers as thin fetch clients (Bun and Workers):
 * - AWS KMS (SigV4 via aws4fetch)
 * - Google Cloud KMS (service-account JWT → OAuth2 token, via jose)
 * - Azure Key Vault (Entra ID client-credentials → wrapkey/unwrapkey)
 * - HashiCorp Vault Transit (token auth)
 */
import { AwsClient } from 'aws4fetch';
import { SignJWT, importPKCS8 } from 'jose';
import { type FetchLike, fromB64, fromB64Url, fromUtf8, toB64, toB64Url, utf8 } from '../bytes.ts';
import { type KekProvider, KmsError, TokenCache, expectOk } from './types.ts';

// ───────────────────────────── AWS KMS ─────────────────────────────

export interface AwsKmsOptions {
  region: string;
  keyId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  fetch: FetchLike;
}

export class AwsKmsWrapper implements KekProvider {
  readonly provider = 'aws-kms';
  readonly id: string;
  private readonly aws: AwsClient;
  private readonly url: string;

  constructor(private readonly o: AwsKmsOptions) {
    this.id = `aws-kms:${o.keyId}`;
    this.url = o.endpoint ?? `https://kms.${o.region}.amazonaws.com/`;
    this.aws = new AwsClient({
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      ...(o.sessionToken ? { sessionToken: o.sessionToken } : {}),
      service: 'kms',
      region: o.region,
    });
  }

  private async call(target: 'Encrypt' | 'Decrypt', body: unknown): Promise<unknown> {
    const req = await this.aws.sign(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `TrentService.${target}`,
      },
      body: JSON.stringify(body),
    });
    return expectOk(this.provider, await this.o.fetch(req), target);
  }

  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const r = (await this.call('Encrypt', {
      KeyId: this.o.keyId,
      Plaintext: toB64(plaintext),
    })) as { CiphertextBlob?: string };
    if (!r.CiphertextBlob) throw new KmsError(this.provider, 200, 'Encrypt returned no ciphertext');
    return fromB64(r.CiphertextBlob);
  }

  async unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    const r = (await this.call('Decrypt', {
      KeyId: this.o.keyId,
      CiphertextBlob: toB64(ciphertext),
    })) as { Plaintext?: string };
    if (!r.Plaintext) throw new KmsError(this.provider, 200, 'Decrypt returned no plaintext');
    return fromB64(r.Plaintext);
  }
}

// ───────────────────────────── Google Cloud KMS ─────────────────────────────

export interface GcpKmsOptions {
  keyName: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  endpoint: string;
  fetch: FetchLike;
  nowMs: () => number;
}

export const GCP_KMS_SCOPE = 'https://www.googleapis.com/auth/cloudkms';

export class GcpKmsWrapper implements KekProvider {
  readonly provider = 'gcp-kms';
  readonly id: string;
  private readonly tokens: TokenCache;

  constructor(private readonly o: GcpKmsOptions) {
    this.id = `gcp-kms:${o.keyName}`;
    this.tokens = new TokenCache(o.nowMs, () => this.fetchToken());
  }

  private async fetchToken(): Promise<{ token: string; expiresIn: number }> {
    const key = await importPKCS8(this.o.privateKey, 'RS256');
    const now = Math.floor(this.o.nowMs() / 1000);
    const assertion = await new SignJWT({ scope: GCP_KMS_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.o.clientEmail)
      .setSubject(this.o.clientEmail)
      .setAudience(this.o.tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await this.o.fetch(this.o.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const j = (await expectOk(this.provider, res, 'token')) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!j.access_token)
      throw new KmsError(this.provider, 200, 'token response had no access_token');
    return { token: j.access_token, expiresIn: j.expires_in ?? 3600 };
  }

  private async call(op: 'encrypt' | 'decrypt', body: unknown): Promise<unknown> {
    const token = await this.tokens.get();
    const res = await this.o.fetch(
      `${this.o.endpoint.replace(/\/$/, '')}/v1/${this.o.keyName}:${op}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 401) this.tokens.clear();
    return expectOk(this.provider, res, op);
  }

  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const r = (await this.call('encrypt', { plaintext: toB64(plaintext) })) as {
      ciphertext?: string;
    };
    if (!r.ciphertext) throw new KmsError(this.provider, 200, 'encrypt returned no ciphertext');
    return fromB64(r.ciphertext);
  }

  async unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    const r = (await this.call('decrypt', { ciphertext: toB64(ciphertext) })) as {
      plaintext?: string;
    };
    if (!r.plaintext) throw new KmsError(this.provider, 200, 'decrypt returned no plaintext');
    return fromB64(r.plaintext);
  }
}

// ───────────────────────────── Azure Key Vault ─────────────────────────────

export interface AzureKeyVaultOptions {
  vaultUrl: string;
  keyName: string;
  keyVersion?: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  algorithm: string;
  authority: string;
  apiVersion: string;
  fetch: FetchLike;
  nowMs: () => number;
}

export const AZURE_VAULT_SCOPE = 'https://vault.azure.net/.default';

/**
 * Wrapped bytes are the UTF-8 JSON `{ kid, value }`: unwrap must target the exact
 * key version (`kid`) that wrapped the data.
 */
export class AzureKeyVaultWrapper implements KekProvider {
  readonly provider = 'azure-keyvault';
  readonly id: string;
  private readonly tokens: TokenCache;
  private readonly base: string;

  constructor(private readonly o: AzureKeyVaultOptions) {
    this.base = o.vaultUrl.replace(/\/$/, '');
    this.id = `azure-keyvault:${this.base}/keys/${o.keyName}${o.keyVersion ? `/${o.keyVersion}` : ''}`;
    this.tokens = new TokenCache(o.nowMs, () => this.fetchToken());
  }

  private async fetchToken(): Promise<{ token: string; expiresIn: number }> {
    const url = `${this.o.authority.replace(/\/$/, '')}/${encodeURIComponent(this.o.tenantId)}/oauth2/v2.0/token`;
    const res = await this.o.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.o.clientId,
        client_secret: this.o.clientSecret,
        scope: AZURE_VAULT_SCOPE,
      }).toString(),
    });
    const j = (await expectOk(this.provider, res, 'token')) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!j.access_token)
      throw new KmsError(this.provider, 200, 'token response had no access_token');
    return { token: j.access_token, expiresIn: Number(j.expires_in ?? 3600) };
  }

  private async call(url: string, body: unknown, what: string): Promise<unknown> {
    const token = await this.tokens.get();
    const sep = url.includes('?') ? '&' : '?';
    const res = await this.o.fetch(`${url}${sep}api-version=${this.o.apiVersion}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) this.tokens.clear();
    return expectOk(this.provider, res, what);
  }

  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const keyPath = `${this.base}/keys/${encodeURIComponent(this.o.keyName)}${
      this.o.keyVersion ? `/${encodeURIComponent(this.o.keyVersion)}` : ''
    }`;
    const r = (await this.call(
      `${keyPath}/wrapkey`,
      { alg: this.o.algorithm, value: toB64Url(plaintext) },
      'wrapkey',
    )) as { kid?: string; value?: string };
    if (!r.kid || !r.value) throw new KmsError(this.provider, 200, 'wrapkey returned no value');
    return utf8.encode(JSON.stringify({ kid: r.kid, value: r.value }));
  }

  async unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    let parsed: { kid?: string; value?: string };
    try {
      parsed = JSON.parse(fromUtf8.decode(ciphertext));
    } catch {
      throw new KmsError(this.provider, 0, 'wrapped key is not an Azure Key Vault blob');
    }
    if (!parsed.kid || !parsed.value)
      throw new KmsError(this.provider, 0, 'wrapped key is incomplete');
    const kidUrl = new URL(parsed.kid);
    if (kidUrl.origin !== new URL(this.base).origin)
      throw new KmsError(this.provider, 0, 'wrapped key belongs to a different vault');
    const r = (await this.call(
      `${kidUrl.origin}${kidUrl.pathname}/unwrapkey`,
      { alg: this.o.algorithm, value: parsed.value },
      'unwrapkey',
    )) as { value?: string };
    if (!r.value) throw new KmsError(this.provider, 200, 'unwrapkey returned no value');
    return fromB64Url(r.value);
  }
}

// ───────────────────────────── HashiCorp Vault Transit ─────────────────────────────

export interface VaultTransitOptions {
  address: string;
  token: string;
  keyName: string;
  mount: string;
  namespace?: string;
  fetch: FetchLike;
}

/** Wrapped bytes are the UTF-8 `vault:vN:…` ciphertext string. */
export class VaultTransitWrapper implements KekProvider {
  readonly provider = 'vault-transit';
  readonly id: string;
  private readonly base: string;

  constructor(private readonly o: VaultTransitOptions) {
    this.base = `${o.address.replace(/\/$/, '')}/v1/${o.mount.replace(/^\/|\/$/g, '')}`;
    this.id = `vault-transit:${this.base}/keys/${o.keyName}`;
  }

  private async call(op: 'encrypt' | 'decrypt', body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'X-Vault-Token': this.o.token,
      'Content-Type': 'application/json',
    };
    if (this.o.namespace) headers['X-Vault-Namespace'] = this.o.namespace;
    const res = await this.o.fetch(`${this.base}/${op}/${encodeURIComponent(this.o.keyName)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return expectOk(this.provider, res, op);
  }

  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const r = (await this.call('encrypt', { plaintext: toB64(plaintext) })) as {
      data?: { ciphertext?: string };
    };
    const ct = r.data?.ciphertext;
    if (!ct) throw new KmsError(this.provider, 200, 'encrypt returned no ciphertext');
    return utf8.encode(ct);
  }

  async unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    const r = (await this.call('decrypt', { ciphertext: fromUtf8.decode(ciphertext) })) as {
      data?: { plaintext?: string };
    };
    const pt = r.data?.plaintext;
    if (!pt) throw new KmsError(this.provider, 200, 'decrypt returned no plaintext');
    return fromB64(pt);
  }
}
