// SPDX-License-Identifier: AGPL-3.0-or-later
// What the swipe actions do. Every action shows an undo toast instead of a confirmation (PLAN
// §6.2). Destructive moderation (remove a message, remove a person from a room) is a delayed
// commit: the NIP-29 event is only built, signed and sent once the undo window has passed.

import {get} from "svelte/store"
import {assoc, dissoc} from "@welshman/lib"
import type {TrustedEvent} from "@welshman/util"
import {tagSpec, tagValue} from "@welshman/util"
import {app} from "@app/core/app"
import {relayManagement, rooms} from "@app/core/plugins"
import {AdminDelete, deriveUserAdminDelete} from "@app/features/rooms"
import {checked} from "@app/ui/notifications"
import {pushToast} from "@app/ui/toast"
import {createUndoQueue} from "../gestures/undo-queue"
import {
  clearPendingRemoval,
  getInboxHidden,
  hideInboxRow,
  hideMessage,
  markPendingRemoval,
  unhideInboxRow,
  unhideMessage,
} from "./hidden"

/** Undo window for destructive actions, and how long the undo toast stays. */
export const UNDO_MS = 6000

export const moderationQueue = createUndoQueue({delayMs: UNDO_MS})

if (typeof window !== "undefined") {
  // Leaving the page inside the window still sends what the admin asked for.
  window.addEventListener("pagehide", () => void moderationQueue.flush())
}

const undoToast = (message: string, undo: () => void) =>
  pushToast({message, timeout: UNDO_MS, action: {message: "Undo", onclick: undo}})

const errorToast = (message: string) => pushToast({theme: "error", message})

export const hideMessageWithUndo = (event: TrustedEvent) => {
  hideMessage(event.id)
  undoToast("Message hidden on this device.", () => unhideMessage(event.id))
}

export const hideInboxRowWithUndo = (path: string, event: TrustedEvent) => {
  const previous = getInboxHidden(path)

  hideInboxRow(path, event.id)
  undoToast("Conversation hidden until a new message arrives.", () =>
    previous ? hideInboxRow(path, previous) : unhideInboxRow(path),
  )
}

export const markReadWithUndo = (path: string) => {
  const previous = checked.get()[path]

  checked.update(assoc(path, Math.floor(Date.now() / 1000)))
  undoToast("Marked as read.", () =>
    checked.update(previous === undefined ? dissoc(path) : assoc(path, previous)),
  )
}

/** Admin: remove someone else's message (NIP-29 delete-event, or NIP-86 banevent space-wide). */
export const removeMessageWithUndo = (url: string, event: TrustedEvent) => {
  const h = tagValue(tagSpec("h"), event.tags) ?? ""

  markPendingRemoval(event.id)

  const id = moderationQueue.schedule({
    key: `remove:${event.id}`,
    onUndo: () => clearPendingRemoval(event.id),
    commit: async () => {
      let error: string | undefined

      try {
        const mode = get(deriveUserAdminDelete(url, event))

        if (mode === AdminDelete.Room) {
          const command = await rooms.get().deleteEvent(url, {h}, event.id)

          error = await command.publish().getError()
        } else if (mode === AdminDelete.Space) {
          error = (await relayManagement.get().forUrl(url).banEvent(event.id)).error
        } else {
          error = "You can no longer remove messages here."
        }
      } catch (e) {
        error = String(e)
      }

      clearPendingRemoval(event.id)

      if (error) {
        errorToast(`Could not remove the message: ${error}`)
      } else {
        app.get().repository.removeEvent(event.id)
      }
    },
  })

  undoToast("Message removed.", () => moderationQueue.undo(id))
}

/** Admin: remove the author from the room (NIP-29 remove-user). */
export const removeMemberWithUndo = (url: string, h: string, pubkey: string, name: string) => {
  const id = moderationQueue.schedule({
    key: `remove-member:${url}'${h}:${pubkey}`,
    commit: async () => {
      let error: string | undefined

      try {
        const command = await rooms.get().removeMember(url, {h}, pubkey)

        error = await command.publish().getError()
      } catch (e) {
        error = String(e)
      }

      if (error) {
        errorToast(`Could not remove ${name} from the room: ${error}`)
      }
    },
  })

  undoToast(`${name} will be removed from this room.`, () => moderationQueue.undo(id))
}
