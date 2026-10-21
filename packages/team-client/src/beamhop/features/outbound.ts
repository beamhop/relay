// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-group outbound relay allow (PLAN §12.10: "Team client federation: internal relays only by
// default; admin may allow outbound relays per group").
//
// Contract (served by Beamhop, same origin as the team client):
//
//   GET /.well-known/beamhop/network
//   200 {
//     "groups":  { "<NIP-29 group id (h tag)>": { "outbound": ["wss://…", …] } },
//     "default": { "outbound": ["wss://…", …] | null }
//   }
//
// - `outbound` lists the relays a group's content may be published to, on top of the home relay
//   (which is always allowed). `[]` = home relay only.
// - `default.outbound` applies to groups not listed; `null` (or missing) = no restriction.
// - 404 / network error / invalid JSON = no policy published: publishing behaves as before.
//
// The client enforces it by wrapping the welshman Publisher: an event carrying an `h` tag is only
// sent to the relays allowed for that group. Events without an `h` tag (DMs, profiles, …) are
// left to the federation socket policy (federation.ts).

import {derived, get, writable} from "svelte/store"
import type {AppPolicy} from "@welshman/app"
import {Publisher} from "@welshman/app"
import {normalizeRelayUrl} from "@welshman/util"
import {getHomeRelay} from "../env"

export const NETWORK_POLICY_PATH = "/.well-known/beamhop/network"

export type OutboundPolicy = {
  groups: Record<string, {outbound: string[]}>
  default: {outbound: string[] | null}
}

const normalize = (url: string) => {
  try {
    return normalizeRelayUrl(url)
  } catch {
    return url
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isRelayUrl = (value: unknown): value is string =>
  typeof value === "string" && /^wss?:\/\/[^\s]+$/i.test(value.trim())

const relayList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? [...new Set(value.filter(isRelayUrl).map(u => normalize(u.trim())))]
    : undefined

/** Defensive parse. Returns null when the document says nothing usable (= no policy). */
export const parseOutboundPolicy = (raw: unknown): OutboundPolicy | null => {
  if (!isRecord(raw)) return null

  const groups: OutboundPolicy["groups"] = {}

  if (isRecord(raw.groups)) {
    for (const [id, entry] of Object.entries(raw.groups)) {
      const outbound = isRecord(entry) ? relayList(entry.outbound) : undefined

      if (id && outbound) groups[id] = {outbound}
    }
  }

  const defaultOutbound = isRecord(raw.default) ? (relayList(raw.default.outbound) ?? null) : null

  if (Object.keys(groups).length === 0 && defaultOutbound === null) return null

  return {groups, default: {outbound: defaultOutbound}}
}

export const groupIdOf = (tags: string[][]): string | undefined =>
  tags.find(t => t[0] === "h" && typeof t[1] === "string" && t[1] !== "")?.[1]

/**
 * Relays a group may publish to (normalized, home relay first), or null when the group is not
 * restricted (no policy, or not listed and no default).
 */
export const allowedRelaysForGroup = (
  policy: OutboundPolicy | null,
  groupId: string,
  homeRelay: string | undefined,
): string[] | null => {
  if (!policy) return null

  const outbound = policy.groups[groupId]?.outbound ?? policy.default.outbound

  if (outbound === null) return null

  return [...new Set([...(homeRelay ? [normalize(homeRelay)] : []), ...outbound])]
}

export type SelectInput = {
  tags: string[][]
  relays: string[]
  policy: OutboundPolicy | null
  homeRelay: string | undefined
  /** False until the policy fetch finished; group content then only goes to the home relay. */
  loaded?: boolean
}

/** The relays an event is actually published to. Unrestricted events keep their relays as-is. */
export const selectPublishRelays = ({
  tags,
  relays,
  policy,
  homeRelay,
  loaded = true,
}: SelectInput): string[] => {
  const groupId = groupIdOf(tags)

  if (!groupId) return relays

  if (!loaded) {
    // Fail closed for the moment before the policy is known.
    const home = homeRelay ? normalize(homeRelay) : undefined

    return relays.filter(r => normalize(r) === home)
  }

  const allowed = allowedRelaysForGroup(policy, groupId, homeRelay)

  if (!allowed) return relays

  const set = new Set(allowed)

  return relays.filter(r => set.has(normalize(r)))
}

// Runtime state ----------------------------------------------------------------------------------

export const outboundPolicy = writable<OutboundPolicy | null>(null)

export const outboundPolicyLoaded = writable(false)

/** Store of the allowed relays for a group (null = not restricted). */
export const deriveGroupOutbound = (groupId: string) =>
  derived(outboundPolicy, $policy => allowedRelaysForGroup($policy, groupId, getHomeRelay()))

const FETCH_TIMEOUT_MS = 5000

let loading: Promise<OutboundPolicy | null> | undefined

/** Fetch the policy once. Any failure means "no policy" (behave as today). */
export const loadOutboundPolicy = (fetchImpl: typeof fetch = fetch) => {
  loading ??= (async () => {
    try {
      const res = await fetchImpl(NETWORK_POLICY_PATH, {
        cache: "no-store",
        credentials: "same-origin",
        headers: {accept: "application/json"},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (res.ok) {
        outboundPolicy.set(parseOutboundPolicy(await res.json()))
      }
    } catch {
      // not published (or unreachable): no restriction beyond the federation allowlist
    } finally {
      outboundPolicyLoaded.set(true)
    }

    return get(outboundPolicy)
  })()

  return loading
}

/** Test hook. */
export const resetOutboundPolicy = () => {
  loading = undefined
  outboundPolicy.set(null)
  outboundPolicyLoaded.set(false)
}

/** Welshman app policy: every publish of group content goes only to that group's relays. */
export const outboundPublishPolicy: AppPolicy = $app => {
  const publisher = $app.use(Publisher)
  const original = publisher.publish

  publisher.publish = request =>
    original({
      ...request,
      relays: selectPublishRelays({
        tags: request.event.tags,
        relays: request.relays,
        policy: get(outboundPolicy),
        homeRelay: getHomeRelay(),
        loaded: get(outboundPolicyLoaded),
      }),
    })

  return () => {
    publisher.publish = original
  }
}
