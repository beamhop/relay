// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OIDC relying party on `oauth4webapi` (runtime-agnostic, Web APIs only):
 * discovery, PKCE authorization code flow, ID token validation.
 *
 * Provider quirks handled:
 * - Google Workspace: issuer `https://accounts.google.com`; `hd` sent as an auth
 *   parameter (UI hint only) AND enforced on the ID token `hd` claim. Google ID
 *   tokens carry no groups — groups come from Directory API sync.
 * - Microsoft Entra ID: issuer `https://login.microsoftonline.com/<tenant>/v2.0`.
 *   When the tenant is given as a domain name, discovery returns the GUID issuer;
 *   we accept it only if it has the canonical Entra shape. The stable subject is
 *   the `oid` claim (object id, same across apps and in SCIM/Graph) — `sub` is
 *   pairwise per app. Group overage (`_claim_names.groups`, >200 groups) is
 *   detected; groups then come from SCIM provisioning instead of the token.
 * - Generic OIDC (Okta, Keycloak, Authentik, Auth0, JumpCloud): `sub` + the
 *   configured groups claim (names or ids).
 *
 * oauth4webapi validates iss/aud/exp/iat/nonce of the ID token; we additionally
 * verify its JWS signature against the provider JWKS with `jose` (defence in depth,
 * the token endpoint is already TLS-authenticated).
 */
import { type JSONWebKeySet, createLocalJWKSet, jwtVerify } from 'jose';
import * as oauth from 'oauth4webapi';
import type { IdpConfig } from './config.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface IdClaims {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  groups: string[];
  /** Entra: too many groups for the token; keep provisioned groups. */
  groupsOverage: boolean;
  hd?: string;
  raw: Record<string, unknown>;
}

export interface PendingAuth {
  state: string;
  nonce: string;
  codeVerifier: string;
}

const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/;
const META_TTL_MS = 3600_000;

export function issuerOf(idp: IdpConfig): string {
  if (idp.issuer) return idp.issuer;
  if (idp.type === 'google') return 'https://accounts.google.com';
  if (idp.type === 'microsoft') {
    if (!idp.tenant) throw new Error('Microsoft sign-in needs your tenant id');
    return `https://login.microsoftonline.com/${idp.tenant}/v2.0`;
  }
  throw new Error('This sign-in provider needs an issuer address');
}

export class OidcClient {
  private meta = new Map<
    string,
    { as: oauth.AuthorizationServer; jwks?: JSONWebKeySet; at: number }
  >();

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly nowMs: () => number,
  ) {}

  private opts(idp: IdpConfig) {
    const f = this.fetchImpl;
    return {
      [oauth.customFetch]: (url: string, init: RequestInit) => f(url, init),
      [oauth.allowInsecureRequests]: idp.allowInsecure,
    } as oauth.HttpRequestOptions<'GET'>;
  }

  client(idp: IdpConfig): oauth.Client {
    return { client_id: idp.clientId };
  }

  clientAuth(idp: IdpConfig): oauth.ClientAuth {
    return idp.clientSecret ? oauth.ClientSecretPost(idp.clientSecret) : oauth.None();
  }

  forget(idpId?: string): void {
    if (idpId) this.meta.delete(idpId);
    else this.meta.clear();
  }

  async discover(idp: IdpConfig): Promise<oauth.AuthorizationServer> {
    const hit = this.meta.get(idp.id);
    if (hit && this.nowMs() - hit.at < META_TTL_MS) return hit.as;
    const issuer = new URL(issuerOf(idp));
    const res = await oauth.discoveryRequest(issuer, { ...this.opts(idp), algorithm: 'oidc' });
    let expected = issuer;
    if (idp.type === 'microsoft' && !idp.issuer) {
      const body = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { issuer?: unknown };
      if (typeof body.issuer === 'string' && ENTRA_ISSUER.test(body.issuer))
        expected = new URL(body.issuer);
    }
    const as = await oauth.processDiscoveryResponse(expected, res);
    this.meta.set(idp.id, { as, at: this.nowMs() });
    return as;
  }

  static async newPending(): Promise<PendingAuth> {
    return {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
    };
  }

  async authorizationUrl(idp: IdpConfig, redirectUri: string, p: PendingAuth): Promise<URL> {
    const as = await this.discover(idp);
    if (!as.authorization_endpoint) throw new Error('provider has no authorization endpoint');
    const url = new URL(as.authorization_endpoint);
    url.searchParams.set('client_id', idp.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', idp.scopes.join(' '));
    url.searchParams.set('state', p.state);
    url.searchParams.set('nonce', p.nonce);
    url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(p.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (idp.type === 'google' && idp.hostedDomain) url.searchParams.set('hd', idp.hostedDomain);
    if (idp.type === 'microsoft') url.searchParams.set('response_mode', 'query');
    return url;
  }

  /** Complete the code flow for the callback URL; throws on any validation failure. */
  async callback(
    idp: IdpConfig,
    redirectUri: string,
    currentUrl: URL,
    p: PendingAuth,
  ): Promise<IdClaims> {
    const as = await this.discover(idp);
    const client = this.client(idp);
    const params = oauth.validateAuthResponse(as, client, currentUrl, p.state);
    const res = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      this.clientAuth(idp),
      params,
      redirectUri,
      p.codeVerifier,
      this.opts(idp) as oauth.TokenEndpointRequestOptions,
    );
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, res, {
      expectedNonce: p.nonce,
      requireIdToken: true,
    });
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    if (!claims || !tokens.id_token) throw new Error('the provider did not return an ID token');
    await this.verifySignature(idp, as, tokens.id_token);
    return this.toClaims(idp, claims as unknown as Record<string, unknown>);
  }

  private async jwks(
    idp: IdpConfig,
    as: oauth.AuthorizationServer,
    force: boolean,
  ): Promise<JSONWebKeySet> {
    const hit = this.meta.get(idp.id);
    if (!force && hit?.jwks) return hit.jwks;
    if (!as.jwks_uri) throw new Error('provider has no JWKS');
    const res = await this.fetchImpl(as.jwks_uri, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`could not fetch provider keys (${res.status})`);
    const jwks = (await res.json()) as JSONWebKeySet;
    if (hit) hit.jwks = jwks;
    return jwks;
  }

  private async verifySignature(
    idp: IdpConfig,
    as: oauth.AuthorizationServer,
    idToken: string,
  ): Promise<void> {
    const check = async (force: boolean) =>
      jwtVerify(idToken, createLocalJWKSet(await this.jwks(idp, as, force)), {
        issuer: as.issuer,
        audience: idp.clientId,
        clockTolerance: 60,
      });
    try {
      await check(false);
    } catch {
      // Key rotation: refetch once.
      await check(true);
    }
  }

  toClaims(idp: IdpConfig, c: Record<string, unknown>): IdClaims {
    const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : undefined);
    if (idp.type === 'google' && idp.hostedDomain && str('hd') !== idp.hostedDomain)
      throw new Error(`only ${idp.hostedDomain} accounts can sign in here`);
    const subject = (idp.type === 'microsoft' ? (str('oid') ?? str('sub')) : str('sub')) ?? '';
    if (!subject) throw new Error('the ID token has no subject');
    const rawGroups = c[idp.groupsClaim];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === 'string')
      : [];
    const names = c._claim_names as Record<string, unknown> | undefined;
    const email =
      str('email') ?? (idp.type === 'microsoft' ? str('preferred_username') : undefined);
    const out: IdClaims = {
      subject,
      groups,
      groupsOverage: !!names && typeof names === 'object' && idp.groupsClaim in names,
      raw: c,
    };
    if (email) out.email = email.toLowerCase();
    if (typeof c.email_verified === 'boolean') out.emailVerified = c.email_verified;
    const name = str('name');
    if (name) out.name = name;
    const given = str('given_name');
    if (given) out.givenName = given;
    const family = str('family_name');
    if (family) out.familyName = family;
    const picture = str('picture');
    if (picture) out.picture = picture;
    const hd = str('hd');
    if (hd) out.hd = hd;
    return out;
  }
}
