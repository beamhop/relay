<script lang="ts">
  /** Sparkline tile (LayerChart). Shows "—" when there is no data yet. */
  import { Area, Chart, Svg } from 'layerchart';

  let {
    label,
    value,
    points,
    testid,
    onclick,
  }: { label: string; value: string; points: number[]; testid?: string; onclick?: () => void } = $props();

  const data = $derived(points.map((v, i) => ({ i, v })));
  const hasData = $derived(points.length > 1 && points.some((p) => p !== 0));
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
      <Chart {data} x="i" y="v" yDomain={[0, null]} padding={{ top: 2, bottom: 1 }}>
        <Svg>
          <Area class="fill-primary/15" line={{ class: 'stroke-primary stroke-[1.5]' }} />
        </Svg>
      </Chart>
    {:else}
      <div class="mt-4 h-px w-full bg-border"></div>
    {/if}
  </div>
</button>
