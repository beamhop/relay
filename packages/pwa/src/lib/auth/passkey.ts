// SPDX-License-Identifier: AGPL-3.0-or-later
/** Passkey (WebAuthn) sign-up and sign-in against the admin API. */
import type { ApiClient } from '../api/client.ts';
import type { SessionResponse, SignInCodes } from '../api/types.ts';

interface OptionsResponse {
  challengeId: string;
  options: unknown;
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** Create a passkey. With codes (claim/invite/recovery) this also signs in a new admin. */
export async function registerPasskey(
  api: ApiClient,
  codes: SignInCodes & { label?: string },
): Promise<SessionResponse | { ok: true }> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const opts = await api.post<OptionsResponse>('/auth/passkey/register/options', codes, {
    auth: !!api.session,
  });
  const response = await startRegistration({ optionsJSON: opts.options as never });
  const res = await api.post<SessionResponse | { ok: true }>(
    '/auth/passkey/register/verify',
    { challengeId: opts.challengeId, response, label: codes.label },
    { auth: false },
  );
  if ('token' in res) api.setSession({ token: res.token, expiresAt: res.expiresAt });
  return res;
}

export async function signInWithPasskey(
  api: ApiClient,
  recoveryCode?: string,
): Promise<SessionResponse> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const opts = await api.post<OptionsResponse>('/auth/passkey/login/options', {}, { auth: false });
  const response = await startAuthentication({ optionsJSON: opts.options as never });
  const body: Record<string, unknown> = { challengeId: opts.challengeId, response };
  if (recoveryCode) body.recoveryCode = recoveryCode;
  const res = await api.post<SessionResponse>('/auth/passkey/login/verify', body, { auth: false });
  api.setSession({ token: res.token, expiresAt: res.expiresAt });
  return res;
}
