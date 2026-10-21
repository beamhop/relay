<script lang="ts">
  import type {Snippet} from "svelte"
  import type {TrustedEvent} from "@welshman/util"
  import EventMenuButton from "@app/components/EventMenuButton.svelte"
  import EventReactButtons from "@app/components/EventReactButtons.svelte"

  type Props = {
    url: string
    noun: string
    event: TrustedEvent // beamhop: no-payments (hideZap prop removed)
    customActions?: Snippet
  }

  const {url, noun, event, customActions}: Props = $props()
</script>

<!-- The compact segmented control a card footer gets. EventActionBar is the full-width
     version a detail page gets. -->
<div class="items-center join">
  <EventReactButtons {url} {event} class="button button-neutral button-xs join-item" />
  <EventMenuButton {url} {noun} {event} {customActions} class="flex join-item" />
</div>
