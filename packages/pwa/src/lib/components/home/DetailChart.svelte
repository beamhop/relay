<script lang="ts">
  /** Detail chart (LayerChart). Imported lazily: only opened tiles pay for d3. */
  import { Area, Axis, Chart, Svg } from 'layerchart';

  let { points }: { points: number[] } = $props();
  const data = $derived(points.map((v, i) => ({ i, v })));
</script>

<div class="h-48 w-full" data-testid="detail-chart">
  <Chart {data} x="i" y="v" yDomain={[0, null]} padding={{ left: 32, bottom: 20, top: 8 }}>
    <Svg>
      <Axis placement="left" grid rule ticks={4} />
      <Area class="fill-primary/15" line={{ class: 'stroke-primary stroke-2' }} />
    </Svg>
  </Chart>
</div>
