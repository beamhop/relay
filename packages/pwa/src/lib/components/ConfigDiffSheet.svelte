<script lang="ts">
  /** Plain-language diff of a proposed settings change, then apply (5-minute undo). */
  import { configFlow } from '$lib/stores/config.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { app } from '$lib/stores/app.svelte';
  import Sheet from './Sheet.svelte';
  import DiffList from './DiffList.svelte';
  import Button from './ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let open = $state(false);
  $effect(() => {
    open = !!configFlow.current;
  });
  const cur = $derived(configFlow.current);
</script>

<Sheet
  bind:open
  title={m.config_review_title()}
  description={m.config_review_desc()}
  onclose={() => configFlow.cancel()}
  testid="config-diff-sheet"
>
  {#if cur}
    <DiffList diff={cur.proposal.diff} />
    {#if prefs.lens}
      <details class="mt-3 text-xs">
        <summary class="cursor-pointer text-muted-foreground">{m.config_raw_patch()}</summary>
        <pre class="mt-2 overflow-auto rounded-lg bg-muted p-2 font-mono text-[11px]">{JSON.stringify(cur.proposal.patch, null, 2)}</pre>
      </details>
    {/if}
    {#if app.hasAction('experience.simulate-change') && app.relayId}
      <div class="mt-4 rounded-lg border p-3 text-sm">
        {#if cur.simulation}
          <p data-testid="simulation">{cur.simulation.summary}</p>
        {:else}
          <p class="text-xs text-muted-foreground">{m.config_simulate_desc()}</p>
          <Button size="sm" variant="secondary" class="mt-2" disabled={cur.simulating} onclick={() => configFlow.simulate()}>
            {cur.simulating ? m.common_working() : m.config_simulate()}
          </Button>
        {/if}
      </div>
    {/if}
    {#if cur.error}
      <p class="mt-3 text-sm text-destructive" role="alert">{cur.error.message}</p>
    {/if}
  {/if}
  {#snippet footer()}
    <div class="flex gap-2">
      <Button variant="secondary" class="flex-1" onclick={() => configFlow.cancel()}>{m.common_cancel()}</Button>
      <Button class="flex-1" data-testid="config-apply" disabled={cur?.phase === 'applying'} onclick={async () => {
        if (await configFlow.apply()) open = false;
      }}>
        {cur?.phase === 'applying' ? m.common_working() : m.config_apply()}
      </Button>
    </div>
    <p class="mt-2 text-center text-[11px] text-muted-foreground">{m.config_undo_note()}</p>
  {/snippet}
</Sheet>
