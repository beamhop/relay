<script lang="ts" module>
  export interface RowAction {
    id: string;
    label: string;
    tone: 'critical' | 'warn' | 'accent' | 'neutral';
    run: () => void;
  }

</script>

<script lang="ts">
  /** iOS Mail-style row: swipe to reveal actions (§6.2). Buttons stay reachable by keyboard. */
  import type { Snippet } from 'svelte';
  import { swipe } from '$lib/gestures/swipe';
  import { haptic } from '$lib/haptics';
  import { cn } from '$lib/utils';

  let {
    left = [],
    right = [],
    children,
    testid,
  }: { left?: RowAction[]; right?: RowAction[]; children: Snippet; testid?: string } = $props();

  const W = 76;
  let dx = $state(0);
  let open = $state<'left' | 'right' | null>(null);
  let dragging = $state(false);

  const base = $derived(open === 'left' ? -W * right.length : open === 'right' ? W * left.length : 0);
  const directions = $derived([...(right.length ? (['left'] as const) : []), ...(left.length ? (['right'] as const) : [])]);
  const tones = {
    critical: 'bg-destructive text-destructive-foreground',
    warn: 'bg-warning text-background',
    accent: 'bg-primary text-primary-foreground',
    neutral: 'bg-muted-foreground text-background',
  };

  function run(a: RowAction) {
    open = null;
    dx = 0;
    haptic('tap');
    a.run();
  }
</script>

<div class="relative overflow-hidden" data-testid={testid}>
  {#if left.length}
    <div class="absolute inset-y-0 left-0 flex" aria-hidden={open !== 'right'}>
      {#each left as a (a.id)}
        <button class={cn('h-full text-xs font-medium', tones[a.tone])} style:width={`${W}px`} tabindex={open === 'right' ? 0 : -1} onclick={() => run(a)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
  {#if right.length}
    <div class="absolute inset-y-0 right-0 flex" aria-hidden={open !== 'left'} data-row-actions>
      {#each right as a (a.id)}
        <button
          class={cn('h-full text-xs font-medium', tones[a.tone])}
          style:width={`${W}px`}
          tabindex={open === 'left' ? 0 : -1}
          data-row-action={a.id}
          onclick={() => run(a)}
        >
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
  <div
    class="relative bg-background"
    style:transform={`translateX(${base + dx}px)`}
    style:transition={dragging ? 'none' : 'transform 180ms ease-out'}
    use:swipe={{
      axis: 'x',
      directions: [...directions],
      threshold: 48,
      onmove: (s) => {
        dragging = true;
        dx = s.dx;
      },
      onswipe: (d) => {
        dragging = false;
        dx = 0;
        if (open) open = null;
        else open = d === 'left' ? 'left' : 'right';
        haptic('swipe');
      },
      oncancel: () => {
        dragging = false;
        dx = 0;
      },
    }}
  >
    {@render children()}
  </div>
</div>
