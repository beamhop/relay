<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Per-item technical lens (§6.6): a small toggle that reveals the
   * technical wording for one item. Always open when the app-wide lens is on.
   *
   *   <ItemLens lines={['kind 1984 (NIP-56)', 'id 3f2a…']} />
   *   <ItemLens>{#snippet details()}…{/snippet}</ItemLens>
   */
  import type { Snippet } from 'svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { lines = [], details }: { lines?: string[]; details?: Snippet } = $props();
  let local = $state(false);
  const shown = $derived(prefs.lens || local);
</script>

{#if lines.length || details}
  {#if !prefs.lens}
    <button
      type="button"
      class="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
      aria-expanded={local}
      onclick={(e) => {
        e.stopPropagation();
        local = !local;
      }}
      data-testid="item-lens">{local ? m.lens_hide() : m.item_lens_show()}</button
    >
  {/if}
  {#if shown}
    <div class="mt-1 rounded-md bg-muted px-2 py-1 font-mono text-[11px] break-all text-muted-foreground" data-testid="item-lens-details">
      {#each lines as line}<div>{line}</div>{/each}
      {#if details}{@render details()}{/if}
    </div>
  {/if}
{/if}
