<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Storage tiers (§4.2, §6.1): main + cheaper storage bars, the mover's last/next run, "Move now". */
  import { onMount } from 'svelte';
  import QuotaBar from '$lib/components/people/QuotaBar.svelte';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import { ago, cn, formatBytes } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import { type StorageTiers, tierLevel, tierQuota, until } from './media';

  let data = $state<StorageTiers | null>(null);

  async function load() {
    data = await query<StorageTiers>('media.storage-tiers');
  }
  onMount(load);

  function moveNow() {
    const def = app.action('media.run-tiering');
    if (def) void flow.start(def, {}, { onDone: () => void load() });
  }

  const label = (tier: string) => (tier === 'cold' ? m.media_tier_cold() : m.media_tier_hot());
  const next = $derived(data?.job.nextRun ? until(data.job.nextRun) : null);
</script>

{#if data}
  <section class="mb-4 rounded-xl border p-3" data-testid="storage-tiers">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 class="text-sm font-medium">{m.media_tiers_title()}</h2>
      <WhyButton subject={{ subject: 'metric', metric: 'storage.hot', value: data.tiers[0]?.usedBytes ?? undefined }} />
    </div>
    {#if data.error}
      <p class="mb-2 text-sm text-destructive" data-testid="tiers-error">{m.media_tiers_error()}</p>
    {/if}
    <ul class="space-y-3">
      {#each data.tiers as t (t.tier)}
        {@const q = tierQuota(t)}
        <li data-testid="tier-{t.tier}" data-level={tierLevel(t.fraction)}>
          <div class="flex items-baseline justify-between gap-2 text-sm">
            <span>{label(t.tier)}</span>
            <span class="text-xs text-muted-foreground">
              {#if t.count !== null}{m.media_tier_files({ count: t.count })}{/if}
            </span>
          </div>
          {#if q}
            <QuotaBar {q} compact />
          {:else}
            <p class={cn('text-xs text-muted-foreground')}>
              {t.usedBytes !== null ? m.media_tier_used({ used: formatBytes(t.usedBytes) }) : m.media_tier_counting()}
            </p>
          {/if}
          <ItemLens lines={[t.technical]} />
        </li>
      {/each}
    </ul>
    <div class="mt-3 space-y-1 text-xs text-muted-foreground" data-testid="tiers-job">
      {#if data.enabled && data.afterDays !== null}
        <p>{m.media_tiers_rule({ days: data.afterDays })}</p>
        <p>
          {data.job.lastRun
            ? m.media_tiers_last_run({ when: ago(data.job.lastRun), count: data.job.moved, size: formatBytes(data.job.movedBytes) })
            : m.media_tiers_never()}
          {#if data.job.failed}<span class="text-destructive"> · {m.media_tiers_failed({ count: data.job.failed })}</span>{/if}
        </p>
        <p>{m.media_tiers_next({ when: next ? m.media_in({ when: next }) : m.media_soon() })}</p>
      {:else}
        <p data-testid="tiers-off">{m.media_tiers_off()}</p>
      {/if}
    </div>
    {#if data.enabled && app.hasAction('media.run-tiering') && app.can('media.write', false)}
      <Button size="sm" variant="secondary" class="mt-3" onclick={moveNow} data-testid="tiers-move-now">{m.media_tiers_move_now()}</Button>
    {/if}
  </section>
{/if}
