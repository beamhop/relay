// SPDX-License-Identifier: AGPL-3.0-or-later
// Company SSO sign-in (PLAN §13, §12.2). After the IdP sign-in (cookie on this origin),
// `POST /api/v1/team/session` says how this person signs Nostr events:
//
//   {mode: "managed", pubkey, bunkerUrl}  company-held key -> log in through Beamhop's NIP-46 bunker
//   {mode: "self-custody", pubkey}        the person's own signer (NIP-07 / NIP-46); it must be
//                                         the key bound to their company account
//   {mode: "link-required", linkUrl}      no key bound yet: GET linkUrl for a challenge, sign it
//                                         with the person's signer, POST {event}, then ask again
//
// The orchestration below takes its effects (fetch, bunker login, user signer) as parameters so
// it is testable without a browser; src/beamhop/components/SsoConnect.svelte wires it to welshman.
// Gated by `features.sso` in config.json.

import {isFeatureEnabled} from "../config"

export const TEAM_SESSION_ENDPOINT = "/api/v1/team/session"
export const TEAM_LINK_ENDPOINT = "/api/v1/team/link"

export type TeamSession =
  | {mode: "managed"; pubkey: string; bunkerUrl: string}
  | {mode: "self-custody"; pubkey: string}
  | {mode: "link-required"; linkUrl: string}

export type LinkChallenge = {
  challenge: string
  expiresAt: number
  /** Event kinds Beamhop accepts for the proof (22242 NIP-42 style, 27235 NIP-98 style). */
  kinds: number[]
  /** Tag name that must carry the challenge. */
  tag: string
}

export type EventTemplate = {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export type SignedEvent = EventTemplate & {id: string; pubkey: string; sig: string}

export class TeamSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      "disabled" | "signed-out" | "invalid" | "no-signer" | "wrong-key" | "link-failed" | "http",
    readonly status?: number,
  ) {
    super(message)
    this.name = "TeamSessionError"
  }
}

export const isSsoEnabled = () => isFeatureEnabled("sso")

const HEX64 = /^[0-9a-f]{64}$/

/** Same-origin API path only (the server names the link endpoint; never follow another origin). */
const sameOriginPath = (path: unknown, fallback: string) =>
  typeof path === "string" && path.startsWith("/api/") && !path.startsWith("//") ? path : fallback

/** Validate the session answer (unknown shapes are rejected, not guessed). */
export const parseTeamSession = (raw: unknown): TeamSession => {
  const body = (raw ?? {}) as Record<string, unknown>
  const pubkey = typeof body.pubkey === "string" ? body.pubkey.toLowerCase() : ""

  switch (body.mode) {
    case "managed":
      if (
        HEX64.test(pubkey) &&
        typeof body.bunkerUrl === "string" &&
        body.bunkerUrl.startsWith("bunker://")
      ) {
        return {mode: "managed", pubkey, bunkerUrl: body.bunkerUrl}
      }
      break
    case "self-custody":
      if (HEX64.test(pubkey)) return {mode: "self-custody", pubkey}
      break
    case "link-required":
      return {mode: "link-required", linkUrl: sameOriginPath(body.linkUrl, TEAM_LINK_ENDPOINT)}
    default:
      // Older servers answered {bunkerUrl, pubkey?} without a mode.
      if (
        typeof body.bunkerUrl === "string" &&
        body.bunkerUrl.startsWith("bunker://") &&
        HEX64.test(pubkey)
      ) {
        return {mode: "managed", pubkey, bunkerUrl: body.bunkerUrl}
      }
  }

  throw new TeamSessionError("Beamhop returned an invalid session", "invalid")
}

const errorMessage = async (res: Response, fallback: string) => {
  try {
    const body = (await res.json()) as {error?: unknown}

    if (typeof body.error === "string") return body.error
    if (body.error && typeof (body.error as {message?: unknown}).message === "string") {
      return (body.error as {message: string}).message
    }
  } catch {
    // not JSON
  }

  return fallback
}

/** Ask Beamhop how the SSO-authenticated person signs. */
export const requestTeamSession = async (fetchImpl: typeof fetch = fetch): Promise<TeamSession> => {
  if (!isSsoEnabled()) {
    throw new TeamSessionError("SSO sign-in is not enabled on this workspace", "disabled")
  }

  const res = await fetchImpl(TEAM_SESSION_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: {accept: "application/json"},
  })

  if (res.status === 401) {
    throw new TeamSessionError(
      await errorMessage(res, "Sign in with your company account first"),
      "signed-out",
      401,
    )
  }

  if (!res.ok) {
    throw new TeamSessionError(
      await errorMessage(res, `Could not start a team session (${res.status})`),
      "http",
      res.status,
    )
  }

  return parseTeamSession(await res.json())
}

export const requestLinkChallenge = async (
  linkUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkChallenge> => {
  const res = await fetchImpl(sameOriginPath(linkUrl, TEAM_LINK_ENDPOINT), {
    credentials: "same-origin",
    headers: {accept: "application/json"},
  })

  if (!res.ok) {
    throw new TeamSessionError(
      await errorMessage(res, "Could not start linking your Nostr key"),
      "link-failed",
      res.status,
    )
  }

  const body = (await res.json()) as Partial<LinkChallenge>

  if (typeof body.challenge !== "string" || !body.challenge) {
    throw new TeamSessionError("Beamhop returned an invalid link challenge", "invalid")
  }

  return {
    challenge: body.challenge,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : 0,
    kinds: Array.isArray(body.kinds) && body.kinds.length ? body.kinds : [22242],
    tag: typeof body.tag === "string" && body.tag ? body.tag : "challenge",
  }
}

/** The event the person signs to prove they own the key (kind 22242, NIP-42 style). */
export const linkEventTemplate = (
  c: LinkChallenge,
  origin: string,
  now = Math.floor(Date.now() / 1000),
): EventTemplate => ({
  kind: c.kinds.includes(22242) ? 22242 : (c.kinds[0] ?? 22242),
  created_at: now,
  tags: [
    [c.tag, c.challenge],
    ["relay", origin],
  ],
  content: "",
})

export const submitLink = async (
  linkUrl: string,
  event: SignedEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<string> => {
  const res = await fetchImpl(sameOriginPath(linkUrl, TEAM_LINK_ENDPOINT), {
    method: "POST",
    credentials: "same-origin",
    headers: {accept: "application/json", "content-type": "application/json"},
    body: JSON.stringify({event}),
  })

  if (!res.ok) {
    throw new TeamSessionError(
      await errorMessage(res, "Beamhop could not link your Nostr key"),
      "link-failed",
      res.status,
    )
  }

  const body = (await res.json()) as {pubkey?: unknown}

  return typeof body.pubkey === "string" ? body.pubkey : event.pubkey
}

/** The person's own signer (NIP-07 extension or NIP-46 remote signer) for self-custody. */
export type UserSigner = {
  getPubkey: () => Promise<string>
  sign: (template: EventTemplate) => Promise<SignedEvent>
  /** Start the app session with this signer. */
  login: () => Promise<void>
}

export type TeamSignInDeps = {
  fetch?: typeof fetch
  /** Log in through Beamhop's bunker; must fail if the bunker's pubkey differs from `pubkey`. */
  loginWithBunker: (bunkerUrl: string, pubkey: string) => Promise<void>
  /** The person's own signer, or undefined when they have none connected. */
  userSigner: () => Promise<UserSigner | undefined>
  /** Origin used in the link proof (defaults to location.origin). */
  origin?: string
}

export type TeamSignInResult = {mode: "managed" | "self-custody"; pubkey: string; linked: boolean}

const requireSigner = async (deps: TeamSignInDeps) => {
  const signer = await deps.userSigner()

  if (!signer) {
    throw new TeamSessionError(
      "Connect your Nostr signer (browser extension or remote signer) to continue",
      "no-signer",
    )
  }

  return signer
}

/**
 * Run the whole company sign-in: managed key via bunker, self-custody with the person's signer
 * (pubkey must match), or link the person's key first and then sign in.
 */
export const signInWithTeamSession = async (deps: TeamSignInDeps): Promise<TeamSignInResult> => {
  const f = deps.fetch ?? fetch
  let linked = false

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await requestTeamSession(f)

    if (session.mode === "managed") {
      await deps.loginWithBunker(session.bunkerUrl, session.pubkey)

      return {mode: "managed", pubkey: session.pubkey, linked}
    }

    if (session.mode === "self-custody") {
      const signer = await requireSigner(deps)
      const pubkey = (await signer.getPubkey()).toLowerCase()

      if (pubkey !== session.pubkey) {
        throw new TeamSessionError(
          "This signer holds a different key than the one linked to your company account. Switch to the linked key, or ask an admin to reset the link.",
          "wrong-key",
        )
      }

      await signer.login()

      return {mode: "self-custody", pubkey, linked}
    }

    if (linked) break

    // link-required: prove key ownership once, then ask for the session again.
    const signer = await requireSigner(deps)
    const challenge = await requestLinkChallenge(session.linkUrl, f)
    const origin = deps.origin ?? (typeof location !== "undefined" ? location.origin : "")
    const event = await signer.sign(linkEventTemplate(challenge, origin))

    await submitLink(session.linkUrl, event, f)
    linked = true
  }

  throw new TeamSessionError(
    "Your key was linked, but Beamhop did not confirm it yet. Try again.",
    "link-failed",
  )
}
