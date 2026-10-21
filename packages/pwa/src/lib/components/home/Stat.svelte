<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** One number with its plain label, a "Why?" link and the per-item technical lens. */
  import type { WhySubject } from '$lib/why';
  import WhyButton from '../WhyButton.svelte';
  import ItemLens from '../ItemLens.svelte';

  let {
    label,
    value,
    hint,
    why,
    lens = [],
    testid,
  }: { label: string; value: string; hint?: string; why?: WhySubject; lens?: string[]; testid?: string } = $props();
</script>

<div class="rounded-xl border bg-card p-3" data-testid={testid}>
  <div class="flex items-start justify-between gap-2">
    <span class="text-xs text-muted-foreground">{label}</span>
    {#if why}<WhyButton subject={why} />{/if}
  </div>
  <p class="mt-1 text-lg font-semibold tabular-nums" data-stat-value>{value}</p>
  {#if hint}<p class="text-xs text-muted-foreground">{hint}</p>{/if}
  <ItemLens lines={lens} />
</div>
