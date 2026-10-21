<script lang="ts">
  import type {ComponentProps} from "svelte"
  import {EVENT_TIME, THREAD, CLASSIFIED, LONG_FORM, POLL, PINBOARD, PIN} from "@welshman/util"
  import NoteContentMinimalEventTime from "@app/components/NoteContentMinimalEventTime.svelte"
  import NoteContentMinimalThread from "@app/components/NoteContentMinimalThread.svelte"
  import NoteContentMinimalClassified from "@app/components/NoteContentMinimalClassified.svelte"
  import NoteContentMinimalArticle from "@app/components/NoteContentMinimalArticle.svelte"
  import NoteContentMinimalPoll from "@app/components/NoteContentMinimalPoll.svelte"
  import NoteContentMinimalBoard from "@app/components/NoteContentMinimalBoard.svelte"
  import NoteContentMinimalPin from "@app/components/NoteContentMinimalPin.svelte"
  import ContentMinimal from "@app/components/ContentMinimal.svelte"

  const props: ComponentProps<typeof ContentMinimal> = $props()
</script>

<div class="text-xs">
  {#if props.event.kind === EVENT_TIME}
    <NoteContentMinimalEventTime {...props} />
  {:else if props.event.kind === THREAD}
    <NoteContentMinimalThread {...props} />
  {:else if props.event.kind === CLASSIFIED}
    <NoteContentMinimalClassified {...props} />
  {:else if props.event.kind === LONG_FORM}
    <NoteContentMinimalArticle {...props} />
  {:else if props.event.kind === POLL}
    <NoteContentMinimalPoll {...props} />
  {:else if props.event.kind === PINBOARD}
    <NoteContentMinimalBoard {...props} />
  {:else if props.event.kind === PIN}
    <NoteContentMinimalPin {...props} />
  {:else}
    <!-- beamhop: no-payments (zap goals, requests and receipts fall through to plain content) -->
    <ContentMinimal {...props} />
  {/if}
</div>
