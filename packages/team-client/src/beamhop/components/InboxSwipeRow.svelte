<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Swipe actions on an inbox row: right = mark read, left = hide until something new arrives.
  // Mouse users get the same two actions as hover buttons.
  import type {Snippet} from "svelte"
  import type {TrustedEvent} from "@welshman/util"
  import {notifications} from "@app/ui/notifications"
  import SwipeRow from "./SwipeRow.svelte"
  import {inboxRowActions} from "../features/swipe-actions"
  import {hideInboxRowWithUndo, markReadWithUndo} from "../features/swipe-commands"

  type Props = {
    path: string
    event: TrustedEvent
    children: Snippet
  }

  const {path, event, children}: Props = $props()

  const actions = $derived(
    inboxRowActions(
      {unread: $notifications.has(path)},
      {
        markRead: () => markReadWithUndo(path),
        hide: () => hideInboxRowWithUndo(path, event),
      },
    ),
  )
</script>

<SwipeRow left={actions.left} right={actions.right} hoverBar>
  {@render children()}
</SwipeRow>
