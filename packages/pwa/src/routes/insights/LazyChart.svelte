<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** A titled LayerChart area chart, loaded on demand (d3 only ships with this screen). */
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import type { WhySubject } from '$lib/why';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    title,
    points,
    why,
    lens = [],
    testid,
  }: { title: string; points: number[]; why?: WhySubject; lens?: string[]; testid?: string } = $props();
</script>

<div class="rounded-xl border bg-card p-3" data-testid={testid}>
  <div class="mb-1 flex items-baseline justify-between gap-2">
    <h3 class="text-xs text-muted-foreground">{title}</h3>
    {#if why}<WhyButton subject={why} />{/if}
  </div>
  {#if points.length > 1}
    {#await import('$lib/components/home/DetailChart.svelte')}
      <Skeleton class="h-48 w-full" />
    {:then mod}
      {@const DetailChart = mod.default}
      <DetailChart {points} />
    {:catch}
      <p class="py-6 text-sm text-muted-foreground">{m.insights_chart_empty()}</p>
    {/await}
  {:else}
    <p class="py-6 text-sm text-muted-foreground">{m.insights_chart_empty()}</p>
  {/if}
  <ItemLens lines={lens} />
</div>
