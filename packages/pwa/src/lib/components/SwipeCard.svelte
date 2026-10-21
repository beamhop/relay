<script lang="ts">
  /** A card you can swipe off the stack (Tinder-style triage, §6.2). */
  import type { Snippet } from 'svelte';
  import { swipe } from '$lib/gestures/swipe';
  import type { Axis, Direction } from '$lib/gestures/recognizer';
  import { haptic } from '$lib/haptics';
  import { cn } from '$lib/utils';

  let {
    directions,
    hints = {},
    onswipe,
    children,
    disabled = false,
    testid,
    class: klass = '',
  }: {
    directions: Direction[];
    hints?: Partial<Record<Direction, { label: string; tone: 'ok' | 'warn' | 'critical' | 'neutral' }>>;
    onswipe: (d: Direction) => void;
    children: Snippet;
    disabled?: boolean;
    testid?: string;
    class?: string;
  } = $props();

  let dx = $state(0);
  let dy = $state(0);
  let active = $state<Direction | null>(null);
  let progress = $state(0);
  let leaving = $state(false);
  let dragging = $state(false);

  const axis = $derived<Axis>(
    directions.some((d) => d === 'up' || d === 'down') && directions.some((d) => d === 'left' || d === 'right')
      ? 'both'
      : directions.some((d) => d === 'up' || d === 'down')
        ? 'y'
        : 'x',
  );

  const tones = {
    ok: 'bg-success text-background',
    warn: 'bg-warning text-background',
    critical: 'bg-destructive text-destructive-foreground',
    neutral: 'bg-muted-foreground text-background',
  };

  function reset() {
    dx = 0;
    dy = 0;
    active = null;
    progress = 0;
    dragging = false;
  }

  /** Programmatic commit (buttons, keyboard): animate out, then report. */
  export function fling(d: Direction) {
    if (leaving) return;
    leaving = true;
    haptic('swipe');
    const far = typeof window === 'undefined' ? 600 : window.innerWidth;
    dx = d === 'left' ? -far : d === 'right' ? far : 0;
    dy = d === 'up' ? -far : d === 'down' ? far : 0;
    setTimeout(() => {
      onswipe(d);
      leaving = false;
      reset();
    }, 180);
  }
</script>

<div
  class={cn('relative select-none', klass)}
  data-testid={testid}
  data-swipe-card
  style:transform={`translate(${dx}px, ${dy}px) rotate(${axis === 'y' ? 0 : dx / 24}deg)`}
  style:transition={dragging ? 'none' : 'transform 180ms ease-out'}
  use:swipe={{
    axis,
    directions,
    disabled: disabled || leaving,
    threshold: 90,
    onmove: (s) => {
      dragging = true;
      dx = s.dx;
      dy = s.dy;
      active = s.direction;
      progress = s.progress;
    },
    onswipe: (d) => {
      dragging = false;
      fling(d);
    },
    oncancel: reset,
  }}
>
  {@render children()}
  {#if active && hints[active] && progress > 0.15}
    {@const h = hints[active]!}
    <div
      class={cn(
        'pointer-events-none absolute top-4 rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wide shadow',
        tones[h.tone],
        active === 'right' ? 'left-4' : active === 'left' ? 'right-4' : 'left-1/2 -translate-x-1/2',
      )}
      style:opacity={Math.min(1, progress * 1.3)}
      data-swipe-hint={active}
    >
      {h.label}
    </div>
  {/if}
</div>
