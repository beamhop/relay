<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Shown above the composer of a room whose outbound relays are restricted (PLAN §12.10). -->
<script lang="ts">
  import {deriveGroupOutbound} from "../features/outbound"

  type Props = {
    h: string
  }

  const {h}: Props = $props()

  const allowed = deriveGroupOutbound(h)

  let open = $state(false)
</script>

{#if $allowed}
  <div role="note" class="px-3 pt-1 text-xs text-content-muted" data-testid="group-relay-notice">
    <span>Messages here stay on your company's relays.</span>
    <button type="button" class="underline" aria-expanded={open} onclick={() => (open = !open)}>
      {open ? "Hide details" : "Details"}
    </button>
    {#if open}
      <div class="mt-1 font-mono">
        NIP-29 group <code>{h}</code> publishes only to:
        <ul class="ml-4 list-disc">
          {#each $allowed as relay (relay)}
            <li>{relay}</li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}
