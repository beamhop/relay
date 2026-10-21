// SPDX-License-Identifier: AGPL-3.0-or-later
// Which swipe actions a row offers (pure, so the rules are unit-tested). Plain labels; NIP numbers
// and kinds only in `technical`.
//
// Room messages
//   swipe right  → Reply                              (everyone, when the room allows replies)
//   swipe left   → Hide                               (everyone; only on this device)
//                  Remove                            (room admins/moderators, not on own messages;
//                                                     NIP-29 kind 9005 or NIP-86 banevent)
//                  Remove person                     (room admins, not on own messages;
//                                                     NIP-29 kind 9001)
// Inbox rows
//   swipe right  → Mark read                         (when unread)
//   swipe left   → Hide                              (until something new arrives)

import type {RowAction} from "../gestures/row-actions"

export type MessageRowCaps = {
  isOwn: boolean
  canReply: boolean
  /** "room" = NIP-29 delete-event, "space" = NIP-86 banevent, undefined = not allowed. */
  adminDelete?: "room" | "space"
  canRemoveMember: boolean
}

export type MessageRowHandlers = {
  reply: () => void
  hide: () => void
  remove: () => void
  removeMember: () => void
}

export type RowActions = {left: RowAction[]; right: RowAction[]}

export const messageRowActions = (caps: MessageRowCaps, h: MessageRowHandlers): RowActions => {
  const left: RowAction[] = []
  const right: RowAction[] = []

  if (caps.canReply) {
    left.push({id: "reply", label: "Reply", tone: "accent", run: h.reply})
  }

  right.push({
    id: "hide",
    label: "Hide",
    technical: "Hidden on this device only; nothing is published.",
    tone: "neutral",
    run: h.hide,
  })

  if (!caps.isOwn && caps.adminDelete) {
    right.push({
      id: "remove",
      label: "Remove",
      technical:
        caps.adminDelete === "room"
          ? "NIP-29 delete-event (kind 9005), sent after the undo window"
          : "NIP-86 banevent on the relay, sent after the undo window",
      tone: "critical",
      run: h.remove,
    })
  }

  if (!caps.isOwn && caps.canRemoveMember) {
    right.push({
      id: "remove-member",
      label: "Remove person",
      technical: "NIP-29 remove-user (kind 9001), sent after the undo window",
      tone: "warn",
      run: h.removeMember,
    })
  }

  return {left, right}
}

export type InboxRowCaps = {unread: boolean}

export type InboxRowHandlers = {markRead: () => void; hide: () => void}

export const inboxRowActions = (caps: InboxRowCaps, h: InboxRowHandlers): RowActions => ({
  left: caps.unread ? [{id: "mark-read", label: "Mark read", tone: "accent", run: h.markRead}] : [],
  right: [
    {
      id: "hide",
      label: "Hide",
      technical: "Hidden on this device until a newer message arrives.",
      tone: "neutral",
      run: h.hide,
    },
  ],
})
