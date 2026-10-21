<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Sparkline tile (inline SVG, no chart library). Shows "—" when there is no
   * data yet. `why` adds a "Why?" link for the number (§6.10); it sits next
   * to the tile's own button, never inside it.
   */
  import { sparkPaths } from '$lib/sparkline';
  import type { WhySubject } from '$lib/why';
  import WhyButton from '../WhyButton.svelte';

  let {
    label,
    value,
    points,
    testid,
    onclick,
    why,
  }: {
    label: string;
    value: string;
    points: number[];
    testid?: string;
    onclick?: () => void;
    why?: WhySubject;
  } = $props();

  const hasData = $derived(points.length > 1 && points.some((p) => p !== 0));
  const paths = $derived(sparkPaths(points, 100, 32));
</script>

<div class="relative rounded-xl border bg-card transition-colors hover:bg-muted/40">
  <button type="button" class="flex w-full flex-col gap-2 p-3 text-left" data-testid={testid} {onclick}>
    <span class="pr-10 text-xs text-muted-foreground">{label}</span>
    <span class="text-lg font-semibold tabular-nums">{value}</span>
    <div class="h-8 w-full" aria-hidden="true">
      {#if hasData}
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" class="h-full w-full overflow-visible" data-sparkline>
          <path d={paths.area} class="fill-primary/15" />
          <path d={paths.line} fill="none" class="stroke-primary" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        </svg>
      {:else}
        <div class="mt-4 h-px w-full bg-border"></div>
      {/if}
    </div>
  </button>
  {#if why}
    <div class="absolute right-2 top-2"><WhyButton subject={why} /></div>
  {/if}
</div>
