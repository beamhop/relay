// SPDX-License-Identifier: AGPL-3.0-or-later
// Company people directory from the IdP (PLAN §13 "Directory").
// `GET /api/v1/team/directory` (same origin, team session cookie) -> {people: DirectoryPerson[]}.
// Gated by `features.directory` in config.json; shown at <base>/directory.

import {writable} from "svelte/store"
import {isFeatureEnabled} from "../config"

export const TEAM_DIRECTORY_ENDPOINT = "/api/v1/team/directory"

export type DirectoryPerson = {
  /** Hex pubkey bound to the company account. */
  pubkey: string
  name: string
  email?: string
  title?: string
  department?: string
  picture?: string
}

export type DirectoryState = {
  loading: boolean
  people: DirectoryPerson[]
  /** "signed-out" when there is no company session (sign in with SSO first). */
  error?: "signed-out" | "unavailable"
}

export const directory = writable<DirectoryPerson[]>([])

export const directoryState = writable<DirectoryState>({loading: false, people: []})

export const isDirectoryEnabled = () => isFeatureEnabled("directory")

const HEX64 = /^[0-9a-f]{64}$/

const optional = (v: unknown) => (typeof v === "string" && v ? v : undefined)

/** Keep well-formed entries only; pictures must be http(s) or data-less same-origin paths. */
export const parseDirectory = (raw: unknown): DirectoryPerson[] => {
  const list = (raw as {people?: unknown})?.people

  if (!Array.isArray(list)) return []

  const out: DirectoryPerson[] = []

  for (const p of list) {
    if (typeof p !== "object" || p === null) continue

    const r = p as Record<string, unknown>

    if (typeof r.pubkey !== "string" || !HEX64.test(r.pubkey)) continue
    if (typeof r.name !== "string") continue

    const person: DirectoryPerson = {pubkey: r.pubkey, name: r.name || r.pubkey.slice(0, 8)}
    const email = optional(r.email)
    const title = optional(r.title)
    const department = optional(r.department)
    const picture = optional(r.picture)

    if (email) person.email = email
    if (title) person.title = title
    if (department) person.department = department
    if (picture && /^(https?:\/\/|\/(?!\/))/.test(picture)) person.picture = picture

    out.push(person)
  }

  return out
}

/** Case-insensitive search over name, email, title and department. */
export const filterDirectory = (people: DirectoryPerson[], term: string) => {
  const q = term.trim().toLowerCase()

  if (!q) return people

  return people.filter(p =>
    [p.name, p.email, p.title, p.department].some(v => v?.toLowerCase().includes(q)),
  )
}

/** People grouped by department (alphabetical; "Other" last). */
export const groupByDepartment = (people: DirectoryPerson[]) => {
  const groups = new Map<string, DirectoryPerson[]>()

  for (const p of people) {
    const key = p.department ?? ""

    groups.set(key, [...(groups.get(key) ?? []), p])
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([department, members]) => ({
      department,
      people: members.sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

/** Fetch the directory into the stores. No-op when the feature is off. */
export const loadDirectory = async (fetchImpl: typeof fetch = fetch) => {
  if (!isDirectoryEnabled()) return []

  directoryState.update(s => ({...s, loading: true, error: undefined}))

  try {
    const res = await fetchImpl(TEAM_DIRECTORY_ENDPOINT, {
      credentials: "same-origin",
      headers: {accept: "application/json"},
    })

    if (!res.ok) {
      directoryState.set({
        loading: false,
        people: [],
        error: res.status === 401 ? "signed-out" : "unavailable",
      })

      return []
    }

    const people = parseDirectory(await res.json())

    directory.set(people)
    directoryState.set({loading: false, people})

    return people
  } catch (e) {
    console.warn("[beamhop] could not load the company directory", e)
    directoryState.set({loading: false, people: [], error: "unavailable"})

    return []
  }
}
