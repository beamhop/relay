<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Your week" (§7 local success metrics): minutes spent, things done and
   * time saved by suggestions, from `experience.my-stats`. Measured on the
   * server, shown only to this admin, never sent anywhere. Hidden for the rest
   * of the week once dismissed (this device).
   */
  import { onMount } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import { app } from '$lib/stores/app.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import { type MyStats, hideWeek, weekHidden } from '$lib/checklist';
  import ItemLens from '../ItemLens.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let stats = $state<MyStats | null>(null);
  let hidden = $state(true);

  onMount(async () => {
    if (!app.hasAction('experience.my-stats')) return;
    stats = await query<MyStats>('experience.my-stats');
    hidden = !stats || weekHidden(stats.thisWeek.weekStart);
  });

  function hide() {
    if (stats) hideWeek(stats.thisWeek.weekStart);
    hidden = true;
  }
</script>

{#if stats && !hidden}
  {@const w = stats.thisWeek}
  <section class="rounded-xl border bg-card p-4" data-testid="my-week" aria-labelledby="my-week-title">
    <div class="flex items-start justify-between gap-2">
      <h2 id="my-week-title" class="text-sm font-medium">{m.mystats_title()}</h2>
      <button type="button" class="-m-1 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={m.mystats_hide()} onclick={hide} data-testid="my-week-hide">
        <X class="size-4" />
      </button>
    </div>
    <ul class="mt-2 space-y-1 text-sm">
      <li class:text-warning={!stats.onTrack}>{m.mystats_minutes({ minutes: w.minutes })}</li>
      <li>{m.mystats_tasks({ count: w.tasksDone ?? w.actions })}</li>
      {#if (w.minutesSaved ?? 0) > 0}<li class="text-success">{m.mystats_saved({ minutes: w.minutesSaved ?? 0 })}</li>{/if}
    </ul>
    <p class="mt-2 text-xs text-muted-foreground">{m.mystats_goal({ minutes: stats.goalMinutes })} · {stats.privacy}</p>
    <ItemLens lines={[`experience.my-stats: sessions=${w.sessions} actions=${w.actions} approvals=${w.suggestionsApproved ?? 0}`, 'local DocStore experience.admin-time; no telemetry']} />
  </section>
{/if}
