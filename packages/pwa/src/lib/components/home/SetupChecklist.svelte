<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** First-week checklist with a progress ring (§7); hidden once everything is done. */
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import X from '@lucide/svelte/icons/x';
  import { prefs } from '$lib/stores/prefs.svelte';
  import Rocket from '@lucide/svelte/icons/rocket';
  import { app } from '$lib/stores/app.svelte';
  import { LAUNCH_ITEMS, type ChecklistItem } from '$lib/checklist';
  import { to } from '$lib/nav';
  import { nearestTab } from '$lib/screens';
  import { announceFallback } from '$lib/fallback';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  let { items, onaction }: { items: ChecklistItem[]; onaction?: (item: ChecklistItem) => void } = $props();

  const done = $derived(items.filter((i) => i.done).length);
  const pct = $derived(items.length ? done / items.length : 1);
  const labels: Record<string, () => string> = {
    backups: () => m.checklist_backups(),
    alerts: () => m.checklist_alerts(),
    recovery: () => m.checklist_recovery(),
    landing: () => m.checklist_landing(),
    moderator: () => m.checklist_moderator(),
  };
  const R = 16;
  const C = 2 * Math.PI * R;
</script>

{#if done < items.length}
  <section class="rounded-xl border bg-card p-4" data-testid="setup-checklist" aria-labelledby="checklist-title">
    <div class="flex items-center gap-3">
      <svg width="40" height="40" viewBox="0 0 40 40" class="-rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r={R} fill="none" stroke="var(--muted)" stroke-width="4" />
        <circle cx="20" cy="20" r={R} fill="none" stroke="var(--primary)" stroke-width="4" stroke-linecap="round" stroke-dasharray={C} stroke-dashoffset={C * (1 - pct)} />
      </svg>
      <div>
        <h2 id="checklist-title" class="text-sm font-medium">{m.checklist_title()}</h2>
        <p class="text-xs text-muted-foreground">{m.checklist_progress({ done, total: items.length })}</p>
      </div>
    </div>
    <ul class="mt-3 divide-y">
      {#each items as item (item.id)}
        <li>
          <a
            href={to(item.href)}
            class="flex items-center gap-3 py-2.5 text-sm"
            data-done={item.done}
            data-state={item.state}
            data-testid={`checklist-${item.id}`}
            data-fallback={item.fallback ? '' : undefined}
            onclick={(e) => {
              if (item.action && !item.done && onaction) {
                e.preventDefault();
                onaction(item);
              } else if (item.fallback) {
                announceFallback(nearestTab(item.href));
              }
            }}
          >
            <span
              class={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border',
                item.done && 'border-success bg-success text-background',
                item.state === 'in-progress' && 'border-primary text-primary',
                item.state === 'failed' && 'border-destructive bg-destructive/15 text-destructive',
              )}
            >
              {#if item.done}<Check class="size-3" />
              {:else if item.state === 'in-progress'}<LoaderCircle class="size-3 animate-spin" aria-label={m.checklist_in_progress()} />
              {:else if item.state === 'failed'}<X class="size-3" aria-label={m.checklist_failed()} />{/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class={cn('block', item.done && 'text-muted-foreground line-through')}>{item.title ?? labels[item.id]?.() ?? item.id}</span>
              {#if item.detail && !item.done}
                <span class={cn('block text-xs', item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')} data-testid="checklist-detail">{item.detail}</span>
              {/if}
              {#if prefs.lens && item.state !== 'todo' && item.state !== 'done'}<span class="block font-mono text-[10px] text-muted-foreground" data-lens>{item.state}</span>{/if}
            </span>
            {#if !item.done}<ChevronRight class="size-4 text-muted-foreground" />{/if}
          </a>
          {#if LAUNCH_ITEMS.has(item.id) && app.hasAction('experience.launch-kit')}
            <a href={to('/launch')} class="mb-2 ml-8 inline-flex items-center gap-1 text-xs text-primary" data-testid={`checklist-launch-${item.id}`}>
              <Rocket class="size-3.5" />{m.launch_open()}
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
