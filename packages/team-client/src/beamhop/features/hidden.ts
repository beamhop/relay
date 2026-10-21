// SPDX-License-Identifier: AGPL-3.0-or-later
// "Hide" from a swipe: rows hidden on this device only (nothing is published).
//
// - Messages: hidden for good (`msg:<event id>`).
// - Inbox rows: hidden until a newer message arrives (`inbox:<path>` → id of the latest event when
//   it was hidden).
// - Pending removals (admin "Remove" inside its undo window) are hidden in memory only, so a
//   removal that never got sent (tab closed) shows the message again next time.

import {derived, get, writable} from "svelte/store"

const STORAGE_KEY = "beamhop.hidden"

/** Hidden keys are capped so storage cannot grow without bound. */
export const MAX_HIDDEN = 500

const read = (): Record<string, string> => {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const write = (value: Record<string, string>) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // private mode / storage full: hiding still works for this session
  }
}

export const hiddenRows = writable<Record<string, string>>(read())

export const pendingRemovals = writable<Set<string>>(new Set())

hiddenRows.subscribe(write)

/** Keeps the newest `max` entries (insertion order). */
export const capHidden = (value: Record<string, string>, max = MAX_HIDDEN) => {
  const entries = Object.entries(value)
  return entries.length > max ? Object.fromEntries(entries.slice(entries.length - max)) : value
}

const setKey = (key: string, value: string) =>
  hiddenRows.update($h => {
    const next = {...$h}
    delete next[key]
    next[key] = value
    return capHidden(next)
  })

const unsetKey = (key: string) =>
  hiddenRows.update($h => {
    if (!(key in $h)) return $h
    const next = {...$h}
    delete next[key]
    return next
  })

export const hideMessage = (id: string) => setKey(`msg:${id}`, "1")

export const unhideMessage = (id: string) => unsetKey(`msg:${id}`)

export const hideInboxRow = (path: string, latestEventId: string) =>
  setKey(`inbox:${path}`, latestEventId)

export const unhideInboxRow = (path: string) => unsetKey(`inbox:${path}`)

/** Previous value, so an undo can restore exactly what was there. */
export const getInboxHidden = (path: string): string | undefined => get(hiddenRows)[`inbox:${path}`]

export const markPendingRemoval = (id: string) => pendingRemovals.update($p => new Set([...$p, id]))

export const clearPendingRemoval = (id: string) =>
  pendingRemovals.update($p => {
    const next = new Set($p)
    next.delete(id)
    return next
  })

export const isMessageHidden = (
  hidden: Record<string, string>,
  pending: Set<string>,
  id: string,
): boolean => pending.has(id) || hidden[`msg:${id}`] === "1"

export const isInboxRowHidden = (
  hidden: Record<string, string>,
  path: string,
  latestEventId: string,
): boolean => hidden[`inbox:${path}`] === latestEventId

export const messageHidden = derived(
  [hiddenRows, pendingRemovals],
  ([$hidden, $pending]) =>
    (id: string) =>
      isMessageHidden($hidden, $pending, id),
)

export const inboxRowHidden = derived(
  hiddenRows,
  $hidden => (path: string, latestEventId: string) =>
    isInboxRowHidden($hidden, path, latestEventId),
)
