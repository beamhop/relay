<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Pull-to-refresh for phone screens (passive touch listeners; scrolling is never blocked). */
  import type { Snippet } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { haptic } from '$lib/haptics';
  import { m } from '$lib/paraglide/messages.js';

  let { onrefresh, children }: { onrefresh: () => Promise<unknown>; children: Snippet } = $props();

  const TRIGGER = 72;
  let startY = $state<number | null>(null);
  let pull = $state(0);
  let refreshing = $state(false);
  let armed = false;

  function start(e: TouchEvent) {
    if (refreshing || window.scrollY > 0 || e.touches.length !== 1) return;
    startY = e.touches[0]?.clientY ?? null;
    armed = false;
  }
  function move(e: TouchEvent) {
    if (startY === null) return;
    const dy = (e.touches[0]?.clientY ?? startY) - startY;
    if (dy <= 0 || window.scrollY > 0) {
      pull = 0;
      return;
    }
    pull = Math.min(110, dy * 0.5);
    if (pull >= TRIGGER && !armed) {
      armed = true;
      haptic('tap');
    }
  }
  async function end() {
    if (startY === null) return;
    startY = null;
    if (pull >= TRIGGER) {
      refreshing = true;
      pull = 48;
      try {
        await onrefresh();
      } finally {
        refreshing = false;
        pull = 0;
      }
    } else pull = 0;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div ontouchstart={start} ontouchmove={move} ontouchend={end} ontouchcancel={end} class="relative">
  <div
    class="pointer-events-none absolute inset-x-0 -top-2 flex justify-center text-muted-foreground transition-opacity"
    style:opacity={pull > 8 ? 1 : 0}
    style:transform={`translateY(${pull - 32}px)`}
    aria-hidden={!refreshing}
  >
    <span class="flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs shadow">
      <RefreshCw class={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} style={`transform: rotate(${pull * 3}deg)`} />
      {refreshing ? m.common_refreshing() : pull >= TRIGGER ? m.ptr_release() : m.ptr_pull()}
    </span>
  </div>
  <div style:transform={pull ? `translateY(${pull}px)` : undefined} style:transition={startY === null ? 'transform 200ms' : 'none'}>
    {@render children()}
  </div>
</div>
