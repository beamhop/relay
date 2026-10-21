<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Swipe actions on a room message (see features/swipe-actions.ts for the rules).
  import type {Snippet} from "svelte"
  import type {TrustedEvent} from "@welshman/util"
  import {tagSpec, tagValue} from "@welshman/util"
  import {user} from "@app/core/app"
  import {profiles} from "@app/core/plugins"
  import {deriveUserAdminDelete, deriveUserIsRoomAdmin} from "@app/features/rooms"
  import SwipeRow from "./SwipeRow.svelte"
  import {messageRowActions} from "../features/swipe-actions"
  import {
    hideMessageWithUndo,
    removeMemberWithUndo,
    removeMessageWithUndo,
  } from "../features/swipe-commands"

  type Props = {
    url: string
    event: TrustedEvent
    replyTo?: (event: TrustedEvent) => void
    children: Snippet
  }

  const {url, event, replyTo, children}: Props = $props()

  const h = tagValue(tagSpec("h"), event.tags) ?? ""
  const adminDelete = deriveUserAdminDelete(url, event)
  const isRoomAdmin = deriveUserIsRoomAdmin(url, h)
  const display = $profiles.display(event.pubkey, [url]).$

  const actions = $derived(
    messageRowActions(
      {
        isOwn: event.pubkey === $user?.pubkey,
        canReply: Boolean(replyTo),
        adminDelete: $adminDelete as "room" | "space" | undefined,
        canRemoveMember: Boolean(h) && $isRoomAdmin,
      },
      {
        reply: () => replyTo?.(event),
        hide: () => hideMessageWithUndo(event),
        remove: () => removeMessageWithUndo(url, event),
        removeMember: () => removeMemberWithUndo(url, h, event.pubkey, $display || "This person"),
      },
    ),
  )
</script>

<SwipeRow left={actions.left} right={actions.right}>
  {@render children()}
</SwipeRow>
