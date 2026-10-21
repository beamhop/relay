// SPDX-License-Identifier: AGPL-3.0-or-later
// Delayed commit with undo (PLAN §6.2 "undo toasts instead of confirmations; destructive actions
// get a delayed commit"). A swipe action schedules its work; nothing is signed or sent until the
// undo window ends. Undo inside the window drops it without anything leaving the device.

export type PendingItem = {
  id: string
  /** Same key = same thing (e.g. "remove:<event id>"); a second schedule is a no-op. */
  key: string
  commitAt: number
}

export type PendingState = {items: PendingItem[]}

export type PendingEvent =
  {type: "schedule"; item: PendingItem} | {type: "undo"; id: string} | {type: "commit"; id: string}

export const initialPendingState = (): PendingState => ({items: []})

export const pendingReducer = (state: PendingState, event: PendingEvent): PendingState => {
  switch (event.type) {
    case "schedule":
      if (state.items.some(i => i.key === event.item.key || i.id === event.item.id)) return state
      return {items: [...state.items, event.item]}
    case "undo":
    case "commit":
      return {items: state.items.filter(i => i.id !== event.id)}
  }
}

export type ScheduleOptions = {
  key: string
  /** The real work: publish the moderation event, etc. Runs once, after the window. */
  commit: () => void | Promise<void>
  /** Restores what the optimistic UI changed. */
  onUndo?: () => void
}

type Timer = unknown

export type UndoQueueDeps = {
  delayMs: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (t: Timer) => void
  onChange?: (state: PendingState) => void
}

let seq = 0

export const createUndoQueue = ({
  delayMs,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = t => clearTimeout(t as ReturnType<typeof setTimeout>),
  onChange,
}: UndoQueueDeps) => {
  let state = initialPendingState()
  const jobs = new Map<string, {opts: ScheduleOptions; timer: Timer}>()

  const dispatch = (event: PendingEvent) => {
    const next = pendingReducer(state, event)
    if (next !== state) {
      state = next
      onChange?.(state)
    }
  }

  const run = (id: string) => {
    const job = jobs.get(id)
    if (!job) return undefined
    jobs.delete(id)
    clearTimer(job.timer)
    dispatch({type: "commit", id})
    return job.opts.commit()
  }

  return {
    get state() {
      return state
    },
    /** Returns the pending id (the existing one when the same key is already waiting). */
    schedule(opts: ScheduleOptions): string {
      const existing = state.items.find(i => i.key === opts.key)
      if (existing) return existing.id
      const id = `undo-${++seq}`
      const timer = setTimer(() => void run(id), delayMs)
      jobs.set(id, {opts, timer})
      dispatch({type: "schedule", item: {id, key: opts.key, commitAt: now() + delayMs}})
      return id
    },
    /** Cancel inside the window. False when it already committed (or never existed). */
    undo(id: string): boolean {
      const job = jobs.get(id)
      if (!job) return false
      jobs.delete(id)
      clearTimer(job.timer)
      dispatch({type: "undo", id})
      job.opts.onUndo?.()
      return true
    },
    isPending(key: string) {
      return state.items.some(i => i.key === key)
    },
    /** Commit everything now (e.g. the page is being hidden/closed). */
    flush() {
      return Promise.all([...jobs.keys()].map(id => run(id)))
    },
  }
}

export type UndoQueue = ReturnType<typeof createUndoQueue>
