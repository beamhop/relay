<script lang="ts">
  import { fly } from 'svelte/transition';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import { toasts } from '$lib/stores/toasts.svelte';
  import WhySheet from './WhySheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let why = $state<{ title: string; detail?: string } | null>(null);
</script>

<div
  class="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-3 md:bottom-6 md:items-end md:px-6"
  aria-live="polite"
>
  {#each toasts.items as t (t.id)}
    <div
      role="status"
      data-testid="toast"
      class="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-xl"
      transition:fly={{ y: 24, duration: 180 }}
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
    </div>
  {/each}
</div>

<WhySheet bind:why />
