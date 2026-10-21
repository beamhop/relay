<script lang="ts" generics="T">
  /** Fixed-row-height virtual list: only the visible rows (plus overscan) are rendered. */
  import type { Snippet } from 'svelte';

  let {
    items,
    rowHeight = 56,
    overscan = 8,
    height = '60dvh',
    key,
    row,
    testid,
  }: {
    items: T[];
    rowHeight?: number;
    overscan?: number;
    height?: string;
    key: (item: T) => string | number;
    row: Snippet<[T, number]>;
    testid?: string;
  } = $props();

  let scrollTop = $state(0);
  let viewport = $state(600);

  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = $derived(Math.min(items.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan));
  const visible = $derived(items.slice(start, end));
</script>

<div
  class="relative overflow-y-auto overscroll-contain"
  style:height
  bind:clientHeight={viewport}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
  data-testid={testid}
  role="list"
>
  <div style:height={`${items.length * rowHeight}px`} class="relative">
    {#each visible as item, i (key(item))}
      <div
        role="listitem"
        class="absolute inset-x-0"
        style:top={`${(start + i) * rowHeight}px`}
        style:height={`${rowHeight}px`}
      >
        {@render row(item, start + i)}
      </div>
    {/each}
  </div>
</div>
