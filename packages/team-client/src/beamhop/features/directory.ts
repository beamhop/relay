// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension point (Wave 4): company people directory from the IdP (PLAN §13 "Directory").
// `GET /api/v1/team/directory` (same origin) -> {people: DirectoryPerson[]}.
// Gated by `features.directory` in config.json. No backend exists yet.

import {writable} from "svelte/store"
import {isFeatureEnabled} from "../config"

export const TEAM_DIRECTORY_ENDPOINT = "/api/v1/team/directory"

export type DirectoryPerson = {
  pubkey: string
  name: string
  email?: string
  title?: string
  department?: string
  picture?: string
}

export const directory = writable<DirectoryPerson[]>([])

export const isDirectoryEnabled = () => isFeatureEnabled("directory")

const isPerson = (p: unknown): p is DirectoryPerson =>
  typeof p === "object" &&
  p !== null &&
  typeof (p as DirectoryPerson).pubkey === "string" &&
  typeof (p as DirectoryPerson).name === "string"

/** Fetch the directory into the `directory` store. No-op when the feature is off. */
export const loadDirectory = async (fetchImpl: typeof fetch = fetch) => {
  if (!isDirectoryEnabled()) return []

  try {
    const res = await fetchImpl(TEAM_DIRECTORY_ENDPOINT, {credentials: "same-origin"})

    if (!res.ok) return []

    const body = (await res.json()) as {people?: unknown[]}
    const people = (body.people ?? []).filter(isPerson)

    directory.set(people)

    return people
  } catch (e) {
    console.warn("[beamhop] could not load the company directory", e)

    return []
  }
}
