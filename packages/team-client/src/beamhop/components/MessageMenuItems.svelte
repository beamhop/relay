<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Desktop parity for the swipe-only message actions: "Hide" and (room admins) "Remove person"
  // as entries in the message's "More options" menu. "Remove" already has its own entry there.
  import type {TrustedEvent} from "@welshman/util"
  import {tagSpec, tagValue} from "@welshman/util"
  import EyeClosed from "@assets/icons/eye-closed.svg?dataurl"
  import UserMinus from "@assets/icons/user-minus-rounded.svg?dataurl"
  import Icon from "@lib/components/Icon.svelte"
  import {user} from "@app/core/app"
  import {profiles} from "@app/core/plugins"
  import {deriveUserIsRoomAdmin} from "@app/features/rooms"
  import {hideMessageWithUndo, removeMemberWithUndo} from "../features/swipe-commands"

  type Props = {
    url: string
    event: TrustedEvent
    onClick: () => void
  }

  const {url, event, onClick}: Props = $props()

  const h = tagValue(tagSpec("h"), event.tags) ?? ""
  const isRoomAdmin = deriveUserIsRoomAdmin(url, h)
  const display = $profiles.display(event.pubkey, [url]).$
  const isOwn = $derived(event.pubkey === $user?.pubkey)

  const hide = () => {
    onClick()
    hideMessageWithUndo(event)
  }

  const removeMember = () => {
    onClick()
    removeMemberWithUndo(url, h, event.pubkey, $display || "This person")
  }
</script>

<li>
  <button type="button" onclick={hide} title="Hidden on this device only; nothing is published.">
    <Icon size={4} icon={EyeClosed} />
    Hide Message
  </button>
</li>
{#if h && !isOwn && $isRoomAdmin}
  <li>
    <button
      type="button"
      class="text-error"
      onclick={removeMember}
      title="NIP-29 remove-user (kind 9001), sent after the undo window">
      <Icon size={4} icon={UserMinus} />
      Remove Person from Room
    </button>
  </li>
{/if}
