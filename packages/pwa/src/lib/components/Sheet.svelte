<script lang="ts">
  /**
   * Bottom sheet (phone) / side panel (desktop). Drag the handle down to
   * dismiss; Escape and the backdrop close it too.
   */
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import X from '@lucide/svelte/icons/x';
  import { swipe } from '$lib/gestures/swipe';
  import { isDesktop } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    title,
    description,
    onclose,
    children,
    footer,
    testid,
  }: {
    open?: boolean;
    title?: string;
    description?: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
    testid?: string;
  } = $props();

  let dy = $state(0);
  let dragging = $state(false);
  const desktop = isDesktop();
  const titleId = `sheet-${Math.random().toString(36).slice(2, 8)}`;
  let panel: HTMLElement | undefined = $state();

  function close() {
    open = false;
    dy = 0;
    onclose?.();
  }

  function onkeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  $effect(() => {
    if (open && panel) {
      const first = panel.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-sheet-close])');
      first?.focus({ preventScroll: true });
    }
  });
</script>

<svelte:window {onkeydown} />

{#if open}
  <div class="fixed inset-0 z-50">
    <button
      type="button"
      tabindex="-1"
      aria-label={m.common_close()}
      class="absolute inset-0 h-full w-full cursor-default bg-black/55 backdrop-blur-[2px]"
      onclick={close}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      bind:this={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      data-testid={testid}
      class="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-2xl border-t bg-card text-card-foreground shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[460px] md:rounded-none md:border-l md:border-t-0"
      style:transform={dy ? `translateY(${dy}px)` : undefined}
      style:transition={dragging ? 'none' : 'transform 200ms ease'}
      transition:fly={desktop ? { x: 460, duration: 220 } : { y: 500, duration: 240 }}
    >
      <div
        class="shrink-0 cursor-grab px-4 pt-2 active:cursor-grabbing"
        use:swipe={{
          axis: 'y',
          directions: ['down'],
          threshold: 90,
          onmove: (s) => {
            dragging = true;
            dy = Math.max(0, s.dy);
          },
          onswipe: () => {
            dragging = false;
            close();
          },
          oncancel: () => {
            dragging = false;
            dy = 0;
          },
        }}
      >
        <div class="mx-auto mb-2 h-1.5 w-10 rounded-full bg-muted-foreground/30 md:hidden" data-sheet-handle></div>
        <div class="flex items-start gap-3 pb-2">
          <div class="min-w-0 flex-1">
            {#if title}<h2 id={titleId} class="text-base font-semibold leading-tight">{title}</h2>{/if}
            {#if description}<p class="mt-1 text-sm text-muted-foreground">{description}</p>{/if}
          </div>
          <button
            type="button"
            data-sheet-close
            class="-mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label={m.common_close()}
            onclick={close}
          >
            <X class="size-4" />
          </button>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {@render children?.()}
      </div>
      {#if footer}
        <div class="shrink-0 border-t px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
