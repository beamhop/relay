<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * In-app doctor (§14): DNS, certificate, ports, proxy, WebSocket, disk,
   * clock, storage and every health check — green/amber/red with plain text.
   * Fix buttons open the normal preview → apply flow; nothing runs by itself.
   */
  import { onMount } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import type { DoctorReport, DoctorResult, DoctorTone } from './types';

  let report = $state<DoctorReport | null>(null);
  let loading = $state(true);
  let showAll = $state(false);

  const dot: Record<DoctorTone, string> = {
    green: 'bg-success',
    amber: 'bg-warning',
    red: 'bg-destructive',
    grey: 'bg-muted-foreground/40',
  };
  const toneLabel: Record<DoctorTone, () => string> = {
    green: () => m.system_tone_ok(),
    amber: () => m.system_tone_warn(),
    red: () => m.system_tone_problem(),
    grey: () => m.system_tone_skipped(),
  };

  const problems = $derived(report?.results.filter((r) => r.tone === 'red' || r.tone === 'amber') ?? []);
  const shown = $derived(showAll ? (report?.results ?? []) : problems);

  async function run() {
    loading = true;
    report = await query<DoctorReport>('system.doctor');
    loading = false;
  }

  function fix(r: DoctorResult) {
    const def = r.fix && app.action(r.fix.actionId);
    if (def && r.fix) void flow.start(def, r.fix.input, { onDone: () => void run(), onUndo: () => void run() });
  }

  onMount(run);
</script>

<section class="rounded-xl border p-4" aria-labelledby="doctor-title" id="doctor" data-testid="doctor">
  <div class="flex items-center gap-2">
    <h2 id="doctor-title" class="flex-1 text-sm font-medium">{m.system_doctor_title()}</h2>
    <Button size="sm" variant="ghost" onclick={run} disabled={loading} aria-label={m.system_doctor_rerun()} data-testid="doctor-rerun">
      <RefreshCw class={cn('size-4', loading && 'animate-spin')} />
    </Button>
  </div>
  {#if loading && !report}
    <p class="mt-2 text-sm text-muted-foreground">{m.system_doctor_running()}</p>
  {:else if !report}
    <p class="mt-2 text-sm text-muted-foreground">{m.system_doctor_unavailable()}</p>
  {:else}
    <p class="mt-1 text-sm" data-testid="doctor-summary">
      {#if report.counts.red + report.counts.amber === 0}
        {m.system_doctor_all_good({ count: report.results.length })}
      {:else}
        {m.system_doctor_summary({ problems: report.counts.red, warnings: report.counts.amber })}
      {/if}
    </p>
    {#if !report.fullChecks}
      <p class="mt-1 text-xs text-muted-foreground">{m.system_doctor_partial()}</p>
    {/if}
    {#if shown.length}
      <ul class="mt-3 divide-y overflow-hidden rounded-lg border">
        {#each shown as r (r.id)}
          <li class="p-3" data-testid={`check-${r.id}`} data-tone={r.tone}>
            <div class="flex items-start gap-2.5">
              <span class={cn('mt-1.5 size-2.5 shrink-0 rounded-full', dot[r.tone])} aria-hidden="true"></span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium">
                  {r.title}
                  <span class="sr-only">({toneLabel[r.tone]()})</span>
                </p>
                <p class="text-sm text-muted-foreground">{r.message}</p>
                {#if r.advice}<p class="mt-1 text-xs text-muted-foreground">{r.advice}</p>{/if}
                <div class="mt-1 flex flex-wrap items-center gap-2">
                  {#if r.fix && app.hasAction(r.fix.actionId)}
                    <Button size="sm" variant="secondary" onclick={() => fix(r)} data-testid="doctor-fix">{r.fix.label}</Button>
                  {/if}
                  {#if r.source === 'health' && r.tone !== 'green'}
                    <WhyButton subject={{ subject: 'health', checkId: r.id }} />
                  {/if}
                </div>
                <ItemLens lines={r.lens} />
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    {#if report.results.length > problems.length}
      <Button size="sm" variant="link" class="mt-2 px-0" onclick={() => (showAll = !showAll)} data-testid="doctor-toggle">
        {showAll ? m.system_doctor_show_problems() : m.system_doctor_show_all({ count: report.results.length })}
      </Button>
    {/if}
  {/if}
</section>
