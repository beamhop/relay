<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Toasts never block the app: the layer itself ignores pointer events and
   * only each toast is clickable. Phone: just above the tab bar (at the top
   * while a sheet is open, so its buttons stay reachable). Desktop: bottom-left
   * of the content column, clear of side sheets. Close with ×, or swipe away.
   * The last undo stays reachable from Settings › History.
   */
  import { fly } from 'svelte/transition';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import X from '@lucide/svelte/icons/x';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { overlays } from '$lib/stores/overlays.svelte';
  import { swipe } from '$lib/gestures/swipe';
  import { cn } from '$lib/utils';
  import WhySheet from './WhySheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let why = $state<{ title: string; detail?: string } | null>(null);
  let drag = $state<Record<number, number>>({});
  const covered = $derived(overlays.count > 0);
</script>

<div
  class={cn(
    'pointer-events-none fixed z-[60] flex flex-col gap-2 px-3',
    'inset-x-0 md:right-auto md:left-[232px] md:w-[min(420px,calc(100vw-232px))] md:px-6',
    covered
      ? 'top-[max(env(safe-area-inset-top),12px)] md:top-auto md:bottom-6'
      : 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-6',
  )}
  aria-live="polite"
  data-testid="toaster"
>
  {#each toasts.items as t (t.id)}
    <div
      role="status"
      data-testid="toast"
      class="pointer-events-auto mx-auto flex w-full max-w-md items-center gap-2 rounded-xl border bg-card py-2.5 pr-2 pl-4 text-sm shadow-xl md:mx-0"
      style:transform={drag[t.id] ? `translateX(${drag[t.id]}px)` : undefined}
      style:opacity={drag[t.id] ? Math.max(0.2, 1 - Math.abs(drag[t.id] ?? 0) / 240) : undefined}
      transition:fly={{ y: 24, duration: 180 }}
      use:swipe={{
        axis: 'x',
        directions: ['left', 'right'],
        threshold: 80,
        onmove: (s) => (drag = { ...drag, [t.id]: s.dx }),
        onswipe: () => toasts.dismiss(t.id),
        oncancel: () => (drag = { ...drag, [t.id]: 0 }),
      }}
    >
      {#if t.kind === 'success'}
        <CircleCheck class="size-4 shrink-0 text-success" />
      {:else if t.kind === 'error'}
        <CircleAlert class="size-4 shrink-0 text-destructive" />
      {:else}
        <Info class="size-4 shrink-0 text-muted-foreground" />
      {/if}
      <span class="min-w-0 flex-1">{t.message}</span>
      {#if t.kind === 'error'}
        <button class="font-medium text-primary" onclick={() => (why = { title: t.message, detail: t.detail })}>
          {m.common_why()}
        </button>
      {/if}
      {#if t.undo}
        <button
          class="rounded-md px-2 py-1 font-semibold text-primary hover:bg-muted"
          data-testid="toast-undo"
          onclick={() => toasts.undo(t.id)}
        >
          {m.common_undo()}
        </button>
      {/if}
      <button
        class="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={m.toast_close()}
        data-testid="toast-close"
        onclick={() => toasts.dismiss(t.id)}
      >
        <X class="size-3.5" />
      </button>
    </div>
  {/each}
</div>

<WhySheet bind:why />
