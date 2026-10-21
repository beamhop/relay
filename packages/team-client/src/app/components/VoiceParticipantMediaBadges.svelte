<script lang="ts">
  import cx from "classnames"
  import MicrophoneOff from "@assets/icons/microphone-off.svg?dataurl"
  import VideocameraOff from "@assets/icons/videocamera-off.svg?dataurl"
  import Icon from "@lib/components/Icon.svelte"

  type Props = {
    muted: boolean
    cameraOn: boolean
    showCamera?: boolean
    size?: number
    class?: string
  }

  const {muted, cameraOn, showCamera = true, size = 3, class: className = ""}: Props = $props()

  const badgeClass =
    "inline-flex size-4 shrink-0 items-center justify-center rounded bg-surface p-0.5 text-error"
</script>

{#if muted || (showCamera && !cameraOn)}
  <div class={cx("flex items-center gap-1", className)}>
    {#if muted}
      <span class={badgeClass} aria-label="Muted">
        <Icon icon={MicrophoneOff} {size} />
      </span>
    {/if}
    {#if showCamera && !cameraOn}
      <span class={badgeClass} aria-label="Camera off">
        <Icon icon={VideocameraOff} {size} />
      </span>
    {/if}
  </div>
{/if}
