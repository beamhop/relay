<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Sparkline tile (inline SVG, no chart library). Shows "—" when there is no data yet. */
  import { sparkPaths } from '$lib/sparkline';

  let {
    label,
    value,
    points,
    testid,
    onclick,
  }: { label: string; value: string; points: number[]; testid?: string; onclick?: () => void } = $props();

  const hasData = $derived(points.length > 1 && points.some((p) => p !== 0));
  const paths = $derived(sparkPaths(points, 100, 32));
</script>

<button
  type="button"
  class="flex flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/40"
  data-testid={testid}
  {onclick}
>
  <span class="text-xs text-muted-foreground">{label}</span>
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
