<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Thumbnail of a held file: blurred until tapped. Abuse-list matches are
   * never loaded or drawn — only a shield.
   */
  import { onMount } from 'svelte';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import FileIcon from '@lucide/svelte/icons/file';
  import { query } from '$lib/stores/actions.svelte';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import { type QuarantineItem, canShowImage } from './media';

  let { item }: { item: QuarantineItem } = $props();
  let src = $state<string | null>(null);
  let revealed = $state(false);

  onMount(async () => {
    if (!canShowImage(item)) return;
    const r = await query<{ dataUrl: string }>('media.quarantine-preview', { sha256: item.sha256 });
    src = r?.dataUrl ?? null;
  });
</script>

<div class="relative size-16 shrink-0 overflow-hidden rounded-lg border bg-muted" data-testid="q-thumb">
  {#if item.abuse}
    <span class="flex h-full w-full items-center justify-center text-destructive" data-testid="q-thumb-abuse">
      <ShieldAlert class="size-6" aria-label={m.media_q_abuse_hidden()} />
    </span>
  {:else if src}
    <button
      type="button"
      class="h-full w-full"
      aria-pressed={revealed}
      aria-label={revealed ? m.media_q_hide() : m.media_q_show()}
      onclick={(e) => {
        e.stopPropagation();
        revealed = !revealed;
      }}
      data-testid="q-thumb-toggle"
    >
      <img {src} alt="" class={cn('h-full w-full object-cover transition', !revealed && 'scale-110 blur-xl')} data-revealed={revealed} />
    </button>
  {:else}
    <span class="flex h-full w-full flex-col items-center justify-center gap-0.5 text-[9px] text-muted-foreground">
      <FileIcon class="size-5" />{m.media_q_no_preview()}
    </span>
  {/if}
</div>
