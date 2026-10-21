<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { DiffLine } from '$lib/api/types';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  let { diff }: { diff: DiffLine[] } = $props();

  const marks: Record<DiffLine['kind'], { sign: string; cls: string }> = {
    add: { sign: '+', cls: 'text-success' },
    remove: { sign: '−', cls: 'text-destructive' },
    change: { sign: '→', cls: 'text-primary' },
    info: { sign: 'i', cls: 'text-muted-foreground' },
    warning: { sign: '!', cls: 'text-warning' },
  };
</script>

{#if diff.length === 0}
  <p class="text-sm text-muted-foreground">{m.diff_empty()}</p>
{:else}
  <ul class="space-y-2" data-testid="diff">
    {#each diff as line, i (i)}
      <li class="flex gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
        <span class={cn('mt-px w-3 shrink-0 text-center font-mono font-bold', marks[line.kind].cls)} aria-hidden="true">
          {marks[line.kind].sign}
        </span>
        <div class="min-w-0">
          <p class="leading-snug">{line.text}</p>
          {#if prefs.lens && line.technical}
            <p class="mt-1 break-all font-mono text-[11px] text-muted-foreground" data-lens>{line.technical}</p>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
