<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Resource advisor (§6.7, §14): machine size for today's traffic and
   * suggestions as cards. Apply opens the preview → apply → undo flow;
   * Dismiss hides a card on this device (with undo). Never applied by itself.
   */
  import { onMount } from 'svelte';
  import Cpu from '@lucide/svelte/icons/cpu';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { dismissAdvice, dismissedAdvice, restoreAdvice } from './dismissed';
  import type { Advice, AdvisorReport } from './types';

  let report = $state<AdvisorReport | null>(null);
  let loading = $state(true);
  let hidden = $state<Set<string>>(dismissedAdvice());

  const size = $derived(report?.advice.find((a) => a.id === 'machine-size') ?? null);
  const cards = $derived(report?.advice.filter((a) => a.id !== 'machine-size' && !hidden.has(a.id)) ?? []);

  async function load() {
    loading = true;
    report = await query<AdvisorReport>('system.advisor');
    loading = false;
  }

  function apply(a: Advice) {
    const def = a.apply && app.action(a.apply.actionId);
    if (def && a.apply) void flow.start(def, a.apply.input, { onDone: () => void load(), onUndo: () => void load() });
  }

  function dismiss(a: Advice) {
    hidden = dismissAdvice(a.id);
    toasts.show({
      message: m.system_advice_dismissed(),
      kind: 'info',
      undo: async () => {
        hidden = restoreAdvice(a.id);
      },
    });
  }

  onMount(load);
</script>

<section class="rounded-xl border p-4" aria-labelledby="advisor-title" id="advisor" data-testid="advisor">
  <h2 id="advisor-title" class="text-sm font-medium">{m.system_advisor_title()}</h2>
  {#if loading && !report}
    <p class="mt-2 text-sm text-muted-foreground">{m.system_loading()}</p>
  {:else if !report}
    <p class="mt-2 text-sm text-muted-foreground">{m.system_advisor_unavailable()}</p>
  {:else}
    {#if size}
      <div class="mt-2 flex items-start gap-3" data-testid="advisor-size">
        <Cpu class="mt-0.5 size-5 shrink-0 text-primary" />
        <div class="min-w-0">
          <p class="text-sm font-medium">{size.title}</p>
          <p class="text-sm text-muted-foreground">{size.body}</p>
          <ItemLens lines={size.lens} />
        </div>
      </div>
    {/if}
    {#if cards.length}
      <ul class="mt-3 space-y-2">
        {#each cards as a (a.id)}
          <li class="rounded-lg border p-3" data-testid={`advice-${a.id}`}>
            <div class="flex items-start gap-2">
              <p class="min-w-0 flex-1 text-sm font-medium">{a.title}</p>
              {#if a.severity === 'warning'}<Badge tone="warn">{m.system_advice_important()}</Badge>{/if}
            </div>
            <p class="mt-1 text-sm text-muted-foreground">{a.body}</p>
            <div class="mt-2 flex flex-wrap gap-2">
              {#if a.apply && app.hasAction(a.apply.actionId)}
                <Button size="sm" onclick={() => apply(a)} data-testid="advice-apply">{a.apply.label}</Button>
              {/if}
              <Button size="sm" variant="ghost" onclick={() => dismiss(a)} data-testid="advice-dismiss">{m.system_advice_dismiss()}</Button>
            </div>
            <ItemLens lines={a.lens} />
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-3 text-sm text-muted-foreground" data-testid="advisor-none">{m.system_advisor_none()}</p>
    {/if}
  {/if}
</section>
