<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Relay switcher (§6.1), shown only when the node hosts more than one virtual relay. */
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import { app } from '$lib/stores/app.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

{#if app.relays.length > 1}
  <label class="relative flex items-center gap-1 rounded-lg border bg-card px-2 py-1 text-sm" data-testid="relay-switcher">
    <span class="sr-only">{m.relay_switch()}</span>
    <select
      class="appearance-none bg-transparent pr-5 font-medium outline-none"
      value={app.relayId}
      onchange={(e) => app.setRelay(e.currentTarget.value)}
    >
      {#each app.relays as r (r.id)}
        <option value={r.id}>{r.name || r.id}</option>
      {/each}
    </select>
    <ChevronsUpDown class="pointer-events-none absolute right-1.5 size-3.5 text-muted-foreground" />
  </label>
{/if}
