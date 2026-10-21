// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension point (Wave 4): company SSO sign-in.
//
// Flow: the user signs in with the company IdP on Beamhop; `POST /api/v1/team/session` (same
// origin, cookie auth) returns a NIP-46 bunker URL for the user's bound npub (managed key via
// Beamhop's built-in bunker, PLAN §13). The client then logs in with upstream's NIP-46 flow.
// Gated by `features.sso` in config.json. No backend exists yet; this only defines the contract.

import {isFeatureEnabled} from "../config"

export const TEAM_SESSION_ENDPOINT = "/api/v1/team/session"

export type TeamSession = {
  /** bunker://<remote-signer-pubkey>?relay=wss://...&secret=... */
  bunkerUrl: string
  /** Hex pubkey of the signed-in user, if Beamhop knows it. */
  pubkey?: string
}

export const isSsoEnabled = () => isFeatureEnabled("sso")

/** Ask Beamhop for a bunker URL for the SSO-authenticated user. */
export const requestTeamSession = async (fetchImpl: typeof fetch = fetch): Promise<TeamSession> => {
  if (!isSsoEnabled()) {
    throw new Error("SSO sign-in is not enabled on this workspace")
  }

  const res = await fetchImpl(TEAM_SESSION_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: {accept: "application/json"},
  })

  if (res.status === 401) {
    // Not signed in with the IdP yet: Beamhop is expected to redirect to the IdP and back.
    throw new Error("Sign in with your company account first")
  }

  if (!res.ok) {
    throw new Error(`Could not start a team session (${res.status})`)
  }

  const body = (await res.json()) as Partial<TeamSession>

  if (typeof body.bunkerUrl !== "string" || !body.bunkerUrl.startsWith("bunker://")) {
    throw new Error("Beamhop returned an invalid session")
  }

  return {bunkerUrl: body.bunkerUrl, pubkey: body.pubkey}
}
