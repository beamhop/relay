<script lang="ts">
  import type {TrustedEvent} from "@welshman/util"
  import SmileCircle from "@assets/icons/smile-circle.svg?dataurl"
  import Icon from "@lib/components/Icon.svelte"
  import EmojiButton from "@lib/components/EmojiButton.svelte"
  import {publishReaction} from "@app/features/reactions"

  type Props = {
    url: string
    event: TrustedEvent // beamhop: no-payments (no zap button)
    class?: string
  }

  const {url, event, class: className = ""}: Props = $props()

  const onEmoji = (emoji: string) => publishReaction(event, {content: emoji, tags: []}, {url})
</script>

<EmojiButton {onEmoji} aria-label="Add a reaction" data-tip="React" class={className}>
  <Icon icon={SmileCircle} size={4} />
</EmojiButton>
